import { Command } from 'commander'
import promptPassword from '@inquirer/password'
import { putParameter } from '../aws.js'

const SUMMARY = 'Add or update a parameter'
const DESCRIPTION = `${SUMMARY}.
When the parameter does not exist, it will be automatically created.
The version assigned by SSM is displayed when available.`

export function putCommand(program: Command) {
  program
    .command('put')
    .alias('set')
    .alias('write')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .argument('<path>', 'SSM path, e.g. some/path')
    .argument('<name>', 'Parameter name, e.g. param')
    .argument('[value]', 'Value to store')
    .action(async (path: string, name: string, argValue: string | undefined) => {
      // Value can be prompted interactively to avoid saving
      // sensitive data in shell history
      let value = argValue ?? await promptPassword({ message: 'Value to store:', mask: true })
      if (typeof value !== 'string') {
        program.error('Value is required')
      }

      const version = await putParameter(path, name, value)

      let message = '✅ Parameter stored'
      if (version !== undefined) {
        message += ` with version ${version}`
      }
      console.log(message)
    })
}
