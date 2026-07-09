import { Entry } from '@napi-rs/keyring'
import { z } from 'zod'
import { calculateChecksum } from './utils.js'

const CURRENT_SCHEMA_VERSION = 2

const KEYRING_SERVICE_NAME = 'aws-ssm-secrets'
const LEGACY_KEYRING_USER_NAME = 'aws-ssm-secrets'
const CURRENT_KEYRING_USER_NAME = `aws-ssm-secrets/v${CURRENT_SCHEMA_VERSION}`
const ADD_CREDENTIALS_CMD = 'ssm-secrets auth'

/**
 * Safe chunk size for platforms which have limit on keyring entries,
 * mainly Windows (5 * 512 bytes). We also add some margin to be safe.
 * @see CredentialBlobSize https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw#CredentialBlobSize
 */
const CHUNK_SIZE_SAFE_LIMIT_BYTES = 2048

/**
 * Platform size limit error.
 * @see https://github.com/open-source-cooperative/keyring-core/blob/eb41b5cd54694c1622d3c30c59f2e87368463151/src/error.rs#L91-L94
 */
const PLATFORM_LIMIT_ERROR_RE = /Value of '.+' is longer than the platform limit of \d+ chars/u

const legacyCredentialsSchema = z.object({
  accessKeyId: z.string().nonempty(), region: z.string().nonempty(), secretAccessKey: z.string().nonempty(),
})

const legacySchemaToV2 = legacyCredentialsSchema.transform(credentials => ({
  mode: 'static' as const,
  ...credentials,
}))

const staticCredentialsSchema = legacyCredentialsSchema.extend({
  mode: z.literal('static'),
})

const ssoCredentialsSchema = z.object({
  mode: z.literal('sso'),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.number().optional(),
  accountId: z.string().nonempty(),
  allowBrowserRefresh: z.boolean(),
  clientId: z.string().nonempty(),
  clientSecret: z.string().nonempty(),
  clientSecretExpiresAt: z.number(),
  refreshToken: z.string().optional(),
  region: z.string().nonempty(),
  roleName: z.string().nonempty(),
  startUrl: z.string().nonempty(),
  stsCredentials: z.object({
    accessKeyId: z.string().nonempty(),
    expiresAt: z.number(),
    secretAccessKey: z.string().nonempty(),
    sessionToken: z.string().nonempty(),
  }).optional(),
})

/**
* This schema wraps around other credentials
* by splitting JSON into raw chunks.
* This enables support for OSes where keyring limit is too low,
* such as Windows.
*/
const chunkedCredentialsSchema = z.object({
  mode: z.literal('chunked'),
  chunkCount: z.int().positive(),
  checksum: z.string(),
})

/**
 * Schema for future compatibility with newer versions.
 * This is here to show cleaner errors when an older version
 * tries to read credentials written with the newer schema.
 */
const futureCompatibilitySchema = z.object({ mode: z.string() })

/** Shape of credentials stored in the main entry */
const rawStoredCredentialsSchema = z.discriminatedUnion('mode', [staticCredentialsSchema, ssoCredentialsSchema, chunkedCredentialsSchema])

/** Shape of actually usable credentials */
const storedCredentialsSchema = z.discriminatedUnion('mode', [staticCredentialsSchema, ssoCredentialsSchema])

export type StaticCredentials = z.infer<typeof staticCredentialsSchema>
export type SsoCredentials = z.infer<typeof ssoCredentialsSchema>
export type ChunkedCredentials = z.infer<typeof chunkedCredentialsSchema>
export type StoredCredentials = z.infer<typeof storedCredentialsSchema>
type LegacyCredentials = z.infer<typeof legacyCredentialsSchema>

/**
 * Gets credentials from the OS keyring.
 */
export function getCredentials(): Promise<StoredCredentials> {
  const currentCredentialsJson = getCurrentEntry().getPassword()
  if (currentCredentialsJson) {
    return parseCurrentCredentials(currentCredentialsJson, true)
  }

  const legacyCredentialsJson = getLegacyEntry().getPassword()
  if (!legacyCredentialsJson) {
    throw new Error(`No credentials in keyring. Run \`${ADD_CREDENTIALS_CMD}\` first.`)
  }

  return Promise.resolve(parseLegacyCredentials(legacyCredentialsJson))
}

function parseCurrentCredentials(jsonString: string, allowChunked: boolean): Promise<StoredCredentials> {
  const parentEntry: unknown = JSON.parse(jsonString)

  const credentialsParseResult = rawStoredCredentialsSchema.safeParse(parentEntry)
  if (!credentialsParseResult.success) {
    const futureCompatibility = futureCompatibilitySchema.safeParse(parentEntry)
    if (futureCompatibility.success) {
      throw new Error(
        `Saved credentials are not supported by this version of ssm-secrets. Update the utility to support mode: ${futureCompatibility.data.mode}`
      )
    }

    throw new Error(`Credentials have invalid format. Run \`${ADD_CREDENTIALS_CMD}\` to refresh them.`)
  }

  const credentials = credentialsParseResult.data

  if (credentials.mode === 'chunked' && allowChunked) {
    return readChunkedCredentials(credentials)
  } else if (credentials.mode === 'chunked') {
    throw new Error('Unexpected recursion while parsing chunked credentials')
  }

  return Promise.resolve(credentials)
}

