import { afterEach, expect, it, vi } from 'vitest'
import type { SsoCredentials } from '../src/keyring.js'
import { getMockKey, runWithMockKeyring } from './mocks/keyring-state.js'

vi.mock('@napi-rs/keyring', async () => {
  const [{ MockAsyncEntry }, { MockEntry }] = await Promise.all([
    import('./mocks/AsyncEntry.mock.js'),
    import('./mocks/Entry.mock.js'),
  ])
  return { AsyncEntry: MockAsyncEntry, Entry: MockEntry }
})

const { getCredentials, StorageMode, writeCredentials } = await import('../src/keyring.js')

const CURRENT_KEY = getMockKey('aws-ssm-secrets', 'aws-ssm-secrets/v2')

afterEach(() => {
  vi.restoreAllMocks()
})

it('proactively chunks oversized credentials on Windows', () => runWithMockKeyring(async (state) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const credentials: SsoCredentials = {
    mode: StorageMode.SSO,
    accessToken: 'a'.repeat(4_000),
    accessTokenExpiresAt: 2_000_000_000_000,
    accountId: '123456789012',
    allowBrowserRefresh: true,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    clientSecretExpiresAt: 2_000_000_000,
    refreshToken: 'refresh-token',
    region: 'eu-central-1',
    roleName: 'Developer',
    startUrl: 'https://example.awsapps.com/start',
  }

  await writeCredentials(credentials)

  const parentJson = state.passwords.get(CURRENT_KEY)
  expect(parentJson).toBeDefined()
  expect(JSON.parse(parentJson ?? '')).toMatchObject({
    chunkCount: 5,
    mode: StorageMode.Chunked,
  })
  await expect(getCredentials()).resolves.toEqual(credentials)
}))
