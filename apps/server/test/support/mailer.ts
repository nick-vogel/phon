import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { Mailer } from '../../src/mailer.ts'
import { sessions } from '../../src/session.ts'
import { createWorker } from '../../src/worker.ts'
import { withCaller } from './callers.ts'
import { DEPLOYED_ORIGIN } from './deployed.ts'

/**
 * Mailers for tests. No test sends a real email: a Worker that should send none gets the refusing
 * mailer, and an email sign-in test a recording or a held one.
 */

/** A mailer that fails the test it runs in: for Workers that should never send an email. */
export const refusingMailer: Mailer = async () => {
  throw new Error('no email in this test')
}

/** A mailer that keeps every message it was given, in order. */
export function recordingMailer() {
  const messages: EmailMessageBuilder[] = []
  const mailer: Mailer = async (message) => {
    messages.push(structuredClone(message))
  }
  return {
    mailer,
    /** Every message sent so far, in order. */
    sent(): EmailMessageBuilder[] {
      return [...messages]
    },
  }
}

/** The 6-digit code on the first line of a message's text part. Throws when there is none. */
export function codeIn(message: EmailMessageBuilder | undefined): string {
  const firstLine = message?.text?.split('\n')[0] ?? ''
  if (!/^\d{6}$/.test(firstLine)) throw new Error(`No code first in the text part: ${firstLine}`)
  return firstLine
}

/**
 * A mailer whose send stays pending until the test settles it: `release()` completes the send and
 * `fail()` rejects it. It records each message when it is handed over, before the send settles.
 */
export function heldMailer() {
  const messages: EmailMessageBuilder[] = []
  let markCalled = () => {}
  const called = new Promise<void>((resolve) => {
    markCalled = resolve
  })
  let settle: { resolve: () => void; reject: (error: Error) => void } = {
    resolve: () => {},
    reject: () => {},
  }
  const held = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // A failed send no one handed over is not this mailer's unhandled rejection.
  held.catch(() => {})
  const mailer: Mailer = (message) => {
    messages.push(structuredClone(message))
    markCalled()
    return held
  }
  return {
    mailer,
    /** Resolves when the Worker hands over its first message. */
    called,
    /** Lets the held send complete. */
    release(): void {
      settle.resolve()
    },
    /** Makes the held send fail. */
    fail(error: Error = new Error('the send failed')): void {
      settle.reject(error)
    },
    /** Every message handed over so far, in order. */
    sent(): EmailMessageBuilder[] {
      return [...messages]
    },
  }
}

/**
 * Starts one request through a Worker built the way the deployed entry builds it (Phon sessions)
 * but with the given mailer, as a new caller unless the test names one, without waiting for what it handed to `waitUntil`: `answer` is the
 * response as soon as the Worker returns it, and `settled()` waits for everything else.
 */
export function startWith(
  mailer: Mailer,
  path: string,
  init: RequestInit = {},
  bindings: Env = env,
): { answer: Promise<Response>; settled: () => Promise<void> } {
  const worker = createWorker({ authenticate: sessions, mailer })
  const ctx = createExecutionContext()
  const request = new Request(`${DEPLOYED_ORIGIN}${path}`, {
    ...init,
    headers: withCaller(init.headers),
  }) as Request<unknown, IncomingRequestCfProperties>
  const answer = (async () => {
    const response = await worker.fetch?.(request, bindings, ctx)
    if (response === undefined) throw new Error('The Worker has no fetch handler')
    return response
  })()
  return { answer, settled: () => waitOnExecutionContext(ctx) }
}

/**
 * Runs one request through a Worker built the way the deployed entry builds it (Phon sessions)
 * but with the given mailer, and waits for everything it handed to `waitUntil`.
 */
export async function fetchWith(
  mailer: Mailer,
  path: string,
  init: RequestInit = {},
  bindings: Env = env,
): Promise<Response> {
  const { answer, settled } = startWith(mailer, path, init, bindings)
  const response = await answer
  await settled()
  return response
}
