import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { ChannelList, EmailNameChoice, SignInSession } from '@phon/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fromCaller,
  inOneLimitPeriod,
  LIMIT_TEST_TIMEOUT_MS,
  newCallerAddress,
} from './support/callers.ts'
import { fetchDeployed, runScheduled } from './support/deployed.ts'
import { asSession, connectSyncAccount, pcoChurchId, signIn } from './support/flows.ts'
import type { FakeJsonApiOptions } from './support/json-api.ts'
import {
  codeIn,
  fetchWith,
  heldMailer,
  recordingMailer,
  refusingMailer,
  startWith,
} from './support/mailer.ts'
import { network } from './support/network.ts'
import { birthdateFor, fakeEmails } from './support/people.ts'
import {
  fakePlanningCenter,
  newOrganizationId,
  PLANNING_CENTER,
} from './support/planning-center.ts'
import { type FakeServicesPerson, fakeServices } from './support/services.ts'

const ada: FakeServicesPerson = { id: 'ada', name: 'Ada Brandt' }
const kit: FakeServicesPerson = { id: 'kit', name: 'Kit Mensah', birthdate: birthdateFor(12) }

/**
 * A connected church whose roster sync has run once: Ada on the Worship team unless told, and the
 * People emails list empty until the test puts addresses on profiles. `emailsOptions.rateLimit` is
 * the rate limit the emails list's headers report.
 */
async function syncedChurch(
  members: FakeServicesPerson[] = [ada],
  planningCenter = fakePlanningCenter(),
  emailsOptions: { rateLimit?: FakeJsonApiOptions['rateLimit'] } = {},
) {
  const organizationId = newOrganizationId()
  const services = fakeServices(planningCenter, {
    syncPersonId: 'sync',
    teams: [{ id: '21', name: 'Worship', members, leaders: [] }],
  })
  const emails = fakeEmails(planningCenter, { syncPersonId: 'sync', ...emailsOptions })
  const connect = await connectSyncAccount(planningCenter, {
    organizationId,
    personId: 'sync',
    administrator: true,
  })
  expect(connect.session.status).toBe(204)
  await runScheduled()
  return { planningCenter, services, emails, organizationId, churchId: pcoChurchId(organizationId) }
}

