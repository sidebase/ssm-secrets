import { spawn } from 'node:child_process'

export function openHttpsUrl(url: string): boolean {
  if (!isSafeHttpsUrl(url)) {
    return false
  }

  const command = getOpenCommand(url)
  if (!command) {
    return false
  }

  try {
    const child = spawn(command.command, command.args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  }
  catch {
    return false
  }
}

export function isSafeHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  }
  catch {
    return false
  }
}

function getOpenCommand(url: string): { args: string[], command: string } | undefined {
  if (process.platform === 'darwin') {
    return { args: [url], command: 'open' }
  }

  if (process.platform === 'win32') {
    return { args: ['/c', 'start', '""', url], command: 'cmd' }
  }

  if (process.platform === 'linux') {
    return { args: [url], command: 'xdg-open' }
  }

  return undefined
}
