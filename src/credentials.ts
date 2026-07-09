import promptConfirm from '@inquirer/confirm'
import promptSelect from '@inquirer/select'
import type { SsoCredentials, StaticCredentials } from './keyring.js'
import { getCredentials, writeCredentials } from './keyring.js'
import { openHttpsUrl } from './browser.js'
import { createTokenFromDeviceCode, getErrorReason, getRoleCredentials, listAccounts, listRoles, refreshAccessToken, registerClient, startDeviceAuthorization } from './sso.js'

const EXPIRY_BUFFER_MS = 60 * 1000

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

interface SsoAuthOptions {
  accountId?: string
  allowBrowserRefresh?: boolean
  region: string
  roleName?: string
  startUrl: string
}

export async function getCredentialsRegion(): Promise<string> {
  return (await getCredentials()).region
}

export async function getAwsCredentials(): Promise<AwsCredentials> {
  const credentials = await getCredentials()

  if (credentials.mode === 'static') {
    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    }
  }

  return resolveSsoCredentials(credentials)
}

/** Stores the static credentials provided by the user */
export async function inputStaticCredentials(credentials: Omit<StaticCredentials, 'mode'>) {
  await writeCredentials({ mode: 'static', ...credentials })
}

/**
 * Handles the initial SSO login flow using the parameters provided by the user.
 * Only `region` and `startUrl` are required for this flow.
 */
export async function inputSsoCredentials(options: SsoAuthOptions) {
  const startUrl = normalizeStartUrl(options.startUrl)
  const allowBrowserRefresh = options.allowBrowserRefresh ?? await promptConfirm({
    default: true,
    message: 'Allow ssm-secrets to open browser automatically when SSO credentials expire?',
  })

  const client = await registerClient(options.region)
  const token = await runDeviceAuthorization({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    region: options.region,
    startUrl,
  })

  const accountId = options.accountId ?? await selectAccount(options.region, token.accessToken)
  const roleName = options.roleName ?? await selectRole(options.region, token.accessToken, accountId)
  const stsCredentials = await getRoleCredentials(options.region, token.accessToken, accountId, roleName)

  await writeCredentials({
    mode: 'sso',
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    accountId,
    allowBrowserRefresh,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    clientSecretExpiresAt: client.clientSecretExpiresAt,
    refreshToken: token.refreshToken,
    region: options.region,
    roleName,
    startUrl,
    stsCredentials,
  })
}

/**
 * Obtain the set of fresh STS credentials.
 * When STS credentials have not expired yet, use them as-is.
 * When STS credentials have already expired, use the access token to refresh them.
 * Since the access token itself has time-to-live, its refresh is handled as well.
 */
async function resolveSsoCredentials(credentials: SsoCredentials): Promise<AwsCredentials> {
  if (isFresh(credentials.stsCredentials?.expiresAt)) {
    return credentials.stsCredentials
  }

  const refreshedCredentials = await getSsoCredentialsWithFreshToken(credentials)
  if (!refreshedCredentials.accessToken) {
    throw new Error('AWS SSO access token refresh failed.')
  }

  const stsCredentials = await getRoleCredentials(
    refreshedCredentials.region,
    refreshedCredentials.accessToken,
    refreshedCredentials.accountId,
    refreshedCredentials.roleName,
  )
  const updatedCredentials = { ...refreshedCredentials, stsCredentials }
  await writeCredentials(updatedCredentials)
  return stsCredentials
}

/**
 * Obtain the fresh access token.
 * When it hasn't expired yet, it will be returned as-is.
 * When it has expired but the refresh token has not, the latter will be used to request a new access token.
 * When both have expired, browser refresh will be triggered depending on user's `allowBrowserRefresh` preference.
 */
async function getSsoCredentialsWithFreshToken(credentials: SsoCredentials): Promise<SsoCredentials> {
  if (isFresh(credentials.accessTokenExpiresAt) && credentials.accessToken) {
    return credentials
  }

  if (isFresh(credentials.clientSecretExpiresAt, true) && credentials.refreshToken) {
    try {
      const token = await refreshAccessToken(credentials.region, credentials.clientId, credentials.clientSecret, credentials.refreshToken)
      const updatedCredentials = {
        ...credentials,
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        refreshToken: token.refreshToken,
      }
      await writeCredentials(updatedCredentials)
      return updatedCredentials
    }
    catch (e) {
      const reason = getErrorReason(e)
      const reasonSuffix = reason ? ` Reason: ${reason}` : ''
      console.warn(`Unable to automatically refresh the access token, falling back to interactive refresh.${reasonSuffix}`)
    }
  }

  return runInteractiveSsoRefresh(credentials)
}

