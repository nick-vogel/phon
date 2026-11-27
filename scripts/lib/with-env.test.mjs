import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  childEnv,
  localEnvFile,
  localEnvSource,
  missingNames,
  outerSpawn,
  PACKAGE_DIRS,
  PROFILES,
  profileArgv,
  secretsDir,
  shadowedNames,
  strayEnvFiles,
} from './with-env.mjs'

// eng-pipeline#54. This repo's local env lives in the private secrets repo, cloned at
// `~/.config/sops/envs`, as `phon/local.env`. `node scripts/with-env.mjs <profile>` finds it from
// the `name` in package.json, lays the file over the root `.env` over the shell, checks the names
// `.env.example` sets, and runs one fixed command per profile. These tests cover the half that
// decrypts nothing.

const HOME = '/Users/someone'
const NODE = '/opt/node/bin/node'

describe('secretsDir', () => {
  it('is ~/.config/sops/envs by default', () => {
    expect(secretsDir({ env: {}, home: HOME })).toBe(join(HOME, '.config', 'sops', 'envs'))
  })

  it('is SOPS_ENV_DIR when it is set', () => {
    expect(secretsDir({ env: { SOPS_ENV_DIR: '/srv/envs' }, home: HOME })).toBe('/srv/envs')
  })

  it('ignores an empty SOPS_ENV_DIR', () => {
    expect(secretsDir({ env: { SOPS_ENV_DIR: '' }, home: HOME })).toBe(
      join(HOME, '.config', 'sops', 'envs'),
    )
  })
})

describe('localEnvFile', () => {
  // The package name, not the folder, so every lane worktree (phon-242, phon-eng-pipeline-54)
  // reads the same file.
  it('names the project folder from package.json, not from the worktree', () => {
    expect(localEnvFile({ dir: '/srv/envs', pkgName: 'phon' })).toBe('/srv/envs/phon/local.env')
  })

  it('refuses a package name that is not a bare folder name', () => {
    for (const bad of ['', '../phon', '@phon/server', 'Phon App']) {
      expect(() => localEnvFile({ dir: '/srv/envs', pkgName: bad })).toThrow(/package name/)
    }
  })
})

describe('childEnv', () => {
  // The SOPS file is laid on top by `sops exec-env` itself, which sets the decrypted values after
  // the inherited ones. So the wrapper builds only the two lower layers: `.env` over the shell.
  it('lays .env over the shell', () => {
    expect(
      childEnv({
        env: { A: 'shell', B: 'shell' },
        dotenv: { B: 'dotenv', C: 'dotenv' },
        sopsFile: false,
      }),
    ).toEqual({ env: { A: 'shell', B: 'dotenv', C: 'dotenv' }, dropped: [] })
  })

  it('is the shell alone when there is no .env', () => {
    expect(childEnv({ env: { A: 'shell' }, dotenv: null, sopsFile: true })).toEqual({
      env: { A: 'shell' },
      dropped: [],
    })
  })

  // This repo has no per-lane names, so with the SOPS file in use nothing is dropped from `.env`.
  it('drops nothing from .env when the SOPS file is in use, since no name is per-lane', () => {
    const dotenv = { EXPO_PUBLIC_PHON_API_URL: 'http://localhost:8787', A: '1' }
    expect(childEnv({ env: { PATH: '/bin' }, dotenv, sopsFile: true })).toEqual({
      env: { PATH: '/bin', EXPO_PUBLIC_PHON_API_URL: 'http://localhost:8787', A: '1' },
      dropped: [],
    })
  })
})

