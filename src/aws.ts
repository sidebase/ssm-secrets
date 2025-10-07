import type { Parameter } from '@aws-sdk/client-ssm'
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient, paginateGetParametersByPath } from '@aws-sdk/client-ssm'
import { getCredentials } from './keyring.js'
import { normalizePath, normalizePathAndName } from './utils.js'

export function getClient(): SSMClient {
  const credentials = getCredentials()

  return new SSMClient({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    }, region: credentials.region,
  })
}

export async function listParameters(path: string): Promise<Parameter[]> {
  const client = getClient()
  const paginator = paginateGetParametersByPath({ client }, {
    Path: normalizePath(path),
    Recursive: true,
    WithDecryption: true,
  })

  const results: Parameter[] = []
  for await (const page of paginator) {
    if (page.Parameters) {
      results.push(...page.Parameters)
    }
  }
  return results
}

/**
 * Reads a parameter from SSM by a given path and name.
 */
export async function getParameter(path: string, name: string): Promise<Parameter | undefined> {
  const client = getClient()
  const cmd = new GetParameterCommand({
    Name: normalizePathAndName(path, name),
    WithDecryption: true,
  })
  const res = await client.send(cmd)
  return res.Parameter
}

/**
 * Writes a parameter to SSM by given path and name, setting the value.
 * @returns A number indicating the version of the parameter returned by SSM.
 */
export async function putParameter(path: string, name: string, value: string): Promise<number | undefined> {
  const client = getClient()
  const cmd = new PutParameterCommand({
    Name: normalizePathAndName(path, name), Overwrite: true, Type: 'SecureString', Value: value,
  })
  const res = await client.send(cmd)
  return res.Version
}

/**
 * Deletes the parameter from SSM by given path and name.
 */
export async function deleteParameter(path: string, name: string) {
  const client = getClient()
  const cmd = new DeleteParameterCommand({
    Name: normalizePathAndName(path, name),
  })
  await client.send(cmd)
}