function parseLegacyCredentials(credentialsJson: string): StoredCredentials {
  const credentials = legacySchemaToV2.safeParse(JSON.parse(credentialsJson))
  if (!credentials.success) {
    throw new Error(`Credentials have invalid format. Run \`${ADD_CREDENTIALS_CMD}\` to refresh them.`)
  }

  return credentials.data
}

async function readChunkedCredentials(parentEntry: ChunkedCredentials): Promise<StoredCredentials> {
  const chunkCount = parentEntry.chunkCount
  const chunks: string[] = []

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const contents = getChunkEntry(chunkIndex).getPassword()
    if (!contents) {
      throw new Error(`Chunked storage: could not find keyring chunk ${chunkIndex}`)
    }
    chunks.push(contents)
  }

  const full = chunks.join('')

  // Verify checksum
  const expectedChecksum = parentEntry.checksum
  const actualChecksum = await calculateChecksum(full)
  if (expectedChecksum !== actualChecksum) {
    throw new Error('Chunked storage: checksum mismatch')
  }

  return parseCurrentCredentials(full, false)
}

/**
 * Writes credentials into the OS keyring.
 */
export async function writeCredentials(credentials: StoredCredentials) {
  const validatedCredentials = storedCredentialsSchema.safeParse(credentials)
  if (!validatedCredentials.success) {
    throw new Error('Credentials have invalid format.')
  }

  const credentialsToWrite = JSON.stringify(validatedCredentials.data)

  // Some OS (e.g. Windows) have platform size limits,
  // chunk the writes in such cases
  const utf16SizeInBytes = getApproximateUtf16SizeInBytes(credentialsToWrite)
  if (process.platform === 'win32' && utf16SizeInBytes > CHUNK_SIZE_SAFE_LIMIT_BYTES) {
    await saveToChunks(credentialsToWrite)
  } else try {
    getCurrentEntry().setPassword(credentialsToWrite)
  } catch (e: unknown) {
    // Try saving as chunks when platform size limit was reached
    if (e instanceof Error && PLATFORM_LIMIT_ERROR_RE.test(e.message)) {
      await saveToChunks(credentialsToWrite)
    } else if (e instanceof Error) {
      throw e
    } else {
      throw new TypeError('Unknown error while writing credentials', { cause: e })
    }
  }

  // Write static credentials to legacy storage as well for compatibility purposes
  if (validatedCredentials.data.mode === 'static') {
    writeLegacyCredentials(validatedCredentials.data)
  }
}

/**
 * Deletes credentials from the OS keyring.
 */
export function deleteCredentials(): boolean {
  const currentDeleted = getCurrentEntry().deletePassword()
  const legacyDeleted = getLegacyEntry().deletePassword()
  return currentDeleted || legacyDeleted
}

function writeLegacyCredentials(credentials: LegacyCredentials) {
  const legacyCredentials = legacyCredentialsSchema.parse(credentials)
  getLegacyEntry().setPassword(JSON.stringify(legacyCredentials))
}

async function saveToChunks(initial: string): Promise<void> {
  let chunkCount = 0

  let remaining = initial
  while (remaining.length > 0) {
    // Since UTF-16 bytes is twice the length of ASCII characters
    const lengthToTake = CHUNK_SIZE_SAFE_LIMIT_BYTES / 2
    const chunk = remaining.slice(0, lengthToTake)
    getChunkEntry(chunkCount).setPassword(chunk)

    chunkCount++
    remaining = remaining.slice(lengthToTake)
  }

  // Compute checksum and replace the parent credentials
  const checksum = await calculateChecksum(initial)
  const chunkedCredentials: ChunkedCredentials = {
    mode: 'chunked',
    checksum,
    chunkCount,
  }

  const newParentEntry = JSON.stringify(chunkedCredentials)
  getCurrentEntry().setPassword(newParentEntry)
}

function getChunkEntry(index: number): Entry {
  return new Entry(
    KEYRING_SERVICE_NAME,
    `${CURRENT_KEYRING_USER_NAME}/chunk/${index}`
  )
}

function getCurrentEntry(): Entry {
  return new Entry(KEYRING_SERVICE_NAME, CURRENT_KEYRING_USER_NAME)
}

function getLegacyEntry(): Entry {
  return new Entry(KEYRING_SERVICE_NAME, LEGACY_KEYRING_USER_NAME)
}

/** 
 * JS Strings are basically UTF-16, so to get the size in bytes we multiply the length by 2
 * as our entries are mostly ASCII (1 byte).
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String#utf-16_characters_unicode_code_points_and_grapheme_clusters
 */
function getApproximateUtf16SizeInBytes(value: string): number {
  return value.length * 2
}
