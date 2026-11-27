import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { callerKey } from '../src/caller-limits.ts'
import deployed from '../src/index.ts'
import {
  fromCaller as from,
  inOneLimitPeriod,
  LIMIT_TEST_TIMEOUT_MS,
  newCallerAddress,
} from './support/callers.ts'
import { asMember, seedChurch } from './support/church.ts'
import { fetchDeployed } from './support/deployed.ts'

/**
 * The limits each caller has on the routes the Worker answers before sign-in (phon#176). The
 * Vitest integration runs the local simulation of the Rate Limiting binding, which counts exactly
 * and in one place; the deployed binding counts approximately and in each Cloudflare location on
 * its own, which no test here can observe.
 */

const limited = {
  status: 429,
  retryAfter: '60',
  cacheControl: 'no-store',
  body: { problem: 'try-again' },
}

async function answerOf(response: Response) {
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    cacheControl: response.headers.get('cache-control'),
    body: await response.json(),
  }
}

/** Every route the Worker answers before it knows who is asking, with the method it takes. */
const ROUTES_BEFORE_SIGN_IN: Array<[method: string, path: string]> = [
  ['GET', '/auth/start'],
  ['GET', '/auth/callback'],
  ['POST', '/auth/session'],
  ['GET', '/auth/connect/start'],
  ['POST', '/auth/connect'],
  ['GET', '/connect/start'],
  ['GET', '/connect/callback'],
  ['POST', '/connect'],
  ['GET', '/churches'],
  ['POST', '/auth/email/code'],
  ['POST', '/auth/email/session'],
  ['POST', '/auth/email/choice'],
  ['POST', '/me/sign-out'],
]

describe('the limit on requests before sign-in', { timeout: LIMIT_TEST_TIMEOUT_MS }, () => {
  it('answers a caller its 101st request in a minute with 429, Retry-After and try again, and another caller as before', async () => {
    await inOneLimitPeriod()
    const caller = newCallerAddress()
    for (let request = 0; request < 100; request += 1) {
      expect((await fetchDeployed('/churches', from(caller))).status).toBe(200)
    }

    expect(await answerOf(await fetchDeployed('/churches', from(caller)))).toEqual(limited)
    expect((await fetchDeployed('/churches', from(newCallerAddress()))).status).toBe(200)
  })

  it('counts every route answered before sign-in in one limit for the caller', async () => {
    await inOneLimitPeriod()
    const caller = newCallerAddress()
    for (let request = 0; request < 100; request += 1) {
      await fetchDeployed('/churches', from(caller))
    }

    for (const [method, path] of ROUTES_BEFORE_SIGN_IN) {
      const answer = await answerOf(await fetchDeployed(path, from(caller, { method })))
      expect({ method, path, ...answer }).toEqual({ method, path, ...limited })
    }
  })

  it('leaves the routes that need sign-in to a caller past its limit', async () => {
    const { churchId } = await seedChurch({
      people: [{ personId: 'ana', name: 'Ana Ortiz' }],
      channels: [],
    })
    await inOneLimitPeriod()
    const caller = newCallerAddress()
    for (let request = 0; request < 101; request += 1) {
      await fetchDeployed('/churches', from(caller))
    }

    expect((await asMember(churchId, 'ana', '/me', from(caller))).status).toBe(200)
  })

  it('counts an IPv6 caller by its /64, so a caller cannot get a new limit by changing the rest of its address', async () => {
    await inOneLimitPeriod()
    const prefix = newCallerAddress().replace(/::1$/, '')
    for (let request = 0; request < 100; request += 1) {
      await fetchDeployed('/churches', from(`${prefix}::${(request + 1).toString(16)}`))
    }

    expect(await answerOf(await fetchDeployed('/churches', from(`${prefix}:ff:ee:dd:cc`)))).toEqual(
      limited,
    )
    expect((await fetchDeployed('/churches', from(newCallerAddress()))).status).toBe(200)
  })

  it('counts every request that names no caller address as one caller', async () => {
    await inOneLimitPeriod()
    const unnamed = async () => {
      const ctx = createExecutionContext()
      const request = new Request('https://phon.test/churches') as Request<
        unknown,
        IncomingRequestCfProperties
      >
      const response = await deployed.fetch?.(request, env, ctx)
      await waitOnExecutionContext(ctx)
      if (response === undefined) throw new Error('The deployed entry has no fetch handler')
      return response
    }
    const statuses = []
    for (let request = 0; request < 101; request += 1) statuses.push((await unnamed()).status)

    expect(statuses).toEqual([...Array(100).fill(200), 429])
  })
})

describe('the caller a request counts for', () => {
  it('is its IPv4 address, whatever the IPv4-mapped IPv6 form', () => {
    expect(callerKey('203.0.113.7')).not.toBe(callerKey('203.0.113.8'))
    expect(callerKey('::ffff:203.0.113.7')).toBe(callerKey('203.0.113.7'))
    expect(callerKey('::FFFF:203.0.113.7')).toBe(callerKey('203.0.113.7'))
    expect(callerKey('0:0:0:0:0:ffff:203.0.113.7')).toBe(callerKey('203.0.113.7'))
  })

  it('is the /64 of an IPv6 address, however the address is written', () => {
    const key = callerKey('2001:db8:0:1:2:3:4:5')

    expect(callerKey('2001:DB8::1:0:0:0:9')).toBe(key)
    expect(callerKey('2001:0db8:0000:0001::')).toBe(key)
    expect(callerKey('2001:db8:0:2::5')).not.toBe(key)
    expect(callerKey('2001:db8::5')).not.toBe(key)
  })

  it('is a caller of its own for an address it cannot read, never one it shares with a readable address or another unreadable one', () => {
    const malformed = [
      '2001:db8::1::2',
      '2001:db8:0:1:2:3:4:5:6',
      '2001:db8:0:1:12345::',
      'bad:203.0.113.7',
    ]
    const keys = malformed.map(callerKey)

    expect(new Set(keys).size).toBe(malformed.length)
    for (const key of keys) {
      for (const readable of [null, '203.0.113.7', '192.0.2.1', '2001:db8:0:1::']) {
        expect(key).not.toBe(callerKey(readable))
      }
    }
  })

  it('is one caller for every request with no address', () => {
    expect(callerKey(null)).toBe(callerKey(''))
    expect(callerKey(null)).not.toBe(callerKey('203.0.113.7'))
  })
})