function post(path: string, body: unknown): RequestInit & { path: string } {
  return {
    path,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** Makes a church's stored sync token one that expires in a minute, inside the refresh margin. */
async function expireSyncToken(churchId: string): Promise<void> {
  await runInDurableObject(env.CHURCH_DIRECTORY.getByName(churchId), (_directory, state) => {
    state.storage.sql.exec(
      'UPDATE sync_connection SET expires_at = ? WHERE church_id = ?',
      Date.now() + 60_000,
      churchId,
    )
  })
}

/** The sync token refreshes sent to Planning Center since the `from`-th recorded call. */
function refreshesSince(from: number) {
  return network
    .calls()
    .slice(from)
    .filter(
      (call) =>
        call.url === `${PLANNING_CENTER}/oauth/token` &&
        new URLSearchParams(call.body ?? '').get('grant_type') === 'refresh_token',
    )
}

/** `POST /auth/email/code` through a Worker with the given recording mailer. */
function requestCode(
  outbox: ReturnType<typeof recordingMailer>,
  churchId: string,
  address: string,
): Promise<Response> {
  const { path, ...init } = post('/auth/email/code', { churchId, address })
  return fetchWith(outbox.mailer, path, init)
}

describe('asking for an email sign-in code', () => {
  it('sends a known address exactly one email, the 6-digit code first in the text and in the HTML, never in the subject', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const outbox = recordingMailer()

    const response = await requestCode(outbox, churchId, 'ada@example.org')

    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
    const sent = outbox.sent()
    expect(sent).toHaveLength(1)
    const message = sent[0]
    expect(message?.to).toBe('ada@example.org')
    expect(message?.from).toEqual({ email: 'sign-in@phon.chat', name: 'Phon' })
    expect(message?.subject).toBe('Your Phon sign-in code')
    expect(message?.subject).not.toMatch(/\d/)
    const code = codeIn(message)
    expect(code).toMatch(/^\d{6}$/)
    expect(message?.html).toContain(code)
    expect(message?.html?.indexOf(code)).toBeLessThan(message?.html?.indexOf('sign-in code') ?? -1)
  })

  it('never refreshes the sync token at the same time as a sync tick, so neither is refused', async () => {
    // A refresh that takes a while, as a real one does, so the other caller arrives during it.
    const planningCenter = fakePlanningCenter({ refreshDelayMs: 50 })
    const { emails, churchId } = await syncedChurch([ada], planningCenter)
    emails.hold('ada', 'ada@example.org')
    const outbox = recordingMailer()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // The request and the tick both find the token about to expire, and Planning Center refuses
      // a refresh token used twice.
      await expireSyncToken(churchId)
      const before = network.calls().length
      const [response] = await Promise.all([
        requestCode(outbox, churchId, 'ada@example.org'),
        runScheduled(),
      ])

      expect(response.status).toBe(204)
      expect(outbox.sent().map((message) => message.to)).toEqual(['ada@example.org'])
      expect(refreshesSince(before)).toHaveLength(1)
      expect(logged).not.toHaveBeenCalled()

      // The pair the one refresh stored is the live one: the next refresh is not refused.
      await expireSyncToken(churchId)
      const next = network.calls().length
      await runScheduled()
      expect(refreshesSince(next)).toHaveLength(1)
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

/** Everything a requester can read of an answer: its status, its headers and its body. */
async function seen(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  }
}

/** What a known address's request answers, read once from a church of its own. */
async function knownAnswer() {
  const { emails, churchId } = await syncedChurch()
  emails.hold('ada', 'ada@example.org')
  const outbox = recordingMailer()
  const answer = await seen(await requestCode(outbox, churchId, 'ada@example.org'))
  expect(outbox.sent()).toHaveLength(1)
  return answer
}

describe('an address the church does not know', () => {
  it.each([
    [
      'an address on no profile',
      async () => {
        const { churchId } = await syncedChurch()
        return { churchId, address: 'nobody@example.org' }
      },
    ],
    [
      'a blocked address',
      async () => {
        const { emails, churchId } = await syncedChurch()
        emails.hold('ada', 'ada@example.org', { blocked: true })
        return { churchId, address: 'ada@example.org' }
      },
    ],
    [
      'the address of a person who left',
      async () => {
        const { emails, services, churchId } = await syncedChurch()
        emails.hold('ada', 'ada@example.org')
        services.removeMember('21', 'ada')
        await runScheduled()
        return { churchId, address: 'ada@example.org' }
      },
    ],
    [
      'the address of a person under 13',
      async () => {
        const { emails, churchId } = await syncedChurch([ada, kit])
        emails.hold('kit', 'kit@example.org')
        return { churchId, address: 'kit@example.org' }
      },
    ],
  ])('gets the answer a known address gets, and no email: %s', async (_name, arrange) => {
    const known = await knownAnswer()
    const { churchId, address } = await arrange()
    const outbox = recordingMailer()

    const answer = await seen(await requestCode(outbox, churchId, address))

    expect(answer).toEqual(known)
    expect(outbox.sent()).toEqual([])
  })

  it('gets the answer a known address gets at a church that is not connected, with no Planning Center call', async () => {
    const known = await knownAnswer()
    const before = network.calls().length
    const outbox = recordingMailer()

    const answer = await seen(
      await requestCode(outbox, pcoChurchId(newOrganizationId()), 'ada@example.org'),
    )

    expect(answer).toEqual(known)
    expect(outbox.sent()).toEqual([])
    expect(
      network
        .calls()
        .slice(before)
        .filter((call) => call.url.startsWith(PLANNING_CENTER)),
    ).toEqual([])
  })
  it('answers any number of requests at a church that is not connected the way it answers a known address, and writes nothing in its directory, even after a roster sync tick', async () => {
    const known = await knownAnswer()
    const churchId = pcoChurchId(newOrganizationId())
    const outbox = recordingMailer()

    for (let i = 0; i < 61; i += 1) {
      expect(await seen(await requestCode(outbox, churchId, `stranger-${i}@example.org`))).toEqual(
        known,
      )
    }
    await runScheduled()

    expect(outbox.sent()).toEqual([])
    const tables = await runInDurableObject(
      env.CHURCH_DIRECTORY.getByName(churchId),
      (_directory, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
          )
          .toArray()
          .map((row) => row.name),
    )
    expect(tables).toEqual([])
  })
})

/** `POST /auth/email/session`, which needs no mailer: any send fails the test. */
function checkCode(churchId: string, address: string, code: string): Promise<Response> {
  const { path, ...init } = post('/auth/email/session', { churchId, address, code })
  return fetchWith(refusingMailer, path, init)
}

/** A code other than the given one. */
function otherThan(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0')
}

describe('a known address', () => {
  it('gets a code when it is not the primary address on the profile', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada.brandt@example.org')
    emails.hold('ada', 'ada@work.example.org', { primary: false })
    const outbox = recordingMailer()

    expect((await requestCode(outbox, churchId, 'ada@work.example.org')).status).toBe(204)

    expect(outbox.sent().map((message) => message.to)).toEqual(['ada@work.example.org'])
  })

  it('gets no code for a record Planning Center answers with another address', async () => {
    const tess: FakeServicesPerson = { id: 'tess', name: 'Tess Brandt' }
    const { emails, churchId } = await syncedChurch([ada, tess])
    emails.hold('tess', 'tess@example.org')
    emails.matchLoosely()
    const outbox = recordingMailer()

    expect((await requestCode(outbox, churchId, 'ada@example.org')).status).toBe(204)

    expect(outbox.sent()).toEqual([])
  })

  it("gets the lookup sent with its own church's sync account token and the User-Agent", async () => {
    const planningCenter = fakePlanningCenter()
    // Another church connected on the same Planning Center, whose token must never be sent.
    const other = await connectSyncAccount(planningCenter, {
      organizationId: newOrganizationId(),
      personId: 'other-sync',
      administrator: true,
    })
    expect(other.session.status).toBe(204)
    const { emails, churchId } = await syncedChurch([ada], planningCenter)
    emails.hold('ada', 'ada@example.org')
    const before = network.calls().length

    await requestCode(recordingMailer(), churchId, 'ada@example.org')

    const lookups = network
      .calls()
      .slice(before)
      .filter((call) => call.url.startsWith(`${PLANNING_CENTER}/people/v2/emails`))
    expect(lookups).toHaveLength(1)
    expect(new URL(lookups[0]?.url ?? '').searchParams.get('where[address]')).toBe(
      'ada@example.org',
    )
    expect(lookups[0]?.headers.authorization).toBe(`Bearer ${planningCenter.accessTokenOf('sync')}`)
    expect(lookups[0]?.headers.authorization).not.toBe(
      `Bearer ${planningCenter.accessTokenOf('other-sync')}`,
    )
    expect(lookups[0]?.headers['user-agent']).toBe('Phon (https://phon.chat)')
  })
})

describe('a send that fails', () => {
  it('gets the answer a sent code gets, so a failure never tells that the address is known', async () => {
    const known = await knownAnswer()
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const { path, ...init } = post('/auth/email/code', { churchId, address: 'ada@example.org' })

    const answer = await seen(await fetchWith(refusingMailer, path, init))

    expect(answer).toEqual(known)
  })
})

/** Whether `answer` settles within `ms` milliseconds: the response, or `'held'` when it does not. */
function within<T>(answer: Promise<T>, ms: number): Promise<T | 'held'> {
  return Promise.race([
    answer,
    new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), ms)),
  ])
}

