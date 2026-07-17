import { AsyncEntry, Entry } from '@napi-rs/keyring'
import { z } from 'zod'
import { calculateChecksum } from './utils.js'

export enum StorageMode {
  Static = 'static',
  SSO = 'sso',
  Chunked = 'chunked',
}

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
 * Max number of chunks to store in the keyring,
 * the number here is an arbitrary limit.
 * The typical chunkCount for SSO mode is 4-7.
 */
const CHUNK_MAX_COUNT = 16

/**
 * Platform size limit error.
 * @see https://github.com/open-source-cooperative/keyring-core/blob/eb41b5cd54694c1622d3c30c59f2e87368463151/src/error.rs#L91-L94
 */
const PLATFORM_LIMIT_ERROR_RE = /Value of '.+' is longer than the platform limit of \d+ chars/u

const legacyCredentialsSchema = z.object({
  accessKeyId: z.string().nonempty(), region: z.string().nonempty(), secretAccessKey: z.string().nonempty(),
})

const legacySchemaToV2 = legacyCredentialsSchema.transform(credentials => ({
  mode: StorageMode.Static as const,
  ...credentials,
}))

const staticCredentialsSchema = legacyCredentialsSchema.extend({
  mode: z.literal(StorageMode.Static),
})

const ssoCredentialsSchema = z.object({
  mode: z.literal(StorageMode.SSO),
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
  mode: z.literal(StorageMode.Chunked),
  chunkCount: z.int().positive().max(CHUNK_MAX_COUNT),
  chunkId: z.string().min(1),
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
    if (futureCompatibility.success && !(Object.values(StorageMode) as string[]).includes(futureCompatibility.data.mode)) {
      throw new Error(
        `Saved credentials are not supported by this version of ssm-secrets. Update the utility to support mode: ${futureCompatibility.data.mode}`,
      )
    }

    throw new Error(`Credentials have invalid format. Run \`${ADD_CREDENTIALS_CMD}\` to refresh them.`)
  }

  const credentials = credentialsParseResult.data

  if (credentials.mode === StorageMode.Chunked && allowChunked) {
    return readChunkedCredentials(credentials)
  }
  else if (credentials.mode === StorageMode.Chunked) {
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
    const contents = getChunkEntry(parentEntry.chunkId, chunkIndex).getPassword()
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

  // When currently saved credentials used chunked storage, prepare for cleanup
  const currentEntry = getCurrentEntry()
  const previousChunkedCredentials = getChunkedCredentials(currentEntry)

  const credentialsToWrite = JSON.stringify(validatedCredentials.data)

  // Some OS (e.g. Windows) have platform size limits,
  // chunk the writes in such cases
  const utf16SizeInBytes = getApproximateUtf16SizeInBytes(credentialsToWrite)
  if (process.platform === 'win32' && utf16SizeInBytes > CHUNK_SIZE_SAFE_LIMIT_BYTES) {
    await saveToChunks(credentialsToWrite, previousChunkedCredentials)
  }
  else try {
    currentEntry.setPassword(credentialsToWrite)
    await deleteChunkedCredentials(previousChunkedCredentials)
  }
  catch (e: unknown) {
    // Try saving as chunks when platform size limit was reached
    if (e instanceof Error && PLATFORM_LIMIT_ERROR_RE.test(e.message)) {
      await saveToChunks(credentialsToWrite, previousChunkedCredentials)
    }
    else if (e instanceof Error) {
      throw e
    }
    else {
      throw new TypeError('Unknown error while writing credentials', { cause: e })
    }
  }

  // Write static credentials to legacy storage as well for compatibility purposes
  if (validatedCredentials.data.mode === StorageMode.Static) {
    writeLegacyCredentials(validatedCredentials.data)
  }
}

/**
 * Deletes credentials from the OS keyring.
 */
export async function deleteCredentials(): Promise<boolean> {
  const currentEntry = getCurrentEntry()

  let chunksDeleted = false
  try {
    chunksDeleted ||= await deleteChunkedCredentials(getChunkedCredentials(currentEntry))
  }
  catch {}

  const currentDeleted = currentEntry.deleteCredential()
  const legacyDeleted = getLegacyEntry().deleteCredential()

  return currentDeleted || legacyDeleted || chunksDeleted
}

function writeLegacyCredentials(credentials: LegacyCredentials) {
  const legacyCredentials = legacyCredentialsSchema.parse(credentials)
  getLegacyEntry().setPassword(JSON.stringify(legacyCredentials))
}

async function saveToChunks(initial: string, previousChunkedCredentials: ChunkedCredentials | null): Promise<void> {
  // Since UTF-16 bytes is twice the length of ASCII characters
  const chunkLength = CHUNK_SIZE_SAFE_LIMIT_BYTES / 2

  // Check max number of chunks we could store
  if (initial.length / chunkLength > CHUNK_MAX_COUNT) {
    throw new Error(`Expected chunk count exceeds maximum of ${CHUNK_MAX_COUNT}`)
  }

  let chunkCount = 0

  // Calculate checksum and derive chunkId
  const checksum = await calculateChecksum(initial)
  const chunkId = checksum.slice(0, 8)

  let remaining = initial
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, chunkLength)
    getChunkEntry(chunkId, chunkCount).setPassword(chunk)

    chunkCount++
    remaining = remaining.slice(chunkLength)
  }

  // Replace the parent entry
  const chunkedCredentials: ChunkedCredentials = {
    mode: StorageMode.Chunked,
    checksum,
    chunkCount,
    chunkId,
  }

  const newParentEntry = JSON.stringify(chunkedCredentials)
  getCurrentEntry().setPassword(newParentEntry)

  // Clean up previous chunks when `chunkId` differs.
  // The only realistic scenario when `chunkId` is the same is
  // a race of two `ssm-secrets` calls to GetRoleCredentials
  // returning the exact same STS credentials and trying to write them
  // at the same time which is very low probability.
  if (previousChunkedCredentials?.chunkId !== chunkId) {
    await deleteChunkedCredentials(previousChunkedCredentials)
  }
}

