import { Command } from 'commander'
import promptInput from '@inquirer/input'
import promptPassword from '@inquirer/password'
import { inputSsoCredentials, inputStaticCredentials } from '../credentials.js'

const SUMMARY = 'Authenticate and store AWS credentials securely'
const DESCRIPTION = `${SUMMARY}.
This will use the OS-specific keyring to store static AWS credentials or AWS SSO authentication state.
For more details, visit https://github.com/Brooooooklyn/keyring-node or its underlying library https://github.com/open-source-cooperative/keyring-rs`

const DEFAULT_REGION = 'eu-central-1'

interface AuthCommandOptions {
  accountId?: string
  region: string
  roleName?: string
  ssoStartUrl?: string
}

export function authCommand(program: Command) {
  program
    .command('auth')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .option('--region <REGION>', 'AWS region')
    .option('--sso-start-url <URL>', 'AWS SSO start URL')
    .option('--account-id <ACCOUNT_ID>', 'AWS SSO account ID')
    .option('--role-name <ROLE_NAME>', 'AWS SSO role name')
    .action(async (options: AuthCommandOptions) => {
      if (options.ssoStartUrl) {
        await inputSsoCredentials({
          accountId: options.accountId,
          region: options.region || DEFAULT_REGION,
          roleName: options.roleName,
          startUrl: options.ssoStartUrl,
        })
        console.log('✅ SSO credentials securely stored in system keyring')
        return
      }

      const answers = {
        region: options.region ?? await promptInput({ message: 'AWS Region:', default: DEFAULT_REGION }),
        accessKeyId: await promptInput({ message: 'AWS Access Key ID:', required: true }),
        secretAccessKey: await promptPassword({
          message: 'AWS Secret Access Key:',
          validate: v => v !== '' || 'Key is required',
          mask: true,
        }),
      }

      await inputStaticCredentials(answers)
      console.log('✅ Static credentials securely stored in system keyring')
    })
}
