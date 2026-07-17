import { getMockKey, getMockKeyringState } from './keyring-state.js'

export class MockEntry {
  private readonly key: string

  constructor(service: string, username: string) {
    this.key = getMockKey(service, username)
  }

  getPassword(): string | null {
    return getMockKeyringState().passwords.get(this.key) ?? null
  }

  setPassword(password: string): void {
    const state = getMockKeyringState()
    const failureIndex = state.setFailures.findIndex(failure =>
      (failure.key === undefined || failure.key === this.key)
      && (failure.suffix === undefined || this.key.endsWith(failure.suffix)),
    )
    if (failureIndex >= 0) {
      const [failure] = state.setFailures.splice(failureIndex, 1)
      throw failure.error
    }
    state.passwords.set(this.key, password)
  }

  deleteCredential(): boolean {
    return getMockKeyringState().passwords.delete(this.key)
  }

  deletePassword(): boolean {
    return this.deleteCredential()
  }
}
