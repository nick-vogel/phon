import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { expectedNames } from './local-env.mjs'

// eng-pipeline#54. The paths of `node scripts/with-env.mjs` where it refuses or
// cannot start, run for real. None of them reaches a profile's command, and none
// decrypts anything: each one stops before `sops` runs, or finds no `sops`.

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const WRAPPER = join(REPO_ROOT, 'scripts', 'with-env.mjs')
const EXPECTED = expectedNames(readFileSync(join(REPO_ROOT, '.env.example'), 'utf8'))

/** A PATH that holds this node and nothing else, so `sops` cannot be found. */
function nodeOnlyPath() {
  const dir = mkdtempSync(join(tmpdir(), 'with-env-path-'))
  symlinkSync(process.execPath, join(dir, 'node'))
  return dir
}

/** The shell's environment with every name `.env.example` sets taken out. */
function shellWithoutExpected(extra) {
  const env = { ...process.env, ...extra }
  for (const name of EXPECTED) delete env[name]
  return env
}

const wrapper = (args, env, script = WRAPPER) =>
  spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8' })

/** A copy of this checkout's wrapper, package.json and .env.example, so a test can add files. */
function checkoutCopy() {
  const root = mkdtempSync(join(tmpdir(), 'with-env-copy-'))
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true })
  for (const file of ['package.json', '.env.example'])
    cpSync(join(REPO_ROOT, file), join(root, file))
  for (const dir of ['apps/server', 'apps/app']) mkdirSync(join(root, dir), { recursive: true })
  return root
}

describe('with-env, where it stops', () => {
  it('refuses an unknown profile with exit 2, before it looks for any value', () => {
    const run = wrapper(['env'], process.env)
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/"env" is not a profile/)
  })

  // An outside clone that has not made its `.env` yet: no secrets repo, no
  // `.env`, and nothing in the shell. The inner step's name check is the backstop.
  it.skipIf(existsSync(join(REPO_ROOT, '.env')))(
    'fails with exit 1 and names the missing names when there is no source at all',
    () => {
      const run = wrapper(
        ['dev:server'],
        shellWithoutExpected({ SOPS_ENV_DIR: mkdtempSync(join(tmpdir(), 'no-envs-')) }),
      )
      expect(run.status).toBe(1)
      expect(run.stderr).toMatch(/no .*phon\/local\.env, so the values come from the shell alone/)
      expect(run.stderr).toMatch(/FAIL: these names from \.env\.example have no value/)
      expect(run.stderr).toContain('  PCO_CLIENT_SECRET')
    },
  )

  // The secrets repo holds the file, but this machine has no `sops`.
  it('fails with exit 1 and a hint when the secrets repo has the file and sops is missing', () => {
    const envs = mkdtempSync(join(tmpdir(), 'envs-'))
    mkdirSync(join(envs, 'phon'))
    writeFileSync(join(envs, 'phon', 'local.env'), '')
    const run = wrapper(['dev:server'], {
      ...process.env,
      SOPS_ENV_DIR: envs,
      PATH: nodeOnlyPath(),
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/with-env: could not run sops \(ENOENT\)\. Is it installed\?/)
  })

  // `wrangler dev` would read a package's own env file ahead of the SOPS file, so the wrapper
  // refuses before it looks for a value, and names the file.
  it('fails with exit 1 and names a stray env file in a package', () => {
    const root = checkoutCopy()
    writeFileSync(join(root, 'apps', 'server', '.dev.vars'), 'PCO_CLIENT_ID=stray\n')
    const run = wrapper(['dev:server'], process.env, join(root, 'scripts', 'with-env.mjs'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/would read these files ahead of the local env/)
    expect(run.stderr).toContain('  apps/server/.dev.vars')
    expect(run.stderr).not.toContain('stray')
  })
})