describe("a known address's answer and its send", () => {
  it('answers before the send finishes, so the send time never tells that the address is known', async () => {
    const known = await knownAnswer()
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const outbox = heldMailer()
    const { path, ...init } = post('/auth/email/code', { churchId, address: 'ada@example.org' })

    const { answer, settled } = startWith(outbox.mailer, path, init)
    try {
      await outbox.called
      const early = await within(answer, 500)

      expect(early).not.toBe('held')
      if (early === 'held') return
      expect(await seen(early)).toEqual(known)
    } finally {
      outbox.release()
      await answer
      await settled()
    }
    const sent = outbox.sent()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('ada@example.org')
    expect(codeIn(sent[0])).toMatch(/^\d{6}$/)
  })

  it('logs a send that fails after the answer, and the answer stays the one a sent code gets', async () => {
    const known = await knownAnswer()
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const outbox = heldMailer()
    const failure = new Error('the send failed')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { path, ...init } = post('/auth/email/code', { churchId, address: 'ada@example.org' })

    try {
      const { answer, settled } = startWith(outbox.mailer, path, init)
      await outbox.called
      outbox.fail(failure)

      expect(await seen(await answer)).toEqual(known)
      await expect(settled()).resolves.toBeUndefined()
      expect(logged).toHaveBeenCalledWith(
        `Sending an email sign-in code for ${churchId} failed`,
        failure,
      )
    } finally {
      logged.mockRestore()
    }
  })
})

describe('a malformed code request', () => {
  it.each([
    ['a body that is not JSON', 'not json'],
    ['no address', JSON.stringify({ churchId: 'pco-1' })],
    ['an address with no @', JSON.stringify({ churchId: 'pco-1', address: 'ada.example.org' })],
    ['an address with two @', JSON.stringify({ churchId: 'pco-1', address: 'a@b@example.org' })],
    [
      'an address too long',
      JSON.stringify({ churchId: 'pco-1', address: `${'a'.repeat(250)}@b.org` }),
    ],
    ['a church ID with a slash', JSON.stringify({ churchId: 'pco/1', address: 'ada@example.org' })],
  ])(
    'gets the answer a known address gets, with no Planning Center call: %s',
    async (_name, body) => {
      const known = await knownAnswer()
      const before = network.calls().length

      const answer = await seen(
        await fetchWith(refusingMailer, '/auth/email/code', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      )

      expect(answer).toEqual(known)
      expect(network.calls().slice(before)).toEqual([])
    },
  )

  it.each(['/auth/email/code', '/auth/email/session'])(
    'answers 405 to a GET of %s',
    async (path) => {
      expect((await fetchWith(refusingMailer, path)).status).toBe(405)
    },
  )
})

describe('the send limits', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('send an address at most one code each 60 seconds and five each hour, with the same answer when held back', async () => {
    const known = await knownAnswer()
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const at = (seconds: number) => vi.setSystemTime(start + seconds * 1000)
    const outbox = recordingMailer()
    const ask = async () => seen(await requestCode(outbox, churchId, 'ada@example.org'))

    at(0)
    expect(await ask()).toEqual(known)
    at(30)
    expect(await ask()).toEqual(known)
    expect(outbox.sent()).toHaveLength(1)
    at(61)
    await ask()
    expect(outbox.sent()).toHaveLength(2)
    for (const seconds of [122, 183, 244]) {
      at(seconds)
      await ask()
    }
    expect(outbox.sent()).toHaveLength(5)
    at(305)
    expect(await ask()).toEqual(known)
    at(3599)
    await ask()
    expect(outbox.sent()).toHaveLength(5)
    at(3601)
    await ask()
    expect(outbox.sent()).toHaveLength(6)
  })

  it('count the same address separately at each church', async () => {
    const outbox = recordingMailer()
    // Each church is made after the last one's request: one fake Planning Center at a time.
    const first = await syncedChurch()
    first.emails.hold('ada', 'ada@example.org')
    await requestCode(outbox, first.churchId, 'ada@example.org')
    const second = await syncedChurch()
    second.emails.hold('ada', 'ada@example.org')

    await requestCode(outbox, second.churchId, 'ada@example.org')

    expect(outbox.sent()).toHaveLength(2)
  })
})

describe('the lookup budget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('looks up at most 20 addresses in 20 seconds for one church, then answers try again to a known address with no lookup', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const outbox = recordingMailer()
    const lookups = () =>
      network.calls().filter((call) => call.url.startsWith(`${PLANNING_CENTER}/people/v2/emails`))
        .length
    const before = lookups()

    for (let i = 0; i < 20; i += 1) {
      expect((await requestCode(outbox, churchId, `stranger-${i}@example.org`)).status).toBe(204)
    }
    expect(lookups() - before).toBe(20)

    vi.setSystemTime(start + 10_000)
    const held = await requestCode(outbox, churchId, 'ada@example.org')
    expect(held.status).toBe(503)
    expect(await held.json()).toEqual({ problem: 'try-again' })
    expect(lookups() - before).toBe(20)
    expect(outbox.sent()).toEqual([])

    vi.setSystemTime(start + 20_000)
    expect((await requestCode(outbox, churchId, 'ada@example.org')).status).toBe(204)
    expect(lookups() - before).toBe(21)
    expect(outbox.sent()).toHaveLength(1)
  })
})

describe('a Planning Center failure', () => {
  const tryAgain = { problem: 'try-again' }

  it('answers try again when the lookup fails', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    emails.fail(1)
    const outbox = recordingMailer()

    const response = await requestCode(outbox, churchId, 'ada@example.org')

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(tryAgain)
    expect(outbox.sent()).toEqual([])
  })

  it('answers a known address held back by its send limit exactly as an unknown one', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const outbox = recordingMailer()
    expect((await requestCode(outbox, churchId, 'ada@example.org')).status).toBe(204)
    emails.fail(10)

    const known = await requestCode(outbox, churchId, 'ada@example.org')
    const unknown = await requestCode(outbox, churchId, 'nobody@example.org')

    expect(known.status).toBe(503)
    expect(await known.json()).toEqual(tryAgain)
    expect(unknown.status).toBe(503)
    expect(await unknown.json()).toEqual(tryAgain)
    expect(outbox.sent()).toHaveLength(1)
  })

  it('answers try again at once when the lookup is rate limited', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    emails.throttle(['20'])
    const outbox = recordingMailer()
    const before = Date.now()

    const response = await requestCode(outbox, churchId, 'ada@example.org')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(tryAgain)
    expect(Date.now() - before).toBeLessThan(5000)
    expect(outbox.sent()).toEqual([])
  })

  it('answers at once when the lookup answers with the rate limit reached, rather than waiting out the period', {
    timeout: 60_000,
  }, async () => {
    // The one lookup reports 1 of 1 calls used in a 20-second period.
    const { emails, churchId } = await syncedChurch([ada], fakePlanningCenter(), {
      rateLimit: { limit: 1, periodSeconds: 20 },
    })
    emails.hold('ada', 'ada@example.org')
    const outbox = recordingMailer()
    const before = Date.now()

    const response = await requestCode(outbox, churchId, 'ada@example.org')

    expect(response.status).toBe(204)
    expect(Date.now() - before).toBeLessThan(5000)
    expect(outbox.sent().map((message) => message.to)).toEqual(['ada@example.org'])
  })

  it('answers try again when Planning Center refuses to refresh the sync token', async () => {
    // Every token expires within the refresh margin, so the request has to refresh first.
    const planningCenter = fakePlanningCenter({ codeTokenLifetime: 60, refreshTokenLifetime: 60 })
    const { emails, churchId } = await syncedChurch([ada], planningCenter)
    emails.hold('ada', 'ada@example.org')
    network.stub('POST', `${PLANNING_CENTER}/oauth/token`, () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    )
    const outbox = recordingMailer()

    const response = await requestCode(outbox, churchId, 'ada@example.org')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(tryAgain)
    expect(outbox.sent()).toEqual([])
  })
})

