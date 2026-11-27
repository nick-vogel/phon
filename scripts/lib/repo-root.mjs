// The checkout this script belongs to, and a way to make every relative path in
// the process resolve against it.
//
// WHY THIS EXISTS, and why it is a chdir rather than a path helper.
//
// One defect class was found FIVE times in Riverbed, which holds the twin of
// this file, in four review
// rounds, each time in a different file: something resolves a path or a target
// from AMBIENT STATE (the caller's working directory or environment) instead of
// from the code's own location. The instances, in order:
//
//   1. `lib/mongo-url.mjs` derived the database from `process.cwd()`.
//   2. Its replacement asked git, and an ambient `GIT_DIR` redirected that.
//   3. `gate-reader-suite.mjs` loaded `.env` and spawned its purge from cwd, which
//      SATISFIED its own fail-closed guard with another checkout's MONGODB_URL.
//   4. `gate-demo-suite.mjs` had the identical defect, one file away.
//   5. Gates that are themselves PARENTS spawn migration scripts from cwd, so
//      anchoring the suites' children was not enough: `gate-folders.mjs`,
//      `gate-read-model.mjs` and `gate-capture-migration.mjs` are run directly,
//      never through a suite, and their children ran against another checkout.
//
// Every one of those was fixed by anchoring the specific path someone had found.
// That is losing: the fix arrives one instance at a time, and instance six is a
// file nobody has opened yet.
//
// So this normalises the CWD ITSELF, once, at the top of a script. After the call,
// every relative path in this process AND IN EVERY CHILD IT SPAWNS resolves
// against this checkout, including the relative paths nobody has audited. It turns
// "remember to anchor each path" into "remember once, at the entry point", and the
// test beside this file checks that every spawning script remembers.
//
// It is a NO-OP in normal use. A `pnpm` script already runs with the repo root
// as its working directory, so this only bites when a script is invoked by
// absolute path from somewhere else, which is precisely the case that was broken.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The root of the checkout this file belongs to. `scripts/lib` is two levels down. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Make this process, and everything it spawns, run in its own checkout.
 *
 * Call it FIRST, before reading a file, loading `.env`, or spawning anything.
 * Returns the root so a caller that also wants the path does not need a second
 * import.
 */
export function runFromRepoRoot() {
  // UNCONDITIONAL, with no `process.cwd() !== REPO_ROOT` guard in front of it.
  // That guard looks like a free optimisation and is not: `process.cwd()` THROWS
  // `ENOENT (uv_cwd)` when the directory the shell started in has been deleted,
  // which is exactly what happens after a neighbouring worktree is torn down. The
  // chdir itself succeeds from a deleted directory, so the guard could only ever
  // turn a working call into a crash.
  process.chdir(REPO_ROOT)
  return REPO_ROOT
}

/**
 * `process.env` with git's discovery variables removed, for spawning git.
 *
 * `cwd:` is NOT enough to aim a git subprocess. `GIT_DIR` overrides cwd-based
 * discovery entirely, so a git command with the right `cwd` still answers for
 * whatever repository `GIT_DIR` names. That is instance 2 in the list above, and
 * git EXPORTS these to hook subprocesses, so any script run from a hook inherits
 * them without anyone setting them by hand.
 *
 * Pass this as `env` whenever spawning git, so the command is aimed by the
 * directory it runs in and nothing else.
 */
export function envWithoutGitDiscovery(env = process.env) {
  const clean = { ...env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
  ]) {
    delete clean[key]
  }
  return clean
}
