import { Entry } from '@napi-rs/keyring'
import { z } from 'zod'

const KEYRING_SERVICE_NAME = 'aws-ssm-secrets'
const KEYRING_USER_NAME = 'aws-ssm-secrets'
const ADD_CREDENTIALS_CMD = 'ssm-secrets auth'

const credentialsSchema = z.object({
  accessKeyId: z.string().nonempty(), region: z.string().nonempty(), secretAccessKey: z.string().nonempty(),
})
type Credentials = z.infer<typeof credentialsSchema>

/**
 * Gets credentials from the OS keyring.
 */
export function getCredentials(): Credentials {
  const credentialsJson = getEntry().getPassword()
  if (!credentialsJson) {
    throw new Error(`No credentials in keyring. Run \`${ADD_CREDENTIALS_CMD}\` first.`)
  }

  const credentials = credentialsSchema.safeParse(JSON.parse(credentialsJson))
  if (!credentials.success) {
    throw new Error(`Credentials have invalid format. Run \`${ADD_CREDENTIALS_CMD}\` to refresh them.`)
  }

  return credentials.data
}

/**
 * Writes credentials into the OS keyring.
 */
export function writeCredentials(credentials: Credentials) {
  const validatedCredentials = credentialsSchema.safeParse(credentials)
  if (!validatedCredentials.success) {
    throw new Error('Credentials have invalid format.')
  }

  getEntry().setPassword(JSON.stringify(validatedCredentials.data))
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
