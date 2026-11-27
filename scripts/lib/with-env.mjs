// The pieces of `node scripts/with-env.mjs <profile> [args]`, separated from the
// spawn so they can be tested without decrypting anything (eng-pipeline#54).
// Riverbed's and a church website's `scripts/lib/with-env.mjs` are its
// twins, so a fix belongs in all three.
//
// WHERE THE VALUES COME FROM. This repo's encrypted env files live in the private
// secrets repo, cloned at `~/.config/sops/envs` (`SOPS_ENV_DIR` overrides it), in
// a folder named after the `name` in package.json: `phon/local.env`. The name,
// not the worktree folder, so every lane worktree reads the same file. The
// standard is `~/.claude/docs/secrets.md`.
//
// THE ORDER, highest first: that SOPS file, then the root `.env`, then the shell. The
// wrapper lays `.env` over the shell itself, then runs its inner step inside
// `sops exec-env`, which sets the decrypted values after the inherited ones. So a
// stray `.env` never wins over the SOPS file. With the SOPS file in use, the
// per-lane names are dropped from `.env`; this repo has none (`local-env.mjs`
// says why), so nothing is dropped. An outside clone has no secrets repo and runs
// from a root `.env` copied from `.env.example`, every name of it, with no SOPS
// installed.
//
// NO ENV FILE IN A PACKAGE. `wrangler dev` reads `apps/server/.dev.vars` or
// `apps/server/.env*` ahead of the environment the wrapper builds, and Expo reads
// `apps/app/.env*` too. So the outer step refuses to run while one is there
// (`strayEnvFiles`), and the root `.env` is the one plaintext fallback.
//
// THE INNER STEP checks that every name `.env.example` sets has arrived, less the
// per-lane ones (`PER_LANE_NAMES` in `local-env.mjs`), and names each missing
// one without its value. Then it runs the profile's fixed command.
//
// IT RUNS FIXED COMMANDS ONLY. The inner step holds every decrypted value, so it
// runs one command per profile, with the arguments pnpm appends. A command of
// the caller's choosing, such as `env`, would print them all.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PER_LANE_NAMES } from './local-env.mjs'
import { shellQuote } from './shell-quote.mjs'

const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/

/** The secrets repo checkout: `SOPS_ENV_DIR`, or `~/.config/sops/envs`. */
export function secretsDir({ env = process.env, home }) {
  return env.SOPS_ENV_DIR || join(home, '.config', 'sops', 'envs')
}

/** This project's local file in the secrets repo. Throws on a package name that is not a bare folder name. */
export function localEnvFile({ dir, pkgName }) {
  if (!PACKAGE_NAME.test(pkgName ?? '')) {
    throw new Error(
      `the package name ${JSON.stringify(pkgName)} is not a bare folder name in the secrets repo.`,
    )
  }
  return join(dir, pkgName, 'local.env')
}

/**
 * This checkout's local file in the secrets repo, named from the `name` in its
 * package.json: `{ file, exists }`.
 */
export function localEnvSource({ root, env = process.env, home }) {
  const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
  const file = localEnvFile({ dir: secretsDir({ env, home }), pkgName })
  return { file, exists: existsSync(file) }
}

/**
 * The environment the inner step starts from, before SOPS: `.env` over the
 * shell. With the SOPS file in use (`sopsFile`), the per-lane names are left out
 * of `.env` and returned in `dropped`, so a stray one never beats the derived
 * per-worktree value. A per-lane name typed in the shell still gets through.
 */
export function childEnv({ env, dotenv, sopsFile }) {
  const layer = { ...(dotenv ?? {}) }
  const dropped = []
  if (sopsFile) {
    for (const name of PER_LANE_NAMES) {
      if (Object.hasOwn(layer, name)) {
        dropped.push(name)
        delete layer[name]
      }
    }
  }
  return { env: { ...env, ...layer }, dropped }
}

/**
 * Each profile's fixed command, as an argument list, with pnpm's appended
 * arguments last. Each runs in its own package through `pnpm --filter ... exec`,
 * so `wrangler` and `expo` resolve from that package's `node_modules/.bin`.
 */
export const PROFILES = Object.freeze({
  'dev:server': ({ args }) => [
    'pnpm',
    '--filter',
    '@phon/server',
    'exec',
    'wrangler',
    'dev',
    ...args,
  ],
  'dev:app': ({ args }) => ['pnpm', '--filter', '@phon/app', 'exec', 'expo', 'start', ...args],
})

/** The package folders whose own env files would win over the wrapper. */
export const PACKAGE_DIRS = Object.freeze(['apps/server', 'apps/app'])

const STRAY_ENV_FILE = /^\.(dev\.vars|env)(\..+)?$/

/**
 * The env files in a package folder that `wrangler dev` or Expo would read
 * ahead of the wrapper's environment, as repo-relative paths. A `*.example`
 * file is a template, not a value, so it is not one.
 */
export function strayEnvFiles({ root }) {
  const stray = []
  for (const dir of PACKAGE_DIRS) {
    if (!existsSync(join(root, dir))) continue
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (STRAY_ENV_FILE.test(name) && !name.endsWith('.example')) stray.push(`${dir}/${name}`)
    }
  }
  return stray
}

/** The argument list a profile runs. Throws on an unknown profile. */
export function profileArgv({ root, execPath, profile, args }) {
  if (!Object.hasOwn(PROFILES, profile)) {
    throw new Error(
      `${JSON.stringify(profile)} is not a profile. Use one of: ${Object.keys(PROFILES).join(', ')}.`,
    )
  }
  return PROFILES[profile]({ root, execPath, args })
}

/**
 * What the outer step spawns: the inner step inside `sops exec-env` when the
 * secrets repo holds `envFile`, or the inner step directly when `envFile` is null.
 */
export function outerSpawn({ envFile, execPath, self, profile, args }) {
  const inner = [self, '--inner', profile, ...args]
  if (envFile === null) return { command: execPath, args: inner }
  return {
    command: 'sops',
    args: ['exec-env', envFile, [execPath, ...inner].map(shellQuote).join(' ')],
  }
}

/** The expected names the environment lacks. An empty value counts as present. */
export function missingNames({ expected, env }) {
  return expected.filter((name) => env[name] === undefined)
}

/** The `.env` names whose value the environment no longer holds, because the SOPS file set them. */
export function shadowedNames({ dotenv, env }) {
  if (!dotenv) return []
  // The per-lane names never come from the SOPS file; the outer step left them out.
  return Object.keys(dotenv).filter(
    (name) => !PER_LANE_NAMES.includes(name) && env[name] !== dotenv[name],
  )
}
