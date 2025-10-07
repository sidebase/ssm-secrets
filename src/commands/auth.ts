import { Command } from 'commander'
import inquirer from 'inquirer'
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
      const answers = await inquirer.prompt([
        { default: 'eu-central-1', message: 'AWS Region:', name: 'region', type: 'input' },
        { message: 'AWS Access Key ID:', name: 'accessKeyId', required: true, type: 'input' },
        { message: 'AWS Secret Access Key:', name: 'secretAccessKey', type: 'password' },
      ])

      writeCredentials(answers)
      console.log('✅ Credentials securely stored in system keyring')
    })
}