/** A church where Ada asked for a code, and the code her email carried. */
async function sentCode() {
  const church = await syncedChurch()
  church.emails.hold('ada', 'ada@example.org')
  const outbox = recordingMailer()
  await requestCode(outbox, church.churchId, 'ada@example.org')
  return { ...church, outbox, code: codeIn(outbox.sent()[0]) }
}

describe('checking an email sign-in code', () => {
  const wrongCode = { status: 400, problem: 'wrong-code' }

  async function answerOf(response: Response) {
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as { problem?: string; token?: string }
    return response.status === 200 ? body : { status: response.status, ...body }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a session with the right code, once', async () => {
    const { churchId, code } = await sentCode()

    const first = await checkCode(churchId, 'ada@example.org', code)
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect((await first.json()) as SignInSession).toEqual({ token: expect.any(String) })

    expect(await answerOf(await checkCode(churchId, 'ada@example.org', code))).toEqual(wrongCode)
  })

  it('takes the address in any case, as it was sent', async () => {
    const { churchId, code } = await sentCode()

    const response = await checkCode(churchId, '  ADA@Example.org ', code)

    expect(response.status).toBe(200)
  })

  it('refuses the right code 10 minutes and 1 second after it was sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { churchId, code } = await sentCode()
    vi.setSystemTime(start + 10 * 60 * 1000 + 1000)

    expect(await answerOf(await checkCode(churchId, 'ada@example.org', code))).toEqual(wrongCode)
  })

  it('starts a session with the right code 9 minutes and 59 seconds after it was sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { churchId, code } = await sentCode()
    vi.setSystemTime(start + 10 * 60 * 1000 - 1000)

    expect((await checkCode(churchId, 'ada@example.org', code)).status).toBe(200)
  })

  it('refuses the right code once the person has left since it was sent', async () => {
    const { services, churchId, code } = await sentCode()
    services.removeMember('21', 'ada')
    await runScheduled()

    expect(await answerOf(await checkCode(churchId, 'ada@example.org', code))).toEqual(wrongCode)
  })

  it('refuses the right code after five wrong ones, with the one answer every failure gets', async () => {
    const { churchId, code } = await sentCode()
    const answers = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      answers.push(await answerOf(await checkCode(churchId, 'ada@example.org', otherThan(code))))
    }

    answers.push(await answerOf(await checkCode(churchId, 'ada@example.org', code)))

    expect(answers).toEqual(Array(6).fill(wrongCode))
  })

  it('lets the right code through after four wrong ones', async () => {
    const { churchId, code } = await sentCode()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await checkCode(churchId, 'ada@example.org', otherThan(code))
    }

    expect((await checkCode(churchId, 'ada@example.org', code)).status).toBe(200)
  })

  it('refuses a code a newer request replaced, and takes the newer one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { churchId, code, outbox } = await sentCode()
    vi.setSystemTime(start + 61 * 1000)
    await requestCode(outbox, churchId, 'ada@example.org')
    const newer = codeIn(outbox.sent()[1])
    // Two codes in a row can match by chance, one time in a million.
    if (newer === code) return

    expect(await answerOf(await checkCode(churchId, 'ada@example.org', code))).toEqual(wrongCode)
    expect((await checkCode(churchId, 'ada@example.org', newer)).status).toBe(200)
  })

  it.each([
    ['five digits', '12345'],
    ['seven digits', '1234567'],
    ['letters', 'abcdef'],
  ])('answers wrong-code to a code of %s, without counting a try', async (_name, malformed) => {
    const { churchId, code } = await sentCode()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await answerOf(await checkCode(churchId, 'ada@example.org', malformed))).toEqual(
        wrongCode,
      )
    }

    expect((await checkCode(churchId, 'ada@example.org', code)).status).toBe(200)
  })

  it('starts a session that works on the same routes as a Planning Center session', async () => {
    const { planningCenter, organizationId, churchId, code } = await sentCode()
    const emailed = (await (
      await checkCode(churchId, 'ada@example.org', code)
    ).json()) as SignInSession
    const run = await signIn(planningCenter, { organizationId, personId: 'ada' })
    expect(run.session.status).toBe(200)
    const planningCenterToken = (JSON.parse(run.sessionBody) as SignInSession).token

    for (const path of ['/me', '/channels']) {
      const byEmail = await asSession(emailed.token, path)
      const byPlanningCenter = await asSession(planningCenterToken, path)
      expect(byEmail.status, path).toBe(200)
      expect(await byEmail.json(), path).toEqual(await byPlanningCenter.json())
    }
    const channels = (await (await asSession(emailed.token, '/channels')).json()) as ChannelList
    expect(channels.channels.map((channel) => channel.id)).toContain('team-21')
  })
})

/** The `i`-th of the addresses on Ada's profile in the church-wide limit's tests. */
function adaAt(i: number): string {
  return `ada-${i}@example.org`
}

/**
 * A church where Ada holds 21 addresses, `adaAt(0)` to `adaAt(20)`, and the first 20 were each
 * sent one code at once (the lookup budget's 20 for one period). `codes[i]` is `adaAt(i)`'s.
 */
