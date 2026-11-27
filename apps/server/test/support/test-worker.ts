/**
 * The test entry: the Worker the Vitest integration runs as `main`. It is the only place test
 * identities and the seed route exist. The deployed entry, src/index.ts, has neither.
 */

import type { ChurchSeed } from '../../src/church-directory.ts'
import type { Authenticate } from '../../src/identity.ts'
import { createWorker } from '../../src/worker.ts'
import { withCaller } from './callers.ts'
import { refusingMailer } from './mailer.ts'

export { Channel, ChurchDirectory, ChurchRegistry } from '../../src/index.ts'

const TEST_IDENTITY = /^Bearer test:([^:]+):([^:]+)$/

/** Accepts `Authorization: Bearer test:<churchId>:<personId>`. */
export const testIdentities: Authenticate = (request) => {
  const match = TEST_IDENTITY.exec(request.headers.get('authorization') ?? '')
  if (match === null) return null
  const [, churchId, personId] = match as unknown as [string, string, string]
  return { churchId, personId }
}

const worker = createWorker({ authenticate: testIdentities, mailer: refusingMailer })

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/__test/seed' && request.method === 'POST') {
      const seed = (await request.json()) as ChurchSeed
      await env.CHURCH_DIRECTORY.getByName(seed.churchId).seed(seed)
      return new Response(null, { status: 204 })
    }
    const asCaller = new Request(request, {
      headers: withCaller(request.headers),
    }) as typeof request
    return worker.fetch?.(asCaller, env, ctx) ?? new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