/**
 * Obtains the new access token using the interactive (browser-based) flow.
 * Additionally handles the SSO client refresh for the cases when it expired.
 */
async function runInteractiveSsoRefresh(credentials: SsoCredentials): Promise<SsoCredentials> {
  if (!credentials.allowBrowserRefresh) {
    throw new Error(`AWS SSO credentials expired. Run the following command to refresh them:\nssm-secrets auth --sso-start-url ${credentials.startUrl}`)
  }

  const client = isFresh(credentials.clientSecretExpiresAt)
    ? {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        clientSecretExpiresAt: credentials.clientSecretExpiresAt,
      }
    : await registerClient(credentials.region)

  const token = await runDeviceAuthorization({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    region: credentials.region,
    startUrl: credentials.startUrl,
  })

  const updatedCredentials = {
    ...credentials,
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    clientSecretExpiresAt: client.clientSecretExpiresAt,
    refreshToken: token.refreshToken,
  }
  await writeCredentials(updatedCredentials)
  return updatedCredentials
}

/**
 * Handles the device authorization flow by opening a browser and actively polling the token.
 */
async function runDeviceAuthorization(options: { clientId: string, clientSecret: string, region: string, startUrl: string }) {
  const authorization = await startDeviceAuthorization(options.region, options.clientId, options.clientSecret, options.startUrl)

  const opened = openHttpsUrl(authorization.verificationUriComplete)
  console.error(opened ? 'Opened AWS SSO login in browser.' : 'Could not open browser automatically, please open the link below yourself.')
  console.error(`Link: ${authorization.verificationUriComplete}`)
  console.error(`Code: ${authorization.userCode}`)

  return createTokenFromDeviceCode(
    options.region,
    options.clientId,
    options.clientSecret,
    authorization.deviceCode,
    authorization.interval,
    authorization.expiresIn,
  )
}

/**
 * Selects the only account available for the given access token,
 * or prompts the user when multiple accounts are present.
 */
async function selectAccount(region: string, accessToken: string): Promise<string> {
  const accounts = await listAccounts(region, accessToken)
  if (accounts.length === 0) {
    throw new Error('AWS SSO returned no accounts.')
  }

  if (accounts.length === 1) {
    const accountId = accounts[0].accountId
    console.warn('Selecting the only account available with accountId', accountId)
    return accountId
  }

  return promptSelect({
    choices: accounts.map(account => ({
      name: [account.accountName, account.accountId, account.emailAddress].filter(Boolean).join(' | '),
      value: account.accountId,
    })),
    message: 'Select AWS SSO account:',
  })
}

/**
 * Selects the only role available for the given account and access token,
 * or prompts the user when multiple roles are present.
 */
async function selectRole(region: string, accessToken: string, accountId: string): Promise<string> {
  const roles = await listRoles(region, accessToken, accountId)
  if (roles.length === 0) {
    throw new Error(`AWS SSO returned no roles for account ${accountId}.`)
  }

  if (roles.length === 1) {
    const roleName = roles[0].roleName
    console.warn('Selecting the only role available with roleName', roleName)
    return roleName
  }

  return promptSelect({
    choices: roles.map(role => ({ name: role.roleName, value: role.roleName })),
    message: 'Select AWS SSO role:',
  })
}

function normalizeStartUrl(startUrl: string): string {
  const url = new URL(startUrl)
  if (url.protocol !== 'https:') {
    throw new Error('AWS SSO start URL must use https.')
  }
  return url.href
}

function isFresh(expiresAt: number | undefined, isInSeconds = false): expiresAt is number {
  if (typeof expiresAt !== 'number') {
    return false
  }

  const expiresAtMs = isInSeconds ? expiresAt * 1000 : expiresAt
  return expiresAtMs - EXPIRY_BUFFER_MS > Date.now()
}