async function codesSent() {
  const church = await syncedChurch()
  for (let i = 0; i <= 20; i += 1) church.emails.hold('ada', adaAt(i))
  const outbox = recordingMailer()
  for (let i = 0; i < 20; i += 1) {
    expect((await requestCode(outbox, church.churchId, adaAt(i))).status).toBe(204)
  }
  return { ...church, outbox, codes: outbox.sent().map(codeIn) }
}

/** Checks a wrong code `counts[i]` times for each address `adaAt(i)`, in turn. */
async function miss(churchId: string, codes: string[], counts: number[]): Promise<void> {
  for (const [i, count] of counts.entries()) {
    for (let attempt = 0; attempt < count; attempt += 1) {
      const answer = await checkCode(churchId, adaAt(i), otherThan(codes[i] as string))
      expect(answer.status).toBe(400)
    }
  }
}

describe('the church-wide limit on wrong codes', () => {
  const limited = { status: 503, cacheControl: 'no-store', body: { problem: 'try-again' } }

  async function answerOf(response: Response) {
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers try again to every check once 100 wrong codes in an hour came from 20 addresses, the right code included, without spending its tries, until the oldest is an hour old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const at = (seconds: number) => vi.setSystemTime(start + seconds * 1000)
    const { churchId, outbox, codes } = await codesSent()
    await miss(churchId, codes, Array(20).fill(5))

    at(3590)
    await requestCode(outbox, churchId, adaAt(20))
    const code = codeIn(outbox.sent()[20])
    at(3599)
    expect(await answerOf(await checkCode(churchId, adaAt(20), code))).toEqual(limited)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await answerOf(await checkCode(churchId, adaAt(20), otherThan(code)))).toEqual(limited)
    }

    at(3601)
    const session = await checkCode(churchId, adaAt(20), code)
    expect(session.status).toBe(200)
    expect((await session.json()) as SignInSession).toEqual({ token: expect.any(String) })
  })

  it('answers a check for an address with no code exactly as one with a live code while the church is limited', async () => {
    const { churchId, outbox, codes } = await codesSent()
    await miss(churchId, codes, Array(20).fill(5))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 21_000)
    await requestCode(outbox, churchId, adaAt(20))
    const code = codeIn(outbox.sent()[20])

    const live = await seen(await checkCode(churchId, adaAt(20), code))
    expect({ status: live.status, body: JSON.parse(live.body) }).toEqual({
      status: limited.status,
      body: limited.body,
    })
    expect(await seen(await checkCode(churchId, adaAt(20), otherThan(code)))).toEqual(live)
    expect(await seen(await checkCode(churchId, 'stranger@example.org', code))).toEqual(live)
    expect(await seen(await checkCode(churchId, adaAt(0), codes[0] as string))).toEqual(live)
  })

  it('lets the right code through after 99 wrong ones', async () => {
    const { churchId, codes } = await codesSent()
    await miss(churchId, codes, [...Array(19).fill(5), 4])

    expect((await checkCode(churchId, adaAt(19), codes[19] as string)).status).toBe(200)
  })

  it('counts only a wrong code for a live one, not a check for no code, an expired code or a malformed body', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { churchId, outbox, codes } = await codesSent()
    await miss(churchId, codes, [...Array(19).fill(5), 4])
    for (let i = 0; i < 101; i += 1) {
      expect((await checkCode(churchId, `stranger-${i}@example.org`, '123456')).status).toBe(400)
    }
    const { path, ...init } = post('/auth/email/session', { churchId, address: adaAt(20) })
    expect((await fetchWith(refusingMailer, path, init)).status).toBe(400)

    vi.setSystemTime(start + 10 * 60 * 1000 + 1000)
    expect((await checkCode(churchId, adaAt(19), otherThan(codes[19] as string))).status).toBe(400)
    await requestCode(outbox, churchId, adaAt(20))

    expect((await checkCode(churchId, adaAt(20), codeIn(outbox.sent()[20]))).status).toBe(200)
  })

  it("counts each church's wrong codes separately", async () => {
    // Each church is made after the last one's checks: one fake Planning Center at a time.
    const first = await codesSent()
    await miss(first.churchId, first.codes, Array(20).fill(5))
    expect((await checkCode(first.churchId, adaAt(0), first.codes[0] as string)).status).toBe(503)
    const second = await sentCode()

    expect((await checkCode(second.churchId, 'ada@example.org', second.code)).status).toBe(200)
  })
})