function getChunkedCredentials(entry: Entry): ChunkedCredentials | null {
  try {
    const currentEntryJson = entry.getPassword()
    const currentEntryParsed = currentEntryJson && chunkedCredentialsSchema.safeParse(JSON.parse(currentEntryJson))
    return currentEntryParsed && currentEntryParsed.success
      ? currentEntryParsed.data
      : null
  }
  catch {
    return null
  }
}

function deleteChunkedCredentials(chunkedCredentials: ChunkedCredentials | null): Promise<boolean> {
  // Convenience
  if (chunkedCredentials === null) {
    return Promise.resolve(false)
  }

  return deleteChunksInRange(
    chunkedCredentials.chunkId,
    0,
    chunkedCredentials.chunkCount,
  )
}

async function deleteChunksInRange(chunkId: string, startIndex: number, endIndex: number): Promise<boolean> {
  // Short-circuit for cases when no chunks to delete (e.g. `startIndex = 0, endIndex = 0`)
  if (chunkId === '' || startIndex >= endIndex) {
    return false
  }

  let deleted = false

  function onDelete(result: boolean) {
    deleted ||= result
  }

  const promises: Promise<unknown>[] = []
  for (let i = startIndex; i < endIndex; i++) {
    promises.push(getAsyncChunkEntry(chunkId, i).deleteCredential().then(onDelete, onDeleteError))
  }

  await Promise.allSettled(promises)

  return deleted
}
function onDeleteError() {
  // The task implementing the deletion never throws (unless native code panics)
  // See https://github.com/Brooooooklyn/keyring-node/blob/f330874629298929eda4c4729d1987c7449b51ca/src/async_entry.rs#L288
}

function getChunkEntry(chunkId: string, index: number): Entry {
  return new Entry(KEYRING_SERVICE_NAME, getChunkEntryName(chunkId, index))
}
function getAsyncChunkEntry(chunkId: string, index: number): AsyncEntry {
  return new AsyncEntry(KEYRING_SERVICE_NAME, getChunkEntryName(chunkId, index))
}
function getChunkEntryName(chunkId: string, index: number): string {
  return `${CURRENT_KEYRING_USER_NAME}/chunk/${chunkId}/${index}`
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
