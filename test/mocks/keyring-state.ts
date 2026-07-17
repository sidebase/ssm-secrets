import { AsyncLocalStorage } from 'node:async_hooks'

export interface MockKeyringState {
  asyncDeleteFailures: Set<string>
  passwords: Map<string, string>
  setFailures: Array<{ error: unknown, key?: string, suffix?: string }>
}

// oxlint-disable-next-line typescript/no-unsafe-call -- oxlint-tsgolint does not resolve this Node type; tsc validates it.
const stateStorage = new AsyncLocalStorage<MockKeyringState>()

export function createMockKeyringState(): MockKeyringState {
  return {
    asyncDeleteFailures: new Set<string>(),
    passwords: new Map<string, string>(),
    setFailures: [],
  }
}

export function getMockKeyringState(): MockKeyringState {
  // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access -- See AsyncLocalStorage note above.
  const state = stateStorage.getStore()
  if (!state) {
    throw new Error('Mock keyring accessed outside test context')
  }
  // oxlint-disable-next-line typescript/no-unsafe-return -- See AsyncLocalStorage note above.
  return state
}

export function runWithMockKeyring<T>(callback: (state: MockKeyringState) => T): T {
  // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- See AsyncLocalStorage note above.
  return stateStorage.run(createMockKeyringState(), () => callback(getMockKeyringState()))
}

export function getMockKey(service: string, username: string): string {
  return `${service}\0${username}`
}
