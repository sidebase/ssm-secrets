import { Entry } from '@napi-rs/keyring'
import { z } from 'zod'

const CURRENT_SCHEMA_VERSION = 2

const KEYRING_SERVICE_NAME = 'aws-ssm-secrets'
const LEGACY_KEYRING_USER_NAME = 'aws-ssm-secrets'
const CURRENT_KEYRING_USER_NAME = `aws-ssm-secrets/v${CURRENT_SCHEMA_VERSION}`
const ADD_CREDENTIALS_CMD = 'ssm-secrets auth'

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

const storedCredentialsSchema = z.discriminatedUnion('mode', [staticCredentialsSchema, ssoCredentialsSchema])

export type StaticCredentials = z.infer<typeof staticCredentialsSchema>
export type SsoCredentials = z.infer<typeof ssoCredentialsSchema>
export type StoredCredentials = z.infer<typeof storedCredentialsSchema>
type LegacyCredentials = z.infer<typeof legacyCredentialsSchema>

/**
 * Gets credentials from the OS keyring.
 */
export function getCredentials(): StoredCredentials {
  const currentCredentialsJson = getCurrentEntry().getPassword()
  if (currentCredentialsJson) {
    return parseCurrentCredentials(currentCredentialsJson)
  }

  const legacyCredentialsJson = getLegacyEntry().getPassword()
  if (!legacyCredentialsJson) {
    throw new Error(`No credentials in keyring. Run \`${ADD_CREDENTIALS_CMD}\` first.`)
  }

  return parseLegacyCredentials(legacyCredentialsJson)
}

function parseCurrentCredentials(credentialsJson: string): StoredCredentials {
  const parsedCredentials: unknown = JSON.parse(credentialsJson)
  const credentials = storedCredentialsSchema.safeParse(parsedCredentials)
  if (!credentials.success) {
    throw new Error(`Credentials have invalid format. Run \`${ADD_CREDENTIALS_CMD}\` to refresh them.`)
  }

  return credentials.data
}

function parseLegacyCredentials(credentialsJson: string): StoredCredentials {
  const credentials = legacySchemaToV2.safeParse(JSON.parse(credentialsJson))
  if (!credentials.success) {
    throw new Error(`Credentials have invalid format. Run \`${ADD_CREDENTIALS_CMD}\` to refresh them.`)
  }

  return credentials.data
}

/**
 * Writes credentials into the OS keyring.
 */
export function writeCredentials(credentials: StoredCredentials) {
  const validatedCredentials = storedCredentialsSchema.safeParse(credentials)
  if (!validatedCredentials.success) {
    throw new Error('Credentials have invalid format.')
  }

  getCurrentEntry().setPassword(JSON.stringify(validatedCredentials.data))

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

function getCurrentEntry(): Entry {
  return new Entry(KEYRING_SERVICE_NAME, CURRENT_KEYRING_USER_NAME)
}

function getLegacyEntry(): Entry {
  return new Entry(KEYRING_SERVICE_NAME, LEGACY_KEYRING_USER_NAME)
}
