import { describe, expect, it, vi } from 'vitest'
import type { SsoCredentials, StaticCredentials } from '../src/keyring.js'
import { calculateChecksum } from '../src/utils.js'
import type { MockKeyringState } from './mocks/keyring-state.js'
import { getMockKey, getMockKeyringState, runWithMockKeyring } from './mocks/keyring-state.js'

vi.mock('@napi-rs/keyring', async () => {
  const [{ MockAsyncEntry }, { MockEntry }] = await Promise.all([
    import('./mocks/AsyncEntry.mock.js'),
    import('./mocks/Entry.mock.js'),
  ])
  return { AsyncEntry: MockAsyncEntry, Entry: MockEntry }
})

const {
  deleteCredentials,
  getCredentials,
  StorageMode,
  writeCredentials,
} = await import('../src/keyring.js')
type StoredCredentials = Awaited<ReturnType<typeof getCredentials>>

const SERVICE = 'aws-ssm-secrets'
const LEGACY_USERNAME = 'aws-ssm-secrets'
const CURRENT_USERNAME = 'aws-ssm-secrets/v2'
const CURRENT_KEY = getStorageKey(CURRENT_USERNAME)
const LEGACY_KEY = getStorageKey(LEGACY_USERNAME)
const PLATFORM_LIMIT_ERROR = 'Value of \'password encoded as UTF-16\' is longer than the platform limit of 2560 chars'

function getStorageKey(username: string): string {
  return getMockKey(SERVICE, username)
}

function getChunkPrefix(chunkId?: string): string {
  return getStorageKey(`${CURRENT_USERNAME}/chunk/${chunkId === undefined ? '' : `${chunkId}/`}`)
}

function getChunkKeys(chunkId?: string): string[] {
  const prefix = getChunkPrefix(chunkId)
  return [...getMockKeyringState().passwords.keys()].filter(key => key.startsWith(prefix))
}

function getParent(): unknown {
  const parent = getMockKeyringState().passwords.get(CURRENT_KEY)
  if (parent === undefined) {
    throw new Error('Current keyring entry is missing')
  }
  return JSON.parse(parent)
}

function setCurrent(value: unknown): void {
  getMockKeyringState().passwords.set(CURRENT_KEY, typeof value === 'string' ? value : JSON.stringify(value))
}

function setLegacy(value: unknown): void {
  getMockKeyringState().passwords.set(LEGACY_KEY, JSON.stringify(value))
}

function createStaticCredentials(secretAccessKey = 'secret'): StaticCredentials {
  return {
    mode: StorageMode.Static,
    accessKeyId: 'access-key',
    region: 'eu-central-1',
    secretAccessKey,
  }
}

function createSsoCredentials(accessToken = 'access-token'): SsoCredentials {
  return {
    mode: StorageMode.SSO,
    accessToken,
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
    stsCredentials: {
      accessKeyId: 'temporary-access-key',
      expiresAt: 2_000_000_000_000,
      secretAccessKey: 'temporary-secret-key',
      sessionToken: 'session-token',
    },
  }
}

function createLargeSsoCredentials(marker = 'a'): SsoCredentials {
  return createSsoCredentials(marker.repeat(4_000))
}

function failNextSet(error: unknown, options: { key?: string, suffix?: string } = {}): void {
  getMockKeyringState().setFailures.push({ error, ...options })
}

function forceChunkedWrite(): void {
  failNextSet(new Error(PLATFORM_LIMIT_ERROR), { key: CURRENT_KEY })
}

function readCredentials(): Promise<StoredCredentials> {
  try {
    return getCredentials()
  }
  catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Unknown read error', { cause: error }))
  }
}

function keyringTest(name: string, callback: (state: MockKeyringState) => Promise<void> | void): void {
  it.concurrent(name, () => runWithMockKeyring(callback))
}

