import type { Parameter } from '@aws-sdk/client-ssm'

type SimplifiedParameter = Pick<Parameter, 'Name' | 'Value'>

/**
 * Simplifies the AWS parameter to just key without path prefix, and value
 */
export function prettifyParameter(parameter: Parameter, pathPrefix: string): SimplifiedParameter {
  const normalizedPath = normalizePath(pathPrefix)
  const name = parameter.Name?.startsWith(normalizedPath)
    ? parameter.Name.slice(normalizedPath.length)
    : parameter.Name

  return {
    Name: name,
    Value: parameter.Value,
  }
}

/**
 * Normalizes AWS parameter path to be surrounded with `/`
 */
export function normalizePath(path: string): string {
  return `${path.startsWith('/') ? '' : '/'}${path}${path.endsWith('/') ? '' : '/'}`
}

/**
 * Normalizes AWS parameter path and name to be usable by commands
 */
export function normalizePathAndName(path: string, name: string): string {
  return `${normalizePath(path)}${name}`
}

/**
 * Formats parameter as an environment variable
 */
export function formatEnv(parameter: SimplifiedParameter): string | undefined {
  if (!parameter.Name) {
    return
  }

  const name = escapeEnvName(parameter.Name).toUpperCase()
  const val = parameter.Value ? escapeEnvValue(parameter.Value) : '\'\''
  return `${name}=${val}`
}

function escapeEnvName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return name
  }
  // quote the name
  return `"${name}"`
}

// Adapted from https://github.com/xxorax/node-shell-escape
function escapeEnvValue(value: string): string {
  let s = value
  if (/[^A-Za-z0-9_/:=-]/.test(s)) {
    s = `'${s.replaceAll('\'', String.raw`'\''`)}'`
    s = s.replaceAll(/^(?:'')+/g, '') // unduplicate single-quote at the beginning
      .replaceAll('\\\\\'\'\'', String.raw`\'`) // remove non-escaped single-quote if there are enclosed between 2 escaped
  }
  return s
}
