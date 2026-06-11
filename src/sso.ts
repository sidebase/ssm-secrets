import { GetRoleCredentialsCommand, ListAccountRolesCommand, ListAccountsCommand, SSOClient } from '@aws-sdk/client-sso'
import { AuthorizationPendingException, CreateTokenCommand, InvalidGrantException, RegisterClientCommand, SlowDownException, SSOOIDCClient, StartDeviceAuthorizationCommand } from '@aws-sdk/client-sso-oidc'

export interface RegisteredClient {
  clientId: string
  clientSecret: string
  clientSecretExpiresAt: number
}

export interface DeviceAuthorization {
  deviceCode: string
  expiresIn: number
  interval: number
  userCode: string
  verificationUri: string
  verificationUriComplete: string
}

export interface SsoToken {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken?: string
}

export interface SsoAccount {
  accountId: string
  accountName?: string
  emailAddress?: string
}

export interface SsoRole {
  accountId: string
  roleName: string
}

export interface RoleCredentials {
  accessKeyId: string
  expiresAt: number
  secretAccessKey: string
  sessionToken: string
}

const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const REFRESH_TOKEN_GRANT_TYPE = 'refresh_token'

export async function registerClient(region: string): Promise<RegisteredClient> {
  const client = getOidcClient(region)
  const result = await client.send(new RegisterClientCommand({
    clientName: 'ssm-secrets',
    clientType: 'public',
    scopes: ['sso:account:access'],
  }))

  if (!result.clientId || !result.clientSecret || !result.clientSecretExpiresAt) {
    throw new Error('AWS SSO client registration returned incomplete data.')
  }

  return {
    clientId: result.clientId,
    clientSecret: result.clientSecret,
    clientSecretExpiresAt: result.clientSecretExpiresAt,
  }
}

export async function startDeviceAuthorization(
  region: string,
  clientId: string,
  clientSecret: string,
  startUrl: string,
): Promise<DeviceAuthorization> {
  const client = getOidcClient(region)
  const result = await client.send(new StartDeviceAuthorizationCommand({
    clientId,
    clientSecret,
    startUrl,
  }))

  if (!result.deviceCode || !result.userCode || !result.verificationUri || !result.verificationUriComplete || !result.expiresIn || !result.interval) {
    throw new Error('AWS SSO device authorization returned incomplete data.')
  }

  return {
    deviceCode: result.deviceCode,
    expiresIn: result.expiresIn,
    interval: result.interval,
    userCode: result.userCode,
    verificationUri: result.verificationUri,
    verificationUriComplete: result.verificationUriComplete,
  }
}

export async function createTokenFromDeviceCode(
  region: string,
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
): Promise<SsoToken> {
  const client = getOidcClient(region)
  const expiresAt = Date.now() + expiresInSeconds * 1000

  let pollIntervalSeconds = intervalSeconds

  while (Date.now() < expiresAt) {
    // oxlint-disable-next-line no-await-in-loop -- AWS device authorization requires sequential polling.
    await sleep(pollIntervalSeconds * 1000)

    try {
      // oxlint-disable-next-line no-await-in-loop -- AWS device authorization requires sequential polling.
      const result = await client.send(new CreateTokenCommand({
        clientId,
        clientSecret,
        deviceCode,
        grantType: DEVICE_CODE_GRANT_TYPE,
      }))

      return parseTokenResult(result.accessToken, result.expiresIn, result.refreshToken)
    }
    catch (error) {
      if (error instanceof AuthorizationPendingException) {
        continue
      }
      if (error instanceof SlowDownException) {
        pollIntervalSeconds += 5
        continue
      }
      throw error
    }
  }

  throw new Error('AWS SSO device authorization expired before login completed.')
}

export async function refreshAccessToken(
  region: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<SsoToken> {
  const client = getOidcClient(region)
  const result = await client.send(new CreateTokenCommand({
    clientId,
    clientSecret,
    grantType: REFRESH_TOKEN_GRANT_TYPE,
    refreshToken,
  }))

  return parseTokenResult(result.accessToken, result.expiresIn, result.refreshToken ?? refreshToken)
}

export async function listAccounts(region: string, accessToken: string): Promise<SsoAccount[]> {
  const client = getSsoClient(region)
  const accounts: SsoAccount[] = []
  let nextToken: string | undefined

  do {
    // oxlint-disable-next-line no-await-in-loop -- AWS pagination is sequential.
    const result = await client.send(new ListAccountsCommand({ accessToken, nextToken }))
    accounts.push(...(result.accountList ?? []).map(account => ({
      accountId: required(account.accountId, 'AWS SSO account is missing account ID.'),
      accountName: account.accountName,
      emailAddress: account.emailAddress,
    })))
    nextToken = result.nextToken
  } while (nextToken)

  return accounts
}

export async function listRoles(region: string, accessToken: string, accountId: string): Promise<SsoRole[]> {
  const client = getSsoClient(region)
  const roles: SsoRole[] = []
  let nextToken: string | undefined

  do {
    // oxlint-disable-next-line no-await-in-loop -- AWS pagination is sequential.
    const result = await client.send(new ListAccountRolesCommand({ accessToken, accountId, nextToken }))
    roles.push(...(result.roleList ?? []).map(role => ({
      accountId: required(role.accountId, 'AWS SSO role is missing account ID.'),
      roleName: required(role.roleName, 'AWS SSO role is missing role name.'),
    })))
    nextToken = result.nextToken
  } while (nextToken)

  return roles
}

export async function getRoleCredentials(region: string, accessToken: string, accountId: string, roleName: string): Promise<RoleCredentials> {
  const client = getSsoClient(region)
  const result = await client.send(new GetRoleCredentialsCommand({ accessToken, accountId, roleName }))
  const credentials = result.roleCredentials

  if (!credentials?.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken || !credentials.expiration) {
    throw new Error('AWS SSO role credentials response is incomplete.')
  }

  return {
    accessKeyId: credentials.accessKeyId,
    expiresAt: credentials.expiration,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  }
}

export function getErrorReason(e: unknown): string | undefined {
  if (e instanceof InvalidGrantException) {
    return e.error_description
  }
  else if (e instanceof Error) {
    return e.message
  }
  return undefined
}

function getOidcClient(region: string): SSOOIDCClient {
  return new SSOOIDCClient({ region })
}

function getSsoClient(region: string): SSOClient {
  return new SSOClient({ region })
}

function parseTokenResult(accessToken: string | undefined, expiresIn: number | undefined, refreshToken: string | undefined): SsoToken {
  if (!accessToken || !expiresIn) {
    throw new Error('AWS SSO token response is incomplete.')
  }

  return {
    accessToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
    refreshToken,
  }
}

function required(value: string | undefined, errorMessage: string): string {
  if (!value) {
    throw new Error(errorMessage)
  }
  return value
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
