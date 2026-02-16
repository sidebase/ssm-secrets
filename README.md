# 🗝️ @sidebase/ssm-secrets

<!-- Badges Start -->
<p>
  <a href="https://npmjs.com/package/@sidebase/ssm-secrets">
    <img src="https://img.shields.io/npm/v/@sidebase/ssm-secrets.svg?style=flat-square&colorA=202128&colorB=36936A" alt="Version">
  </a>
  <a href="https://npmjs.com/package/@sidebase/ssm-secrets">
    <img src="https://img.shields.io/npm/dm/@sidebase/ssm-secrets.svg?style=flat-square&colorA=202128&colorB=36936A" alt="Downloads">
  </a>
  <a href="https://github.com/sidebase/ssm-secrets/stargazers">
    <img src="https://img.shields.io/github/stars/sidebase/ssm-secrets.svg?style=flat-square&colorA=202128&colorB=36936A" alt="Downloads">
  </a>
  <a href="https://github.com/sidebase/ssm-secrets/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/sidebase/ssm-secrets.svg?style=flat-square&colorA=202128&colorB=36936A" alt="License">
  </a>
  <a href="https://auth.sidebase.io">
    <img src="https://img.shields.io/badge/Docs-202128?style=flat-square&logo=gitbook&logoColor=DDDDD4" alt="Nuxt Auth">
  </a>
  <a href="https://x.com/sidebase_io">
    <img src="https://img.shields.io/badge/Follow_us-202128?style=flat-square&logo=X&logoColor=DDDDD4" alt="Follow us on X">
  </a>
  <a href="https://discord.gg/NDDgQkcv3s">
    <img src="https://img.shields.io/badge/Join_our_Discord-202128?style=flat-square&logo=discord&logoColor=DDDDD4" alt="Join our Discord">
  </a>
</p>
<!-- Badges End -->

**Simple AWS SSM Secrets Manager CLI**

Securely manage your AWS SSM Parameters — authenticate once via your OS keyring and easily list, get, write, or delete secrets.

## ✨ Features

* 🔐 **Secure local credential storage** using native OS keyrings
  (via [`keyring-node`](https://github.com/Brooooooklyn/keyring-node), powered by [`keyring-rs`](https://github.com/open-source-cooperative/keyring-rs))
* 🧩 **List / get / put / delete** SSM parameters
* 🏃 **Run** commands with environment variables from SSM parameters
* 🧠 **Output formatting** as `.env` or JSON
* 🪄 Works with AWS SSM Parameter Store, recursive listing included
* 🧰 Both **CLI** and **programmatic API** available

## 📦 Installation

Install globally (recommended):

```bash
npm install -g @sidebase/ssm-secrets
```

Or use via `npx`:

```bash
npx ssm-secrets --package @sidebase/ssm-secrets
```

## 🚀 Usage

### General structure

```bash
ssm-secrets <command> [options]
```

Run `ssm-secrets --help` or `ssm-secrets <command> --help` for details.

### 🔐 Authenticate

Store AWS credentials in your system keyring.

```bash
ssm-secrets auth
```

You’ll be prompted for:

```
AWS Region: (default: eu-central-1)
AWS Access Key ID:
AWS Secret Access Key:
```

These are securely saved using your OS’s secret store:

* Linux: Secret Service / GNOME Keyring / KWallet
* macOS: Keychain Access
* Windows: Credential Manager

### 📜 List parameters

List all parameters under a given SSM path.

```bash
ssm-secrets list <path> [--format <env|json>]
```

#### Examples

```bash
ssm-secrets list my/service
ssm-secrets list my/service --format env
```

**Output formats:**

* `json` (default) → structured object (`{"param": "value"}`)
* `env` → shell-style lines suitable for `source` (`PARAM='value'`)

> [!IMPORTANT]
> The parameter names you provide in commands below are case-sensitive and depend on what is stored
> in your [Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html).
>
> You can get the exact parameter names by using the `list` command.

### 🔍 Get a single parameter

Retrieve one parameter by path and name.

```bash
ssm-secrets get <path> <name>
```

Example:

```bash
ssm-secrets get my/service db_password
```

Outputs full JSON metadata from SSM.

### ✏️ Write or update a parameter

Add or update a parameter in SSM.

```bash
ssm-secrets put <path> <name> <value>
```

Aliases:

```bash
ssm-secrets write ...
ssm-secrets set ...
```

Example:

```bash
ssm-secrets put my/service db_password supersecret
```

Displays when successful:

```
✅ Parameter stored with version 3
```

### ❌ Delete a parameter

Remove a parameter from SSM.

```bash
ssm-secrets delete <path> <name>
```

Example:

```bash
ssm-secrets delete my/service db_password
```

Outputs:

```
✅ Parameter deleted
```

### 💿 Execute a command with SSM environment

Fetches all parameters from a given SSM path, transforms them into environment
variables, and executes the provided command with that environment.

Variable names are uppercased and stripped of the path prefix.
Example: `/my/app/parameter` becomes `PARAMETER` environment variable.

```bash
ssm-secrets exec my/app -- node server.js
````

If you need to pass `--argument`s to your command, separate them using a double dash:

```bash
ssm-secrets exec my/app -- node server.js --inspect
```

Options:

* `--no-overwrite`
  Do not overwrite existing environment variables.

* `--ignore <names...>`
  Ignore specific parameter names (case-sensitive, without path prefix).
  Example:

  ```bash
  ssm-secrets exec my/app --ignore FOO bar -- node server.js
  ```

## ⚙️ Programmatic API

You can also use the API directly in Node.js:

```js
import { listParameters, getParameter, putParameter, deleteParameter } from '@sidebase/ssm-secrets'

const secrets = await listParameters('my/service')
console.log(secrets)

await putParameter('my/service', 'DB_PASSWORD', 'supersecret')
```

All functions automatically use the credentials stored via `ssm-secrets auth`.

## 🧩 Environment formats

The CLI supports exporting secrets in `.env`-compatible format:

```bash
ssm-secrets list my/app --format env > .env
```

You can then `source` them in a shell:

```bash
export $(cat .env | xargs)
```

or directly

```bash
source <(ssm-secrets list my/app --format env)
```

## 🔒 Credentials storage

Credentials are stored securely in the system keyring via [`keyring-node`](https://github.com/Brooooooklyn/keyring-node):

| Platform | Backend used                                                         |
| -------- | -------------------------------------------------------------------- |
| Linux    | Secret Service (works with GNOME Keyring / KWallet) |
| macOS    | macOS Keychain                                                       |
| Windows  | Credential Manager                                                   |

Nothing sensitive is stored in plaintext.

## 🧠 Example workflow

```bash
ssm-secrets auth
ssm-secrets put my/app DB_USER myuser
ssm-secrets put my/app DB_PASS mypassword
ssm-secrets list my/app --format env
ssm-secrets exec my/app -- node server.js
```

Output:

```
DB_USER='myuser'
DB_PASS='mypassword'
```

## 🧾 License

MIT
