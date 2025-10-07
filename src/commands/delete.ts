import { Command } from 'commander'
import { deleteParameter } from '../aws.js'

const SUMMARY = 'Delete a parameter from SSM'
const DESCRIPTION = `${SUMMARY}.`

export function deleteCommand(program: Command) {
  program
    .command('delete')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .argument('<path>', 'SSM path')
    .argument('<name>', 'Parameter name')
    .action(async (path: string, name: string) => {
      await deleteParameter(path, name)
      console.log('✅ Parameter deleted')
    })
}