describe('the limits for each caller', { timeout: LIMIT_TEST_TIMEOUT_MS }, () => {
  const limited = {
    status: 429,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'retry-after': '60',
    },
    body: JSON.stringify({ problem: 'try-again' }),
  }

  /** `POST /auth/email/session` from the given caller address. */
  function checkCodeFrom(caller: string, churchId: string, address: string, code: string) {
    const { path, ...init } = post('/auth/email/session', { churchId, address, code })
    return fetchWith(refusingMailer, path, fromCaller(caller, init))
  }

  /** `POST /auth/email/code` from the given caller address. */
  function requestCodeFrom(
    outbox: ReturnType<typeof recordingMailer>,
    caller: string,
    churchId: string,
    address: string,
  ) {
    const { path, ...init } = post('/auth/email/code', { churchId, address })
    return fetchWith(outbox.mailer, path, fromCaller(caller, init))
  }

  /** The wrong codes the church counts towards its limit. */
  async function missesAt(churchId: string): Promise<number> {
    return runInDurableObject(env.CHURCH_DIRECTORY.getByName(churchId), (_directory, state) => {
      const row = state.storage.sql
        .exec<{ missed: number }>('SELECT COUNT(*) AS missed FROM email_code_misses')
        .toArray()[0]
      return row?.missed ?? 0
    })
  }

  it("refuses a caller's second code check in a minute before the code is read, so one caller's wrong codes neither use up the code nor count towards the church's limit", async () => {
    await inOneLimitPeriod()
    const { churchId, code } = await sentCode()
    const caller = newCallerAddress()
    expect((await checkCodeFrom(caller, churchId, 'ada@example.org', otherThan(code))).status).toBe(
      400,
    )

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await checkCodeFrom(caller, churchId, 'ada@example.org', otherThan(code))
      expect(await seen(wrong)).toEqual(limited)
    }
    expect(await seen(await checkCodeFrom(caller, churchId, 'ada@example.org', code))).toEqual(
      limited,
    )
    expect(await missesAt(churchId)).toBe(1)
    expect((await checkCode(churchId, 'ada@example.org', code)).status).toBe(200)
  })

  it('answers a limited code check the same for the right code, a wrong one and an address the church does not know', async () => {
    await inOneLimitPeriod()
    const { churchId, code } = await sentCode()
    const caller = newCallerAddress()
    await checkCodeFrom(caller, churchId, 'stranger@example.org', code)

    const right = await seen(await checkCodeFrom(caller, churchId, 'ada@example.org', code))
    const wrong = await seen(
      await checkCodeFrom(caller, churchId, 'ada@example.org', otherThan(code)),
    )
    const unknown = await seen(await checkCodeFrom(caller, churchId, 'stranger@example.org', code))

    expect(right).toEqual(limited)
    expect(wrong).toEqual(right)
    expect(unknown).toEqual(right)
  })

  it("refuses a caller's eleventh code request in a minute with no lookup and no email, the same for a known address, so one caller cannot spend the church's lookups", async () => {
    await inOneLimitPeriod()
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const outbox = recordingMailer()
    const caller = newCallerAddress()
    const before = network.calls().length
    const answers = []
    for (let i = 0; i < 20; i += 1) {
      answers.push(
        (await requestCodeFrom(outbox, caller, churchId, `stranger-${i}@example.org`)).status,
      )
    }
    expect(answers).toEqual([...Array(10).fill(204), ...Array(10).fill(429)])
    const lookups = network.calls().length - before

    const known = await seen(await requestCodeFrom(outbox, caller, churchId, 'ada@example.org'))
    const unknown = await seen(
      await requestCodeFrom(outbox, caller, churchId, 'stranger@example.org'),
    )
    expect(known).toEqual(limited)
    expect(unknown).toEqual(known)
    expect(network.calls().length - before).toBe(lookups)
    expect(outbox.sent()).toEqual([])

    expect((await requestCode(outbox, churchId, 'ada@example.org')).status).toBe(204)
    expect(outbox.sent().map((message) => message.to)).toEqual(['ada@example.org'])
  })
})

const tess: FakeServicesPerson = { id: 'tess', name: 'Tess Brandt' }

/** A church where Ada and Tess Brandt share one address, and the code it was sent. */
async function sharedCode(members: FakeServicesPerson[] = [ada, tess]) {
  const church = await syncedChurch(members)
  church.emails.hold('ada', 'brandts@example.org')
  church.emails.hold('tess', 'brandts@example.org')
  const outbox = recordingMailer()
  await requestCode(outbox, church.churchId, 'brandts@example.org')
  return { ...church, outbox, code: codeIn(outbox.sent()[0]) }
}

/** `POST /auth/email/choice`. */
function choosePerson(churchId: unknown, choiceToken: unknown, personId: unknown) {
  const { path, ...init } = post('/auth/email/choice', { churchId, choiceToken, personId })
  return fetchWith(refusingMailer, path, init)
}

/** The name choice a right code for the shared address answers. */
async function nameChoice(churchId: string, code: string): Promise<EmailNameChoice> {
  const response = await checkCode(churchId, 'brandts@example.org', code)
  expect(response.status).toBe(200)
  return (await response.json()) as EmailNameChoice
}

const startOver = { status: 400, problem: 'start-over' }

async function refusalOf(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store')
  return { status: response.status, ...((await response.json()) as object) }
}

