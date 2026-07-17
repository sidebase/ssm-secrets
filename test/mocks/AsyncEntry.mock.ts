import { getMockKey, getMockKeyringState } from './keyring-state.js'

export class MockAsyncEntry {
  private readonly key: string

  constructor(service: string, username: string) {
    this.key = getMockKey(service, username)
  }

  deleteCredential(): Promise<boolean> {
    const state = getMockKeyringState()
    if (state.asyncDeleteFailures.has(this.key)) {
      return Promise.reject(new Error('Mock keyring delete failure'))
    }
    return Promise.resolve(state.passwords.delete(this.key))
  }
}
