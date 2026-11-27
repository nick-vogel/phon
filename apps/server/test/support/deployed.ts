import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import deployed from '../../src/index.ts'
import { withCaller } from './callers.ts'

/** The origin every test request is sent to. */
export const DEPLOYED_ORIGIN = 'https://phon.test'

/**
 * Sends a request to the deployed entry, src/index.ts, rather than the test entry. The handler is
 * called directly, so a redirect comes back as the 302 itself and a test can read its `Location`.
 * It runs on the Worker's own bindings unless the test gives it others, and as a new caller unless
 * the test names one.
 */
export async function fetchDeployed(
  path: string,
  init: RequestInit = {},
  bindings: Env = env,
): Promise<Response> {
  const ctx = createExecutionContext()
  const request = new Request(`${DEPLOYED_ORIGIN}${path}`, {
    ...init,
    headers: withCaller(init.headers),
  }) as Request<unknown, IncomingRequestCfProperties>
  const response = await deployed.fetch?.(request, bindings, ctx)
  await waitOnExecutionContext(ctx)
  if (response === undefined) throw new Error('The deployed entry has no fetch handler')
  return response
}

/**
 * Runs one tick of the deployed entry's Cron Trigger, the roster sync, and waits until it and
 * everything it handed to `waitUntil` have finished.
 */
export async function runScheduled(): Promise<void> {
  const ctx = createExecutionContext()
  const controller = createScheduledController({ cron: '*/15 * * * *' })
  if (deployed.scheduled === undefined)
    throw new Error('The deployed entry has no scheduled handler')
  await deployed.scheduled(controller, env, ctx)
  await waitOnExecutionContext(ctx)
}