describe('choosing a name when an address is shared', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers the names of the known people who share the address for the right code, and no session', async () => {
    const { churchId, code } = await sharedCode()

    const response = await checkCode(churchId, 'brandts@example.org', code)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as EmailNameChoice
    expect(body).toEqual({
      choiceToken: expect.any(String),
      people: [
        { personId: 'ada', name: 'Ada Brandt' },
        { personId: 'tess', name: 'Tess Brandt' },
      ],
    })
    expect(body).not.toHaveProperty('token')
    expect((await asSession(body.choiceToken, '/me')).status).toBe(401)
  })

  it('leaves out a person under 13 and a person not in the roster who also hold the address', async () => {
    const church = await syncedChurch([ada, tess, kit])
    for (const personId of ['ada', 'tess', 'kit', 'stranger']) {
      church.emails.hold(personId, 'brandts@example.org')
    }
    const outbox = recordingMailer()
    await requestCode(outbox, church.churchId, 'brandts@example.org')

    const response = await checkCode(
      church.churchId,
      'brandts@example.org',
      codeIn(outbox.sent()[0]),
    )

    expect(((await response.json()) as EmailNameChoice).people).toEqual([
      { personId: 'ada', name: 'Ada Brandt' },
      { personId: 'tess', name: 'Tess Brandt' },
    ])
  })

  it('signs in the person picked, and no one else with the same token', async () => {
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)

    const chosen = await choosePerson(churchId, choiceToken, 'tess')

    expect(chosen.status).toBe(200)
    expect(chosen.headers.get('cache-control')).toBe('no-store')
    const session = (await chosen.json()) as SignInSession
    expect(session).toEqual({ token: expect.any(String) })
    const me = await asSession(session.token, '/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ personId: 'tess', name: 'Tess Brandt' })
    expect(await refusalOf(await choosePerson(churchId, choiceToken, 'ada'))).toEqual(startOver)
    expect(await refusalOf(await choosePerson(churchId, choiceToken, 'tess'))).toEqual(startOver)
  })

  it('signs the person picked in again when the answer was lost and the same choice is posted again', async () => {
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    const lost = await choosePerson(churchId, choiceToken, 'tess')
    expect(lost.status).toBe(200)

    const retry = await choosePerson(churchId, choiceToken, 'tess')

    expect(retry.status).toBe(200)
    expect(retry.headers.get('cache-control')).toBe('no-store')
    const session = (await retry.json()) as SignInSession
    expect(session).toEqual({ token: expect.any(String) })
    expect(session.token).not.toBe(((await lost.json()) as SignInSession).token)
    expect(await (await asSession(session.token, '/me')).json()).toMatchObject({
      personId: 'tess',
      name: 'Tess Brandt',
    })
  })

  it('signs the person picked in again 59 seconds after the first answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
    vi.setSystemTime(Date.now() + 60 * 1000 - 1000)

    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
  })

  it('refuses the same choice 60 seconds and 1 second after the first answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
    vi.setSystemTime(Date.now() + 60 * 1000 + 1000)

    expect(await refusalOf(await choosePerson(churchId, choiceToken, 'tess'))).toEqual(startOver)
  })

  it('refuses the same choice past the 5 minutes after the right code, even within a minute of the first answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    const pickedAt = Date.now()
    vi.setSystemTime(pickedAt + 5 * 60 * 1000 - 10 * 1000)
    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
    vi.setSystemTime(pickedAt + 5 * 60 * 1000 + 1000)

    expect(await refusalOf(await choosePerson(churchId, choiceToken, 'tess'))).toEqual(startOver)
  })

  it.each([
    ['a known person who does not hold the address', 'lee'],
    ['a person the church does not know', 'stranger'],
  ])('refuses %s, and uses the token up', async (_name, personId) => {
    const lee: FakeServicesPerson = { id: 'lee', name: 'Lee Okafor' }
    const { churchId, code } = await sharedCode([ada, tess, lee])
    const { choiceToken } = await nameChoice(churchId, code)

    expect(await refusalOf(await choosePerson(churchId, choiceToken, personId))).toEqual(startOver)
    expect(await refusalOf(await choosePerson(churchId, choiceToken, 'tess'))).toEqual(startOver)
  })

  it('refuses the choice 5 minutes and 1 second after the right code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000)

    expect(await refusalOf(await choosePerson(churchId, choiceToken, 'tess'))).toEqual(startOver)
  })

  it('takes the choice 4 minutes and 59 seconds after the right code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 - 1000)

    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
  })

  it('refuses the person picked once they have left since the right code', async () => {
    const { services, churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    services.removeMember('21', 'tess')
    await runScheduled()

    expect(await refusalOf(await choosePerson(churchId, choiceToken, 'tess'))).toEqual(startOver)
  })

  it('refuses the token posted with another connected church', async () => {
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    const other = await syncedChurch([ada, tess])

    expect(await refusalOf(await choosePerson(other.churchId, choiceToken, 'tess'))).toEqual(
      startOver,
    )
    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
  })

  it.each([
    ['no token', (_token: string) => [undefined, 'tess']],
    ['a token of the wrong shape', (token: string) => [`${token}x`, 'tess']],
    ['a person ID that is not a string', (token: string) => [token, 7]],
    ['an empty person ID', (token: string) => [token, '']],
    ['a person ID over 64 characters', (token: string) => [token, 't'.repeat(65)]],
  ])('answers start-over to a choice with %s, and keeps the token', async (_name, fields) => {
    const { churchId, code } = await sharedCode()
    const { choiceToken } = await nameChoice(churchId, code)
    const [token, personId] = fields(choiceToken)

    expect(await refusalOf(await choosePerson(churchId, token, personId))).toEqual(startOver)
    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
  })

  it('answers start-over to a body that is not JSON', async () => {
    const response = await fetchWith(refusingMailer, '/auth/email/choice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })

    expect(await refusalOf(response)).toEqual(startOver)
  })

  it('never answers names to a wrong code, nor to the right one after five wrong ones', async () => {
    const { churchId, code } = await sharedCode()
    const answers = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      answers.push(await checkCode(churchId, 'brandts@example.org', otherThan(code)))
    }
    answers.push(await checkCode(churchId, 'brandts@example.org', code))

    for (const answer of answers) {
      expect(answer.status).toBe(400)
      expect(await answer.json()).toEqual({ problem: 'wrong-code' })
    }
  })

  it('signs the one known person in directly when the others who hold the address are not known', async () => {
    const church = await syncedChurch([ada, kit])
    church.emails.hold('ada', 'brandts@example.org')
    church.emails.hold('kit', 'brandts@example.org')
    const outbox = recordingMailer()
    await requestCode(outbox, church.churchId, 'brandts@example.org')

    const response = await checkCode(
      church.churchId,
      'brandts@example.org',
      codeIn(outbox.sent()[0]),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as SignInSession
    expect(body).toEqual({ token: expect.any(String) })
    expect(body).not.toHaveProperty('people')
    expect(await (await asSession(body.token, '/me')).json()).toMatchObject({ personId: 'ada' })
  })

  it('answers 405 to a GET of the choice route', async () => {
    expect((await fetchWith(refusingMailer, '/auth/email/choice', { method: 'GET' })).status).toBe(
      405,
    )
  })
})

/** The hex HMAC-SHA-256 of a text, under a key's UTF-8 bytes. */
async function hmacHex(key: string, text: string): Promise<string> {
  const encoder = new TextEncoder()
  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', imported, encoder.encode(text))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The hex SHA-256 of a text. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('the stored hashes', () => {
  it('are HMACs of the address and the code under the Worker secret, never their plain SHA-256', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const outbox = recordingMailer()

    expect((await requestCode(outbox, churchId, 'Ada@Example.org')).status).toBe(204)

    const code = codeIn(outbox.sent()[0])
    const rows = await runInDurableObject(
      env.CHURCH_DIRECTORY.getByName(churchId),
      (_directory, state) => ({
        codes: state.storage.sql
          .exec<{ address_hash: string; code_hash: string }>(
            'SELECT address_hash, code_hash FROM email_codes WHERE church_id = ?',
            churchId,
          )
          .toArray(),
        sends: state.storage.sql
          .exec<{ address_hash: string }>(
            'SELECT address_hash FROM email_code_sends WHERE church_id = ?',
            churchId,
          )
          .toArray(),
      }),
    )
    const addressText = `${churchId}:ada@example.org`
    const addressHash = await hmacHex(env.EMAIL_HASH_KEY, addressText)
    expect(rows.codes).toEqual([
      { address_hash: addressHash, code_hash: await hmacHex(env.EMAIL_HASH_KEY, code) },
    ])
    expect(rows.sends).toEqual([{ address_hash: addressHash }])
    expect(addressHash).not.toBe(await sha256Hex(addressText))
    expect(rows.codes[0]?.code_hash).not.toBe(await sha256Hex(code))
  })

  it('take the key: the right code checked under another key is wrong, and under the key starts a session', async () => {
    const { churchId, code } = await sentCode()
    const otherKey = new Proxy(env, {
      get: (target, property) =>
        property === 'EMAIL_HASH_KEY' ? 'another-email-hash-key' : Reflect.get(target, property),
    })
    const { path, ...init } = post('/auth/email/session', {
      churchId,
      address: 'ada@example.org',
      code,
    })

    const refused = await fetchWith(refusingMailer, path, init, otherKey)

    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ problem: 'wrong-code' })
    expect((await checkCode(churchId, 'ada@example.org', code)).status).toBe(200)
  })
})

