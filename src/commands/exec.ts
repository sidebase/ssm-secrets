import { Command } from 'commander'
import { parse } from 'dotenv'
import { listParameters } from '../aws.js'
import { prettifyParameter } from '../utils.js'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SUMMARY = 'Execute the command with the environment from SSM'
const DESCRIPTION = `${SUMMARY}.
This command will fetch the parameters from SSM and provide them as environment variables to the specified command.

The variable names are stripped of path prefix and uppercased.
Example: parameter with path my/app/parameter becomes PARAMETER environment variable.`

interface ExecCommandOptions {
 overwrite: boolean
 ignore: string[] | undefined 
 envFileIfExists: string
}

export function execCommand(program: Command) {
  program
    .command('exec')
    .summary(SUMMARY)
    .description(DESCRIPTION)
    .argument('<path>', 'SSM parameter path')
    .argument('<command>', 'Command to execute')
    .argument('[args...]', 'Arguments for the command. Use -- before command to ensure that arguments are passed correctly: ssm-secrets exec my/path -- command --argument')
    .option(
      '--no-overwrite',
      'Do not overwrite existing environment variables'
    )
    .option(
      '--ignore <ignores...>',
      'Do not include the parameters with the given names to environment. '
      + 'The parameter names are case-sensitive and should match the name inside SSM excluding path prefix. '
      + 'Example: if you want to ignore my/app/parameter1 and my/app/parameter2, use --ignore parameter1 parameter2',
    )
    .option(
      // Inspired by https://nodejs.org/api/cli.html#--env-file-if-existsfile
      '--env-file-if-exists <file>',
      'Load the environment variables from a file relative to the current directory, '
      + 'and make them available to the launched process. '
      + 'The env file variables will always be overwritten by environment variables passed to ssm-secrets',
    )
    .action(async (path: string, command: string, args: string[], options: ExecCommandOptions) => {
      // Normalize options
      const ignore = options.ignore ?? []

      const ssmParameters = await listParameters(path)

      const filteredPrettyParams = ssmParameters
        .map(param => prettifyParameter(param, path))
        .filter(param => param.Name !== undefined && !ignore.includes(param.Name))

      const envs = Object.fromEntries(filteredPrettyParams.map(param => [param.Name?.toUpperCase(), param.Value]))

      // Load .env when requested (if it exists)
      let envFileVars = {}
      try {
        if (options.envFileIfExists) {
          envFileVars = parse(readFileSync(options.envFileIfExists))
        }
      } catch {}

      // Merge into environment
      const env = options.overwrite
        ? {
            ...envFileVars,
            ...process.env,
            ...envs,
          }
        : {
            ...envs,
            ...envFileVars,
            ...process.env,
          }

      // Replace current process
      const child = spawn(command, args, {
        env,
        stdio: 'inherit',
      })

      child.on('exit', code => process.exit(code ?? 0))
    })
}