describe('localEnvSource', () => {
  /** A checkout whose package.json names `phon`, and a secrets repo that may hold its file. */
  function setup({ withFile }) {
    const root = mkdtempSync(join(tmpdir(), 'with-env-root-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'phon' }))
    const dir = mkdtempSync(join(tmpdir(), 'with-env-envs-'))
    if (withFile) {
      mkdirSync(join(dir, 'phon'))
      writeFileSync(join(dir, 'phon', 'local.env'), '')
    }
    return { root, env: { SOPS_ENV_DIR: dir }, dir }
  }

  it("names the project's file in the secrets repo when it exists", () => {
    const { root, env, dir } = setup({ withFile: true })
    expect(localEnvSource({ root, env, home: HOME })).toEqual({
      file: join(dir, 'phon', 'local.env'),
      exists: true,
    })
  })

  it('says the file is absent when the secrets repo does not hold it', () => {
    const { root, env, dir } = setup({ withFile: false })
    expect(localEnvSource({ root, env, home: HOME })).toEqual({
      file: join(dir, 'phon', 'local.env'),
      exists: false,
    })
  })
})

describe('outerSpawn', () => {
  const base = {
    execPath: NODE,
    self: '/repo/scripts/with-env.mjs',
    profile: 'dev:server',
    args: ['--port', '8788'],
  }

  // `sops exec-env` takes one file and one command string for `/bin/sh -c`. The wrapper builds
  // the string itself, so an argument pnpm appends survives.
  it('runs the inner step inside sops exec-env when the secrets repo has the file', () => {
    expect(outerSpawn({ ...base, envFile: '/srv/envs/phon/local.env' })).toEqual({
      command: 'sops',
      args: [
        'exec-env',
        '/srv/envs/phon/local.env',
        `'${NODE}' '/repo/scripts/with-env.mjs' '--inner' 'dev:server' '--port' '8788'`,
      ],
    })
  })

  // An outside clone has no secrets repo and no SOPS, and runs from `.env`.
  it('runs the inner step directly, with no sops, when there is no file', () => {
    expect(outerSpawn({ ...base, envFile: null })).toEqual({
      command: NODE,
      args: ['/repo/scripts/with-env.mjs', '--inner', 'dev:server', '--port', '8788'],
    })
  })

  it('quotes an argument so a quote inside it cannot end the shell string', () => {
    const { args } = outerSpawn({ ...base, envFile: '/f', args: ["a'; env; '"] })
    expect(args[2]).toMatch(/'a'\\''; env; '\\'''$/)
  })
})

describe('profileArgv', () => {
  const root = '/repo'

  // Each runs in its own package, so `wrangler` and `expo` resolve from that package's
  // `node_modules/.bin`, with the arguments pnpm appends last.
  it('runs wrangler dev in the server package for dev:server', () => {
    expect(
      profileArgv({ root, execPath: NODE, profile: 'dev:server', args: ['--port', '8788'] }),
    ).toEqual(['pnpm', '--filter', '@phon/server', 'exec', 'wrangler', 'dev', '--port', '8788'])
  })

  it('runs expo start in the app package for dev:app', () => {
    expect(profileArgv({ root, execPath: NODE, profile: 'dev:app', args: ['--ios'] })).toEqual([
      'pnpm',
      '--filter',
      '@phon/app',
      'exec',
      'expo',
      'start',
      '--ios',
    ])
  })

  // The wrapper runs a fixed command per profile. A command of the caller's choosing, such as
  // `env`, would print every decrypted value.
  it('refuses a profile it does not know', () => {
    expect(() => profileArgv({ root, execPath: NODE, profile: 'env', args: [] })).toThrow(
      /not a profile/,
    )
  })
})

describe('strayEnvFiles', () => {
  /** A checkout with the two package folders, each holding the named files. */
  function checkout(files) {
    const root = mkdtempSync(join(tmpdir(), 'with-env-stray-'))
    for (const dir of PACKAGE_DIRS) mkdirSync(join(root, dir), { recursive: true })
    for (const file of files) writeFileSync(join(root, file), '')
    return root
  }

  // `wrangler dev` reads `.dev.vars` ahead of the process environment, and a `.dev.vars` hides
  // every `.env` file, so a stray one would beat the SOPS file.
  it("names the server's .dev.vars and .env files", () => {
    const root = checkout([
      'apps/server/.dev.vars',
      'apps/server/.dev.vars.staging',
      'apps/server/.env',
      'apps/server/.env.local',
    ])
    expect(strayEnvFiles({ root })).toEqual([
      'apps/server/.dev.vars',
      'apps/server/.dev.vars.staging',
      'apps/server/.env',
      'apps/server/.env.local',
    ])
  })

  // Expo loads `apps/app/.env*` when it bundles, so the app's setting has one source.
  it("names the app's .env files", () => {
    const root = checkout(['apps/app/.env.local', 'apps/app/.env.development'])
    expect(strayEnvFiles({ root })).toEqual(['apps/app/.env.development', 'apps/app/.env.local'])
  })

  it('passes a template, the root .env and an unrelated file', () => {
    const root = checkout([
      'apps/server/.dev.vars.example',
      'apps/app/.env.example',
      '.env',
      'apps/server/.environment.md',
      'apps/server/wrangler.jsonc',
    ])
    expect(strayEnvFiles({ root })).toEqual([])
  })

  it('checks exactly the server and the app', () => {
    expect(PACKAGE_DIRS).toEqual(['apps/server', 'apps/app'])
  })
})

describe('missingNames', () => {
  it('lists the expected names the environment lacks', () => {
    expect(missingNames({ expected: ['A', 'B', 'C'], env: { A: '1', C: '' } })).toEqual(['B'])
  })

  // A clone with no KLIPY key still runs everything but GIF search.
  it('counts an empty value as present', () => {
    expect(missingNames({ expected: ['KLIPY_API_KEY'], env: { KLIPY_API_KEY: '' } })).toEqual([])
  })
})

describe('shadowedNames', () => {
  // A stray `.env` in Nick's checkout never wins over the SOPS file, and the wrapper says so by
  // name when the two disagree.
  it('names each .env value the environment no longer holds', () => {
    expect(
      shadowedNames({ dotenv: { A: 'old', B: 'same' }, env: { A: 'new', B: 'same' } }),
    ).toEqual(['A'])
  })

  it('is empty with no .env', () => {
    expect(shadowedNames({ dotenv: null, env: { A: '1' } })).toEqual([])
  })
})

describe('package.json', () => {
  const scripts = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
  ).scripts

  // The encrypted files live in the secrets repo, so a script that names `sops` or `secrets/`
  // would fail in every checkout.
  it('runs no script through sops directly', () => {
    expect(Object.entries(scripts).filter(([, line]) => /\bsops\b|secrets\//.test(line))).toEqual(
      [],
    )
  })

  // Anti-vacuity: every profile has its script, and each wrapped script names a known profile.
  it('runs every profile, and only a known profile, through the wrapper', () => {
    const wrapped = Object.values(scripts)
      .map((line) => /^node scripts\/with-env\.mjs (\S+)$/.exec(line)?.[1])
      .filter(Boolean)
    expect(wrapped.sort()).toEqual(Object.keys(PROFILES).sort())
  })
})
