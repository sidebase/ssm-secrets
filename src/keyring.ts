import { Entry } from '@napi-rs/keyring'
import { z } from 'zod'

const KEYRING_SERVICE_NAME = 'aws-ssm-secrets'
const KEYRING_USER_NAME = 'aws-ssm-secrets'
const ADD_CREDENTIALS_CMD = 'ssm-secrets auth'

const legacyCredentialsSchema = z.object({
  accessKeyId: z.string().nonempty(), region: z.string().nonempty(), secretAccessKey: z.string().nonempty(),
})

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

/**
 * Gets credentials from the OS keyring.
 */
export function getStoredCredentials(): StoredCredentials {
  const credentialsJson = getEntry().getPassword()
  if (!credentialsJson) {
    throw new Error(`No credentials in keyring. Run \`${ADD_CREDENTIALS_CMD}\` first.`)
  }

  const parsedCredentials: unknown = JSON.parse(credentialsJson)
  const credentials = storedCredentialsSchema.safeParse(parsedCredentials)
  if (!credentials.success) {
    const legacyCredentials = legacyCredentialsSchema.safeParse(parsedCredentials)
    if (legacyCredentials.success) {
      const migratedCredentials: StaticCredentials = { mode: 'static', ...legacyCredentials.data }
      writeStoredCredentials(migratedCredentials)
      return migratedCredentials
    }

    throw new Error(`Credentials have invalid format. Run \`${ADD_CREDENTIALS_CMD}\` to refresh them.`)
  }

  return credentials.data
}

/**
 * Writes credentials into the OS keyring.
 */
export function writeStoredCredentials(credentials: StoredCredentials) {
  const validatedCredentials = storedCredentialsSchema.safeParse(credentials)
  if (!validatedCredentials.success) {
    throw new Error('Credentials have invalid format.')
  }

  getEntry().setPassword(JSON.stringify(validatedCredentials.data))
}

export function getCredentials(): StoredCredentials {
  return getStoredCredentials()
}

export function writeCredentials(credentials: Omit<StaticCredentials, 'mode'> | StaticCredentials) {
  writeStoredCredentials({ mode: 'static', ...credentials })
}

/**
 * Deletes credentials from the OS keyring.
 */
export function deleteCredentials(): boolean {
  return getEntry().deletePassword()
}

function getEntry(): Entry {
  return new Entry(KEYRING_SERVICE_NAME, KEYRING_USER_NAME)
}