describe('keyring storage', () => {
  keyringTest('writes static credentials to current and legacy storage', async (state) => {
    const credentials = createStaticCredentials()

    await writeCredentials(credentials)

    expect(JSON.parse(state.passwords.get(CURRENT_KEY) ?? '')).toEqual(credentials)
    expect(JSON.parse(state.passwords.get(LEGACY_KEY) ?? '')).toEqual({
      accessKeyId: credentials.accessKeyId,
      region: credentials.region,
      secretAccessKey: credentials.secretAccessKey,
    })
    await expect(readCredentials()).resolves.toEqual(credentials)
  })

  keyringTest('reads legacy credentials without migrating them', async (state) => {
    const credentials = createStaticCredentials()
    setLegacy({
      accessKeyId: credentials.accessKeyId,
      region: credentials.region,
      secretAccessKey: credentials.secretAccessKey,
    })

    await expect(readCredentials()).resolves.toEqual(credentials)
    expect(state.passwords.has(CURRENT_KEY)).toBe(false)
  })

  keyringTest('writes small SSO credentials directly', async (state) => {
    const credentials = createSsoCredentials()

    await writeCredentials(credentials)

    expect(getParent()).toEqual(credentials)
    expect(getChunkKeys()).toHaveLength(0)
    expect(state.passwords.has(LEGACY_KEY)).toBe(false)
  })

  keyringTest('falls back to chunks after a platform limit error', async () => {
    const credentials = createLargeSsoCredentials()
    forceChunkedWrite()

    await writeCredentials(credentials)

    expect(getParent()).toMatchObject({ mode: StorageMode.Chunked })
    await expect(readCredentials()).resolves.toEqual(credentials)
  })

  keyringTest('keeps identical chunked credentials readable after a rewrite', async () => {
    const credentials = createLargeSsoCredentials()

    forceChunkedWrite()
    await writeCredentials(credentials)
    const firstParent = getParent()
    forceChunkedWrite()
    await writeCredentials(credentials)

    expect(getParent()).toEqual(firstParent)
    await expect(readCredentials()).resolves.toEqual(credentials)
  })

  keyringTest('swaps chunk generations and deletes previous chunks', async (state) => {
    const firstCredentials = createLargeSsoCredentials('a')
    const secondCredentials = createLargeSsoCredentials('b')

    forceChunkedWrite()
    await writeCredentials(firstCredentials)
    const firstParent = getParent()
    const firstChunkKeys = getChunkKeys()
    forceChunkedWrite()
    await writeCredentials(secondCredentials)

    expect(getParent()).not.toEqual(firstParent)
    expect(firstChunkKeys.every(key => !state.passwords.has(key))).toBe(true)
    await expect(readCredentials()).resolves.toEqual(secondCredentials)
  })

  keyringTest('deletes an old chunk generation after switching to direct storage', async (state) => {
    forceChunkedWrite()
    await writeCredentials(createLargeSsoCredentials())
    const oldChunkKeys = getChunkKeys()
    const credentials = createSsoCredentials()

    await writeCredentials(credentials)

    expect(oldChunkKeys.every(key => !state.passwords.has(key))).toBe(true)
    expect(getParent()).toEqual(credentials)
  })

  keyringTest('rejects credentials requiring too many chunks without changing existing storage', async (state) => {
    const existing = createSsoCredentials()
    await writeCredentials(existing)
    const parentBeforeWrite = state.passwords.get(CURRENT_KEY)

    forceChunkedWrite()
    await expect(writeCredentials(createSsoCredentials('x'.repeat(17_000)))).rejects.toThrow(
      'Expected chunk count exceeds maximum of 16',
    )

    expect(state.passwords.get(CURRENT_KEY)).toBe(parentBeforeWrite)
    expect(getChunkKeys()).toHaveLength(0)
  })

  keyringTest('accepts credentials requiring the maximum number of chunks', async () => {
    const credentials = createSsoCredentials('x'.repeat(15_000))

    forceChunkedWrite()
    await writeCredentials(credentials)

    expect(getParent()).toMatchObject({ chunkCount: 16, mode: StorageMode.Chunked })
    expect(getChunkKeys()).toHaveLength(16)
    await expect(readCredentials()).resolves.toEqual(credentials)
  })

  keyringTest('keeps previous credentials readable when a new chunk write fails', async () => {
    const existing = createLargeSsoCredentials('a')
    forceChunkedWrite()
    await writeCredentials(existing)
    forceChunkedWrite()
    failNextSet(new Error('Chunk write failed'), { suffix: '/1' })

    await expect(writeCredentials(createLargeSsoCredentials('b'))).rejects.toThrow('Chunk write failed')

    await expect(readCredentials()).resolves.toEqual(existing)
  })

  keyringTest('keeps previous credentials readable when the parent swap fails', async () => {
    const existing = createLargeSsoCredentials('a')
    forceChunkedWrite()
    await writeCredentials(existing)
    forceChunkedWrite()
    failNextSet(new Error('Parent write failed'), { key: CURRENT_KEY })

    await expect(writeCredentials(createLargeSsoCredentials('b'))).rejects.toThrow('Parent write failed')

    await expect(readCredentials()).resolves.toEqual(existing)
  })

  keyringTest('does not use chunk fallback for an unrelated write error', async (state) => {
    const credentials = createSsoCredentials()
    failNextSet(new Error('Keyring is locked'), { key: CURRENT_KEY })

    await expect(writeCredentials(credentials)).rejects.toThrow('Keyring is locked')

    expect(state.passwords.size).toBe(0)
  })

  keyringTest('wraps a non-Error write failure with its cause', async () => {
    failNextSet('native panic', { key: CURRENT_KEY })

    await expect(writeCredentials(createSsoCredentials())).rejects.toMatchObject({
      cause: 'native panic',
      name: 'TypeError',
    })
  })

  keyringTest('rejects a missing chunk', async (state) => {
    forceChunkedWrite()
    await writeCredentials(createLargeSsoCredentials())
    const chunkKeys = getChunkKeys()
    state.passwords.delete(chunkKeys[1])

    await expect(readCredentials()).rejects.toThrow('could not find keyring chunk 1')
  })

  keyringTest('rejects a checksum mismatch', async (state) => {
    forceChunkedWrite()
    await writeCredentials(createLargeSsoCredentials())
    const chunkKey = getChunkKeys()[0]
    state.passwords.set(chunkKey, `${state.passwords.get(chunkKey)}corrupt`)

    await expect(readCredentials()).rejects.toThrow('checksum mismatch')
  })

  keyringTest('rejects recursively chunked credentials', async (state) => {
    const nested = JSON.stringify({
      mode: StorageMode.Chunked,
      checksum: 'unused',
      chunkCount: 1,
      chunkId: 'nested',
    })
    const checksum = await calculateChecksum(nested)
    setCurrent({ mode: StorageMode.Chunked, checksum, chunkCount: 1, chunkId: 'outer' })
    state.passwords.set(getStorageKey(`${CURRENT_USERNAME}/chunk/outer/0`), nested)

    await expect(readCredentials()).rejects.toThrow('Unexpected recursion')
  })

  it.concurrent.each([
    ['static', { mode: StorageMode.Static }],
    ['SSO', { mode: StorageMode.SSO }],
    ['chunked with zero chunks', { mode: StorageMode.Chunked, checksum: 'checksum', chunkCount: 0, chunkId: 'id' }],
    ['chunked above the maximum', { mode: StorageMode.Chunked, checksum: 'checksum', chunkCount: 17, chunkId: 'id' }],
    ['chunked without checksum', { mode: StorageMode.Chunked, chunkCount: 1, chunkId: 'id' }],
    ['chunked without ID', { mode: StorageMode.Chunked, checksum: 'checksum', chunkCount: 1 }],
    ['missing mode', { region: 'eu-central-1' }],
  ])('reports malformed %s credentials as invalid', (_name, value) =>
    runWithMockKeyring(async () => {
      setCurrent(value)
      await expect(readCredentials()).rejects.toThrow('Credentials have invalid format')
    }),
  )

  keyringTest('reports an unknown storage mode as unsupported', async () => {
    setCurrent({ mode: 'future-storage' })

    await expect(readCredentials()).rejects.toThrow('Update the utility to support mode: future-storage')
  })

  keyringTest('rejects invalid JSON', async () => {
    setCurrent('{')

    await expect(readCredentials()).rejects.toBeInstanceOf(SyntaxError)
  })

  keyringTest('rejects malformed legacy credentials', async () => {
    setLegacy({ accessKeyId: 'access-key' })

    await expect(readCredentials()).rejects.toThrow('Credentials have invalid format')
  })

  keyringTest('deletes current, legacy, and referenced chunk entries', async (state) => {
    forceChunkedWrite()
    await writeCredentials(createLargeSsoCredentials())
    setLegacy({ accessKeyId: 'access-key', region: 'eu-central-1', secretAccessKey: 'secret' })

    await expect(deleteCredentials()).resolves.toBe(true)

    expect(state.passwords.size).toBe(0)
  })
})
