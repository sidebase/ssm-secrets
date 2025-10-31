import { Command } from 'commander'
import { listParameters } from '../aws.js'
import { prettifyParameter } from '../utils.js'
import { spawn } from 'node:child_process'

const SUMMARY = 'Execute the command with the environment from SSM'
const DESCRIPTION = `${SUMMARY}.
This command will fetch the parameters from SSM and provide them as environment variables to the specified command.`

export function execCommand(program: Command) {
  program
    .command('exec')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .argument('<path>', 'SSM parameter path')
    .argument('<command>')
    .argument('[args...]')
    .action(async (path: string, command: string, args: string[]) => {
      const ssmParameters = await listParameters(path)
      const prettyParams = ssmParameters.map(param => prettifyParameter(param, path))

      const envs = Object.fromEntries(prettyParams.map(param => [param.Name?.toUpperCase(), param.Value]))

      // Merge into environment
      const env = {
        ...process.env,
        ...envs,
      }

      // Replace current process
      const child = spawn(command, args, {
        env,
        stdio: 'inherit',
      })

      child.on('exit', code => process.exit(code ?? 0))
    })
}
