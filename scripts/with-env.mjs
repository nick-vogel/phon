#!/usr/bin/env node
// `node scripts/with-env.mjs <profile> [args]`: run one of this repo's fixed
// commands with the local env, from the secrets repo when it is there and from
// the root `.env` when it is not: `pnpm dev:server` (`wrangler dev`) and
// `pnpm dev:app` (`expo start`). `scripts/lib/with-env.mjs` says where the values
// come from, in which order, and why it runs fixed commands only (eng-pipeline#54).
//
// TWO STEPS. The outer step holds no decrypted value: it lays `.env` over the
// shell and spawns the inner step, inside `sops exec-env` when the secrets repo
// holds this project's `local.env`. The inner step checks the names, then runs the
// profile's command. Neither step prints a value.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

import { expectedNames } from './lib/local-env.mjs'
import { runFromRepoRoot } from './lib/repo-root.mjs'
import { runChild } from './lib/run-child.mjs'
import {
  childEnv,
  localEnvSource,
  missingNames,
  outerSpawn,
  profileArgv,
  shadowedNames,
  strayEnvFiles,
} from './lib/with-env.mjs'

const root = runFromRepoRoot()
const SELF = fileURLToPath(import.meta.url)
const argv = process.argv.slice(2)
const inner = argv[0] === '--inner'
const [profile = '', ...args] = inner ? argv.slice(1) : argv

const dotenvPath = join(root, '.env')
const readDotenv = () =>
  existsSync(dotenvPath) ? parseEnv(readFileSync(dotenvPath, 'utf8')) : null

const run = (childCommand, childArgs, env) => {
  const hint =
    childCommand === 'sops'
      ? 'Is it installed? With no secrets repo, a .env from .env.example is enough.'
      : ''
  runChild({ command: childCommand, args: childArgs, cwd: root, env, name: 'with-env', hint })
}

let command
try {
  command = profileArgv({ root, execPath: process.execPath, profile, args })
} catch (error) {
  console.error(`with-env: ${error.message}`)
  process.exit(2)
}

if (inner) {
  // THE INNER STEP: every value has arrived. Names only from here on.
  const expected = expectedNames(readFileSync(join(root, '.env.example'), 'utf8'))
  const missing = missingNames({ expected, env: process.env })
  if (missing.length > 0) {
    console.error(
      'with-env: FAIL: these names from .env.example have no value (an empty value is fine):',
    )
    for (const name of missing) console.error(`  ${name}`)
    console.error(
      '  Add them to the secrets repo file (sops edit, from its root), or to .env with no secrets repo.',
    )
    process.exit(1)
  }
  const shadowed = shadowedNames({ dotenv: readDotenv(), env: process.env })
  if (shadowed.length > 0)
    console.error(`with-env: the secrets repo file wins over .env for ${shadowed.join(', ')}`)
  run(command[0], command.slice(1), process.env)
} else {
  // THE OUTER STEP: no decrypted value here.
  const stray = strayEnvFiles({ root })
  if (stray.length > 0) {
    console.error(
      'with-env: FAIL: wrangler dev or Expo would read these files ahead of the local env:',
    )
    for (const path of stray) console.error(`  ${path}`)
    console.error(
      '  Delete them. The values live in the secrets repo, or in the root .env with no secrets repo.',
    )
    process.exit(1)
  }
  const source = localEnvSource({ root, env: process.env, home: homedir() })
  const envFile = source.exists ? source.file : null
  const dotenv = readDotenv()
  if (envFile === null) {
    console.error(
      `with-env: no ${source.file}, so the values come from ${dotenv ? '.env' : 'the shell alone'}.`,
    )
  }
  const layered = childEnv({ env: process.env, dotenv, sopsFile: envFile !== null })
  if (layered.dropped.length > 0) {
    console.error(
      `with-env: left out of .env, because they are per-lane: ${layered.dropped.join(', ')}`,
    )
  }
  const plan = outerSpawn({ envFile, execPath: process.execPath, self: SELF, profile, args })
  run(plan.command, plan.args, layered.env)
}
