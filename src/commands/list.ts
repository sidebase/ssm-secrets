import { Command, InvalidOptionArgumentError } from 'commander'
import { listParameters } from '../aws.js'
import { formatEnv, prettifyParameter } from '../utils.js'

const SUMMARY = 'List all parameters under a path'
const DESCRIPTION = `${SUMMARY}.
The listing is recursive.`

const ALLOWED_OUTPUT_FORMATS = ['env', 'json'] as const

export function listCommand(program: Command) {
  program
    .command('list')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .argument('<path>', 'SSM parameter path')
    .option('--format <FORMAT>', 'Output format, either `env` or `json`', (value) => {
      if (!value) {
        return 'json'
      }

      if (!(ALLOWED_OUTPUT_FORMATS as readonly string[]).includes(value)) {
        throw new InvalidOptionArgumentError(`Format must be one of: ${ALLOWED_OUTPUT_FORMATS.join(', ')}`)
      }
      return value
    }, 'json')
    .action(async (path: string, options: { format: string }) => {
      const ssmParameters = await listParameters(path)
      const prettyParams = ssmParameters.map(param => prettifyParameter(param, path))

      const outputFormat = options.format

      if (outputFormat === 'json') {
        console.log(JSON.stringify(
          Object.fromEntries(prettyParams.map(param => [param.Name, param.Value])),
          null,
          2,
        ))
      }
      else if (outputFormat === 'env') {
        console.log(
          prettyParams.map(formatEnv).filter(Boolean).join('\n'),
        )
      }
      else {
        throw new InvalidOptionArgumentError(`Format must be one of: ${ALLOWED_OUTPUT_FORMATS.join(', ')}`)
      }
    })
}
