#!/usr/bin/env node
// `pnpm env:check`: does the local env deliver what this repo expects?
// eng-pipeline#54. Riverbed's and a church website's
// `scripts/check-local-env.mjs` are its twins.
//
// It audits what `pnpm dev:server` and `pnpm dev:app` would start from: this
// project's `local.env` in the secrets repo (`~/.config/sops/envs/phon/local.env`,
// see `scripts/lib/with-env.mjs`) over the root `.env`, or `.env` alone when there
// is no secrets repo. It asks three things, and prints names only, never a value:
//
//   1. Every name `.env.example` sets arrives.
//   2. No value arrives wrapped in quotes, which SOPS keeps as part of the value.
//   3. No package holds an env file of its own (`apps/server/.dev.vars`,
//      `apps/app/.env.local` and the like), which `wrangler dev` or Expo would
//      read ahead of the local env.
//
// HOW IT KNOWS A NAME CAME FROM THE SOURCE. It runs itself a second time, inside
// `sops exec-env` (or with `.env` laid over), from an environment with every
// expected name removed. Whatever of those the child sees, the source put there.
// The child prints a JSON verdict and this process formats it.
//
// The decrypt is a `sops exec-env` this script spawns. An agent runs
// `pnpm env:check`; it never types `sops`.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

import {
  auditLocalEnv,
  expectedNames,
  formatAudit,
  interpretChild,
  scrubbedEnv,
} from './lib/local-env.mjs'
import { runFromRepoRoot } from './lib/repo-root.mjs'
import { shellQuote } from './lib/shell-quote.mjs'
import { childEnv, localEnvSource, strayEnvFiles } from './lib/with-env.mjs'

const root = runFromRepoRoot()
const SELF = fileURLToPath(import.meta.url)
const expected = expectedNames(readFileSync(join(root, '.env.example'), 'utf8'))

if (process.argv.includes('--report')) {
  // THE CHILD, inside `sops exec-env`. stdout carries the verdict and nothing else.
  process.stdout.write(JSON.stringify({ audit: auditLocalEnv({ expected, env: process.env }) }))
  process.exit(0)
}

// The child starts the way the dev scripts' does: `.env` over the scrubbed shell,
// and the SOPS file on top.
const { file, exists } = localEnvSource({ root, env: process.env, home: homedir() })
const dotenvPath = join(root, '.env')
const dotenv = existsSync(dotenvPath) ? parseEnv(readFileSync(dotenvPath, 'utf8')) : null
const { env: childStart } = childEnv({
  env: scrubbedEnv({ env: process.env, expected }),
  dotenv,
  sopsFile: exists,
})
const reportArgv = [process.execPath, SELF, '--report']
const spawnOptions = {
  cwd: root,
  env: childStart,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}

let source
let run
if (exists) {
  source = dotenv ? `${file} over .env` : file
  run = spawnSync('sops', ['exec-env', file, reportArgv.map(shellQuote).join(' ')], spawnOptions)
} else if (dotenv) {
  source = '.env'
  run = spawnSync(reportArgv[0], reportArgv.slice(1), spawnOptions)
} else {
  console.error(`FAIL: there is no ${file} and no .env in ${root}.`)
  process.exit(1)
}

const { verdict, failure } = interpretChild(run)
if (failure) {
  console.error(failure)
  process.exit(1)
}

console.log(formatAudit(verdict.audit, source))
const stray = strayEnvFiles({ root })
if (stray.length > 0) {
  console.log(
    'FAIL: wrangler dev or Expo would read these files ahead of the local env. Delete them:',
  )
  for (const path of stray) console.log(`  ${path}`)
}
process.exit(verdict.audit.ok && stray.length === 0 ? 0 : 1)
