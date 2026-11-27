/**
 * A Vitest reporter for the phon#138 stall loop. It writes one JSON line per test case to the file
 * `STALL_LOG` names (stdout when unset): the copy's id from `STALL_COPY`, the case's position in
 * the file, its wall-clock start and its duration, so the cases of copies that run at once can be
 * lined up on one time axis. `stall-loop.mjs` passes it with `--reporter`, so the test file carries
 * no instrumentation.
 *
 * The start is the Vitest runner's own, taken inside workerd. workerd's clock only moves at I/O, so
 * it reads the moment the case's first I/O began, which is close enough to line copies up.
 */
import { appendFileSync } from 'node:fs'

/** The part of Vitest 5's `TestCase` the reporter reads (`vitest/node`). */
interface TestCase {
  name: string
  result(): { state: string }
  diagnostic(): { startTime: number; duration: number } | undefined
}

export default class StallReporter {
  private position = 0
  private readonly copy = process.env.STALL_COPY ?? '0'
  private readonly log = process.env.STALL_LOG

  onTestCaseResult(testCase: TestCase) {
    this.position += 1
    const diagnostic = testCase.diagnostic()
    const line = JSON.stringify({
      copy: this.copy,
      position: this.position,
      start: diagnostic?.startTime ?? null,
      duration: diagnostic?.duration ?? null,
      state: testCase.result().state,
      reported: Date.now(),
      name: testCase.name,
    })
    if (this.log === undefined) process.stdout.write(`${line}\n`)
    else appendFileSync(this.log, `${line}\n`)
  }
}
