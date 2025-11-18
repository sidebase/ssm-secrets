#!/usr/bin/env node
import { Command } from 'commander'
import packageJson from '../package.json' with { type: 'json' }
import { authCommand } from './commands/auth.js'
import { listCommand } from './commands/list.js'
import { getCommand } from './commands/get.js'
import { putCommand } from './commands/put.js'
import { deleteCommand } from './commands/delete.js'
import { execCommand } from './commands/exec.js'

const program = new Command()
program.name('ssm-secrets').description('Simple AWS SSM secrets manager CLI').version(packageJson.version)

authCommand(program)
listCommand(program)
getCommand(program)
putCommand(program)
deleteCommand(program)
execCommand(program)

try {
  await program.parseAsync(process.argv)
}
catch (error) {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`)
  }
  else {
    throw error
  }
  process.exit(1)
}
