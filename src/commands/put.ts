import { Command } from 'commander'
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
    .argument('<value>', 'Value to store')
    .action(async (path: string, name: string, value: string) => {
      const version = await putParameter(path, name, value)

      let message = '✅ Parameter stored'
      if (version !== undefined) {
        message += ` with version ${version}`
      }
      console.log(message)
    })
}
