import { Command } from 'commander'
import { deleteCredentials } from '../keyring.js'

const SUMMARY = 'Delete stored AWS credentials'
const DESCRIPTION = `${SUMMARY}.`

export function wipeCredentialsCommand(program: Command) {
  program
    .command('wipe-credentials')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .action(() => {
      const deleted = deleteCredentials()
      console.log(deleted ? '✅ Credentials deleted' : 'No credentials found')
    })
}
