import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  auditLocalEnv,
  exampleNames,
  expectedNames,
  formatAudit,
  interpretChild,
  PER_LANE_NAMES,
  scrubbedEnv,
} from './local-env.mjs'

// eng-pipeline#54. `pnpm env:check`
// decrypts this project's `local.env` from the secrets repo (or lays `.env`
// over) into a child and reports which names arrived. These tests pin the pure half: which
// names are expected, which ones the file must never hold, and that the report
// carries names and never a value. The decrypting half needs the `dev` key, so it
// runs on Nick's Mac and never in CI.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const EXAMPLE = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8')

describe('exampleNames', () => {
  it('reads every name set on its own line', () => {
    expect(exampleNames('A=1\nB=\nC=x=y\n')).toEqual(['A', 'B', 'C'])
  })

  // A commented name documents an option, and nobody reaches it by forgetting a file.
  it('skips a commented name', () => {
    expect(exampleNames('# A=1\n#B=\n  # C=x\nD=1\n')).toEqual(['D'])
  })

  it('skips blank lines and prose', () => {
    expect(exampleNames('\n# ---- Database ----\nnot a line\nA=1\n')).toEqual(['A'])
  })

  // Anti-vacuity: the real file has to yield the names the app reads, or every
  // check below passes against an empty list.
  it('finds the secrets in the real .env.example', () => {
    expect(exampleNames(EXAMPLE)).toEqual([
      'PCO_CLIENT_ID',
      'PCO_CLIENT_SECRET',
      'EMAIL_HASH_KEY',
      'KLIPY_API_KEY',
      'EXPO_PUBLIC_PHON_API_URL',
    ])
  })
})

describe('expectedNames', () => {
  // This repo has no per-lane names: each worktree's `wrangler dev` keeps its
  // Durable Object state in that worktree's own `.wrangler/`.
  it('has no per-lane names', () => {
    expect(PER_LANE_NAMES).toEqual([])
  })

  // The Worker's secrets and the app's setting come from one file, so a
  // local.env without the app's setting fails the check like a missing secret.
  it("expects the server's secrets and the app's setting alike", () => {
    expect(expectedNames(EXAMPLE)).toEqual(exampleNames(EXAMPLE))
  })
})

describe('auditLocalEnv', () => {
  const expected = ['A', 'B']

  it('passes when every expected name arrived', () => {
    const audit = auditLocalEnv({ expected, env: { A: '1', B: '' } })
    expect(audit).toEqual({ ok: true, expectedCount: 2, missing: [], laneNames: [], quoted: [] })
  })

  // An empty value still counts: a clone with no KLIPY key runs all but GIF search.
  it('counts an empty value as present', () => {
    expect(auditLocalEnv({ expected, env: { A: '', B: '' } }).missing).toEqual([])
  })

  it('fails on a missing name, and names it', () => {
    const audit = auditLocalEnv({ expected, env: { A: '1' } })
    expect(audit.ok).toBe(false)
    expect(audit.missing).toEqual(['B'])
  })

  // SOPS gives quotes no special handling, so `EMAIL_HASH_KEY="abc"` arrives with
  // the quotes as part of the value. dotenv used to strip them, so a file made from
  // an old `.env` can change a value without anyone seeing it.
  it('fails on a value wrapped in quotes, and names it', () => {
    const audit = auditLocalEnv({ expected, env: { A: '"1"', B: "'2'" } })
    expect(audit.ok).toBe(false)
    expect(audit.quoted).toEqual(['A', 'B'])
  })

  it('does not call a value with one inner quote a quoted value', () => {
    expect(auditLocalEnv({ expected, env: { A: 'Riverbed <"x">', B: '"' } }).quoted).toEqual([])
  })
})

describe('formatAudit', () => {
  const SECRET = 'do-not-print-this-value'

  it('prints names and never a value', () => {
    const audit = auditLocalEnv({
      expected: ['A', 'B', 'C'],
      env: { A: `"${SECRET}"`, C: SECRET },
    })
    const text = formatAudit(audit)
    expect(text).toContain('A')
    expect(text).toContain('B')
    expect(text).not.toContain(SECRET)
  })

  it('says PASS only on a passing audit', () => {
    const pass = auditLocalEnv({ expected: ['A'], env: { A: '1' } })
    expect(formatAudit(pass, 'phon/local.env')).toMatch(
      /^PASS: phon\/local.env delivers all 1 names/m,
    )
    const fail = auditLocalEnv({ expected: ['A'], env: {} })
    expect(formatAudit(fail)).not.toMatch(/^PASS/m)
  })
})

describe('scrubbedEnv', () => {
  // The decrypting child starts from this, so any expected name it reports can
  // only have come from the file. Without the scrub, an EMAIL_HASH_KEY exported in
  // the shell would hide a file that lacks one.
  it('removes every expected name', () => {
    const env = scrubbedEnv({
      env: { PATH: '/bin', HOME: '/h', EMAIL_HASH_KEY: 'x', KLIPY_API_KEY: 'y' },
      expected: ['EMAIL_HASH_KEY', 'KLIPY_API_KEY'],
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' })
  })

  // The `dev` key lives in the SOPS default key file, so the child needs HOME to
  // find it. Anything that names a key is kept for the same reason.
  it('keeps what SOPS needs to find a key', () => {
    const env = scrubbedEnv({
      env: { HOME: '/h', SOPS_AGE_KEY_FILE: '/k', XDG_CONFIG_HOME: '/c' },
      expected: [],
    })
    expect(env).toEqual({ HOME: '/h', SOPS_AGE_KEY_FILE: '/k', XDG_CONFIG_HOME: '/c' })
  })
})

describe('the scripts that need values run through the env wrapper', () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'))
  const wrapped = (name) => pkg.scripts[name]?.startsWith('node scripts/with-env.mjs ') ?? false

  // CI holds no age key and runs `pnpm lint`, `pnpm typecheck` and `pnpm test`
  // bare: the server tests set their own fixed secrets in vitest.config.ts.
  // `pnpm build` is a `wrangler deploy --dry-run` and an Expo export, and stays
  // bare too. The contrast with the dev scripts is what makes this a rule
  // rather than a snapshot.
  it('wraps the dev scripts and leaves the CI and build scripts bare', () => {
    expect(['dev:server', 'dev:app', 'lint', 'typecheck', 'test', 'build'].map(wrapped)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ])
  })
})

describe('interpretChild', () => {
  const SECRET = 'do-not-print-this-value'

  it('reads the verdict the child printed', () => {
    expect(interpretChild({ status: 0, stdout: '{"audit":{"ok":true}}' })).toEqual({
      verdict: { audit: { ok: true } },
    })
  })

  // sops missing from PATH: the cause surfaces as the spawn error's own code.
  it('names the spawn error when sops cannot run', () => {
    const run = {
      error: Object.assign(new Error('spawn sops ENOENT'), { code: 'ENOENT' }),
      status: null,
    }
    expect(interpretChild(run).failure).toMatch(/could not run sops \(ENOENT\)/)
  })

  // No key, or a file sops cannot decrypt: sops has said why on stderr already,
  // and the exit status is carried through so it is not reported as a pass.
  it('carries the sops exit status when the decrypt fails', () => {
    expect(interpretChild({ status: 128, stdout: '' }).failure).toMatch(/exited 128/)
  })

  it('never echoes a child that printed something other than its verdict', () => {
    const result = interpretChild({ status: 0, stdout: `EMAIL_HASH_KEY=${SECRET}` })
    expect(result.failure).toMatch(/other than its verdict/)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
