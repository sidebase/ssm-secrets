import { Command } from 'commander'
import promptInput from '@inquirer/input'
import promptPassword from '@inquirer/password'
import { writeCredentials } from '../keyring.js'

const SUMMARY = 'Authenticate and store AWS credentials securely'
const DESCRIPTION = `${SUMMARY}.
This will use the OS-specific keyring to store the Region, Access Key ID and Secret Access Key provided via an interactive prompt.
For more details, visit https://github.com/Brooooooklyn/keyring-node or its underlying library https://github.com/open-source-cooperative/keyring-rs`

export function authCommand(program: Command) {
  program
    .command('auth')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .action(async () => {
      const answers = {
        region: await promptInput({ message: 'AWS Region:', default: 'eu-central-1' }),
        accessKeyId: await promptInput({ message: 'AWS Access Key ID:', required: true }),
        secretAccessKey: await promptPassword({
          message: 'AWS Secret Access Key:',
          validate: v => v !== '' || 'Key is required',
          mask: true,
        }),
      }

      writeCredentials(answers)
      console.log('✅ Credentials securely stored in system keyring')
    })
}