describe('a missing EMAIL_HASH_KEY', () => {
  it.each([
    ['empty', ''],
    ['unset', undefined],
  ])(
    'fails a code request and a code check with an error that names it, when %s',
    async (_case, key) => {
      const churchId = pcoChurchId(newOrganizationId())
      const noKey = new Proxy(env, {
        get: (target, property) =>
          property === 'EMAIL_HASH_KEY' ? key : Reflect.get(target, property),
      })
      const { path: codePath, ...codeInit } = post('/auth/email/code', {
        churchId,
        address: 'ada@example.org',
      })
      const { path: checkPath, ...checkInit } = post('/auth/email/session', {
        churchId,
        address: 'ada@example.org',
        code: '123456',
      })

      await expect(fetchWith(refusingMailer, codePath, codeInit, noKey)).rejects.toThrow(
        /EMAIL_HASH_KEY/,
      )
      await expect(fetchWith(refusingMailer, checkPath, checkInit, noKey)).rejects.toThrow(
        /EMAIL_HASH_KEY/,
      )
    },
  )
})

/** How many email code, send and name choice rows a church's directory holds. */
async function emailRows(churchId: string) {
  return runInDurableObject(env.CHURCH_DIRECTORY.getByName(churchId), (_directory, state) => {
    const count = (table: string) =>
      state.storage.sql
        .exec<{ rows: number }>(
          `SELECT COUNT(*) AS rows FROM ${table} WHERE church_id = ?`,
          churchId,
        )
        .toArray()[0]?.rows
    return {
      codes: count('email_codes'),
      sends: count('email_code_sends'),
      choices: count('email_code_choices'),
    }
  })
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

describe('the sweep on the roster sync tick', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deletes a code never checked, its send and a name choice never picked, once they are an hour old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { churchId, code, outbox } = await sharedCode()
    await nameChoice(churchId, code)
    vi.setSystemTime(Date.now() + MINUTE + 1000)
    await requestCode(outbox, churchId, 'brandts@example.org')
    expect(await emailRows(churchId)).toEqual({ codes: 1, sends: 2, choices: 1 })

    vi.setSystemTime(Date.now() + HOUR + 1000)
    await runScheduled()

    expect(await emailRows(churchId)).toEqual({ codes: 0, sends: 0, choices: 0 })
  })

  it('keeps a send that still counts, so the hourly limit holds back a sixth code after a tick', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const at = (seconds: number) => vi.setSystemTime(start + seconds * 1000)
    const outbox = recordingMailer()
    for (const seconds of [0, 61, 122, 183, 244]) {
      at(seconds)
      await requestCode(outbox, churchId, 'ada@example.org')
    }
    expect(outbox.sent()).toHaveLength(5)

    at(59 * 60)
    await runScheduled()

    expect((await emailRows(churchId)).sends).toBe(5)
    at(59 * 60 + 30)
    await requestCode(outbox, churchId, 'ada@example.org')
    expect(outbox.sent()).toHaveLength(5)
  })

  it('keeps a live code and a live name choice, which still sign in after a tick', async () => {
    const { churchId, code } = await sharedCode()

    await runScheduled()
    const { choiceToken } = await nameChoice(churchId, code)
    await runScheduled()

    expect((await choosePerson(churchId, choiceToken, 'tess')).status).toBe(200)
  })

  it('still runs when the roster read fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { churchId } = await sharedCode()
    network.stubPath(
      'GET',
      `${PLANNING_CENTER}/services/v2/teams`,
      () => new Response('down', { status: 500 }),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      vi.setSystemTime(Date.now() + HOUR + 1000)
      await runScheduled()

      expect(await emailRows(churchId)).toEqual({ codes: 0, sends: 0, choices: 0 })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('still runs when Planning Center refuses to refresh the sync token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Every token expires within the refresh margin, so the tick has to refresh first.
    const planningCenter = fakePlanningCenter({ codeTokenLifetime: 60, refreshTokenLifetime: 60 })
    const { emails, churchId } = await syncedChurch([ada], planningCenter)
    emails.hold('ada', 'ada@example.org')
    await requestCode(recordingMailer(), churchId, 'ada@example.org')
    expect(await emailRows(churchId)).toEqual({ codes: 1, sends: 1, choices: 0 })
    network.stub('POST', `${PLANNING_CENTER}/oauth/token`, () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      vi.setSystemTime(Date.now() + HOUR + 1000)
      await runScheduled()

      expect(await emailRows(churchId)).toEqual({ codes: 0, sends: 0, choices: 0 })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

describe('the deployed entry', () => {
  it('sends the code through the send_email binding', async () => {
    const { emails, churchId } = await syncedChurch()
    emails.hold('ada', 'ada@example.org')
    const sends: EmailMessageBuilder[] = []
    const email: SendEmail = {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        sends.push(structuredClone(message as EmailMessageBuilder))
        return { messageId: 'stub' }
      },
    }
    const bindings = new Proxy(env, {
      get: (target, property) => (property === 'EMAIL' ? email : Reflect.get(target, property)),
    })
    const { path, ...init } = post('/auth/email/code', { churchId, address: 'ada@example.org' })

    const response = await fetchDeployed(path, init, bindings)

    expect(response.status).toBe(204)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({
      to: 'ada@example.org',
      from: { email: 'sign-in@phon.chat', name: 'Phon' },
      subject: 'Your Phon sign-in code',
    })
    expect(codeIn(sends[0])).toMatch(/^\d{6}$/)
    expect(sends[0]?.html).toContain(codeIn(sends[0]))
  })
})
