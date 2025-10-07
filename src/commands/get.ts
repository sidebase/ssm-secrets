import { Command } from 'commander'
import { getParameter } from '../aws.js'

const SUMMARY = 'Get a single parameter value'
const DESCRIPTION = `${SUMMARY}.
The parameter is returned in its full JSON form as fetched from SSM, i.e. including the metadata.`

export function getCommand(program: Command) {
  program
    .command('get')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .argument('<path>', 'SSM path')
    .argument('<name>', 'Parameter name')
    .action(async (path: string, name: string) => {
      const value = await getParameter(path, name)
      if (value) {
        console.log(value)
      }
      else {
        console.error('Error: Parameter not found')
      }
    })
}
