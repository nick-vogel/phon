import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { SignInSession } from '@phon/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelObjectName } from '../src/channel.ts'
import { envWithFailingEvict } from './support/bindings.ts'
import { postMessage, seedChurch } from './support/church.ts'
import { fetchDeployed, runScheduled } from './support/deployed.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'
import {
  asSession,
  connectSyncAccount,
  openSessionSocket,
  pcoChurchId,
  signInAs,
} from './support/flows.ts'
import { codeIn, fetchWith, recordingMailer, refusingMailer } from './support/mailer.ts'
import { fakeEmails } from './support/people.ts'
import { fakePlanningCenter, newOrganizationId } from './support/planning-center.ts'
import { fakeServices } from './support/services.ts'

const DAY = 24 * 60 * 60 * 1000
/** A session's lifetime, written out here rather than taken from the code under test. */
const LIFETIME = 90 * DAY

/**
 * A connected church whose roster sync has run once, with Ada and Ben on its Worship team, so the
 * roster sync tick reaches it. The People emails list is empty until the test holds an address.
 */
async function syncedChurch() {
  const planningCenter = fakePlanningCenter()
  const organizationId = newOrganizationId()
  fakeServices(planningCenter, {
    syncPersonId: 'sync',
    teams: [
      {
        id: '21',
        name: 'Worship',
        members: [
          { id: 'ada', name: 'Ada Brandt' },
          { id: 'ben', name: 'Ben Okafor' },
        ],
        leaders: [],
      },
    ],
  })
  const emails = fakeEmails(planningCenter, { syncPersonId: 'sync' })
  const connect = await connectSyncAccount(planningCenter, {
    organizationId,
    personId: 'sync',
    administrator: true,
  })
  expect(connect.session.status).toBe(204)
  await runScheduled()
  return { planningCenter, emails, organizationId, churchId: pcoChurchId(organizationId) }
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** Signs a person in with a code sent to an address only they have, and answers the token. */
async function emailSignIn(
  church: Awaited<ReturnType<typeof syncedChurch>>,
  personId: string,
  address: string,
): Promise<string> {
  church.emails.hold(personId, address)
  const outbox = recordingMailer()
  await fetchWith(outbox.mailer, '/auth/email/code', post({ churchId: church.churchId, address }))
  const response = await fetchWith(
    refusingMailer,
    '/auth/email/session',
    post({ churchId: church.churchId, address, code: codeIn(outbox.sent()[0]) }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as SignInSession).token
}

/** The status `GET /me` answers a session. */
async function meStatus(token: string): Promise<number> {
  return (await asSession(token, '/me')).status
}

/** How many sessions a church's directory holds. */
function sessionRows(churchId: string): Promise<number | undefined> {
  return runInDurableObject(
    env.CHURCH_DIRECTORY.getByName(churchId),
    (_directory, state) =>
      state.storage.sql
        .exec<{ rows: number }>(
          'SELECT COUNT(*) AS rows FROM sessions WHERE church_id = ?',
          churchId,
        )
        .toArray()[0]?.rows,
  )
}

/** How many devices of a person a church's directory holds. */
function deviceRows(churchId: string, personId: string): Promise<number | undefined> {
  return runInDurableObject(
    env.CHURCH_DIRECTORY.getByName(churchId),
    (_directory, state) =>
      state.storage.sql
        .exec<{ rows: number }>(
          'SELECT COUNT(*) AS rows FROM devices WHERE church_id = ? AND person_id = ?',
          churchId,
          personId,
        )
        .toArray()[0]?.rows,
  )
}

describe("a session's lifetime", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers a session until 90 days after sign-in, and not from then on', async () => {
    const { planningCenter, organizationId } = await syncedChurch()
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const token = await signInAs(planningCenter, organizationId, 'ada')

    vi.setSystemTime(start + LIFETIME - 1000)
    expect(await meStatus(token)).toBe(200)
    vi.setSystemTime(start + LIFETIME)
    expect(await meStatus(token)).toBe(401)
    vi.setSystemTime(start + LIFETIME + DAY)
    expect(await meStatus(token)).toBe(401)
  })

  it("keeps a later session of the same person once the first one's lifetime is over", async () => {
    const { planningCenter, organizationId } = await syncedChurch()
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const first = await signInAs(planningCenter, organizationId, 'ada')
    vi.setSystemTime(start + 30 * DAY)
    const later = await signInAs(planningCenter, organizationId, 'ada')

    vi.setSystemTime(start + LIFETIME)
    expect(await meStatus(first)).toBe(401)
    expect(await meStatus(later)).toBe(200)
  })

  it('ends an email code session at the same lifetime', async () => {
    const church = await syncedChurch()
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const token = await emailSignIn(church, 'ada', 'ada@example.org')

    vi.setSystemTime(start + LIFETIME - 1000)
    expect(await meStatus(token)).toBe(200)
    vi.setSystemTime(start + LIFETIME)
    expect(await meStatus(token)).toBe(401)
  })

  it('has the roster sync tick delete the sessions past their lifetime and keep the live ones', async () => {
    const { planningCenter, organizationId, churchId } = await syncedChurch()
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    await signInAs(planningCenter, organizationId, 'ada')
    await signInAs(planningCenter, organizationId, 'ben')
    vi.setSystemTime(start + 60 * DAY)
    const live = await signInAs(planningCenter, organizationId, 'ben')
    expect(await sessionRows(churchId)).toBe(3)

    vi.setSystemTime(start + LIFETIME + 1000)
    await runScheduled()

    expect(await sessionRows(churchId)).toBe(1)
    expect(await meStatus(live)).toBe(200)
  })
  it("stops alerting the phone of a person whose last session's lifetime is over", async () => {
    const expo = fakeExpoPush()
    const { churchId, signIn } = await seededChurch()
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const lostPhone = await signIn('ana')
    await registerWith(lostPhone, tokenOf('ana-lost'))

    vi.setSystemTime(start + LIFETIME + DAY)
    expect(await meStatus(lostPhone)).toBe(401)
    await registerWith(await signIn('dee'), tokenOf('dee'))

    expect(await staffPushedTo(expo, churchId, 'ben')).toEqual([tokenOf('dee')])
  })

  it("has the roster sync tick delete the devices of a person whose last session's lifetime is over", async () => {
    const { planningCenter, organizationId, churchId } = await syncedChurch()
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    await registerWith(await signInAs(planningCenter, organizationId, 'ada'), tokenOf('ada'))
    await signInAs(planningCenter, organizationId, 'ben')
    vi.setSystemTime(start + 60 * DAY)
    await registerWith(await signInAs(planningCenter, organizationId, 'ben'), tokenOf('ben'))
    expect(await deviceRows(churchId, 'ada')).toBe(1)

    vi.setSystemTime(start + LIFETIME + 1000)
    await runScheduled()

    expect(await deviceRows(churchId, 'ada')).toBe(0)
    expect(await deviceRows(churchId, 'ben')).toBe(1)
  })
})

/**
 * A church Phon knows, keyed on a Planning Center organization no other test uses: Ana (admin),
 * Cy (chat admin), Ben and Dee (members). Everyone is in the private staff channel, which alerts
 * on every message; Ben, Cy and Dee are in the private prayer channel, which Ana reads only by
 * oversight; and the open Sunday team channel is everyone's.
 */
async function seededChurch(planningCenter = fakePlanningCenter()) {
  const organizationId = newOrganizationId()
  const { churchId } = await seedChurch({
    churchId: pcoChurchId(organizationId),
    people: [
      { personId: 'ana', name: 'Ana Ortiz', role: 'admin' },
      { personId: 'ben', name: 'Ben Okafor' },
      { personId: 'cy', name: 'Cy Park', role: 'chat-admin' },
      { personId: 'dee', name: 'Dee Lund' },
      { personId: 'fay', name: 'Fay Moreno', role: 'admin' },
    ],
    channels: [
      { channelId: 'sunday-team', name: 'Sunday team', kind: 'open' },
      {
        channelId: 'staff',
        name: 'Staff',
        kind: 'private',
        members: ['ana', 'ben', 'cy', 'dee', 'fay'],
      },
      { channelId: 'prayer', name: 'Prayer', kind: 'private', members: ['ben', 'cy', 'dee'] },
    ],
  })
  return {
    churchId,
    signIn: (personId: string) => signInAs(planningCenter, organizationId, personId),
  }
}

/** Registers a device's Expo push token with a session, through `POST /devices`. */
async function registerWith(token: string, deviceToken: string): Promise<void> {
  const response = await asSession(token, '/devices', post({ token: deviceToken }))
  expect(response.status).toBe(204)
}

/**
 * The devices a staff post by a person pushes to, sorted. A marker post follows it, so an answer
 * without a device means the post did not push to it.
 */
async function staffPushedTo(
  expo: ReturnType<typeof fakeExpoPush>,
  churchId: string,
  personId: string,
): Promise<string[]> {
  const message = await postMessage(churchId, personId, 'staff', 'Staff only')
  const marker = await postMessage(churchId, personId, 'staff', 'Marker')
  return (await expo.pushesFor(message.id, { after: marker.id })).map((p) => p.to).sort()
}

/** `POST /me/sign-out` with a session and a raw body, or none. */
function signOut(token: string, body?: string): Promise<Response> {
  return asSession(token, '/me/sign-out', {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
  })
}

/**
 * The tables in a church's directory object. An object that never writes its storage ceases to
 * exist when it shuts down, so an empty list means a request left nothing behind.
 */
function directoryTables(churchId: string): Promise<string[]> {
  return runInDurableObject(env.CHURCH_DIRECTORY.getByName(churchId), (_directory, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray()
      .map((row) => row.name),
  )
}

describe('signing out', () => {
  it("ends only the session it is sent with, and stops that phone's alerts", async () => {
    const expo = fakeExpoPush()
    const { churchId, signIn } = await seededChurch()
    const phoneA = await signIn('ana')
    const phoneB = await signIn('ana')
    await registerWith(phoneA, tokenOf('ana-a'))
    await registerWith(phoneB, tokenOf('ana-b'))

    const response = await signOut(phoneA, JSON.stringify({ deviceToken: tokenOf('ana-a') }))

    expect(response.status).toBe(204)
    expect(await meStatus(phoneA)).toBe(401)
    expect((await asSession(phoneA, '/channels')).status).toBe(401)
    const socket = await asSession(phoneA, '/channels/staff/socket', {
      headers: { upgrade: 'websocket' },
    })
    expect(socket.status).toBe(401)
    expect(socket.webSocket).toBeNull()
    expect(await meStatus(phoneB)).toBe(200)
    const pushed = await staffPushedTo(expo, churchId, 'ben')
    expect(pushed).toContain(tokenOf('ana-b'))
    expect(pushed).not.toContain(tokenOf('ana-a'))
  })

  it('answers 401 to a session already signed out', async () => {
    const { signIn } = await seededChurch()
    const token = await signIn('ana')
    expect((await signOut(token)).status).toBe(204)

    expect((await signOut(token)).status).toBe(401)
  })

  it("leaves the person's devices alerting when it names none", async () => {
    const expo = fakeExpoPush()
    const { churchId, signIn } = await seededChurch()
    const token = await signIn('ana')
    await registerWith(token, tokenOf('ana-a'))

    expect((await signOut(token)).status).toBe(204)

    expect(await meStatus(token)).toBe(401)
    expect(await staffPushedTo(expo, churchId, 'ben')).toContain(tokenOf('ana-a'))
  })

  it("leaves another person's device alerting when it names that device", async () => {
    const expo = fakeExpoPush()
    const { churchId, signIn } = await seededChurch()
    const ana = await signIn('ana')
    const ben = await signIn('ben')
    await registerWith(ben, tokenOf('ben-a'))

    const response = await signOut(ana, JSON.stringify({ deviceToken: tokenOf('ben-a') }))

    expect(response.status).toBe(204)
    expect(await meStatus(ben)).toBe(200)
    expect(await staffPushedTo(expo, churchId, 'dee')).toContain(tokenOf('ben-a'))
  })

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a body that is not an object', '["ExponentPushToken[ana-a]"]'],
    ['a device token that is not a string', '{"deviceToken":42}'],
  ])('refuses %s with 400, and keeps the session', async (_label, body) => {
    const { signIn } = await seededChurch()
    const token = await signIn('ana')

    expect((await signOut(token, body)).status).toBe(400)

    expect(await meStatus(token)).toBe(200)
  })

  it('answers 405 to a GET, and keeps the session', async () => {
    const { signIn } = await seededChurch()
    const token = await signIn('ana')

    expect((await asSession(token, '/me/sign-out')).status).toBe(405)

    expect(await meStatus(token)).toBe(200)
  })

  it.each([
    ['no token', undefined],
    ['a malformed token', 'Bearer not-a-session'],
    ['a test identity', 'Bearer test:pco-1:ana'],
    ['a well-formed token never issued', `Bearer pco-1.${'a'.repeat(43)}`],
  ])('answers 401 with %s', async (_label, authorization) => {
    const response = await fetchDeployed('/me/sign-out', {
      method: 'POST',
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    })

    expect(response.status).toBe(401)
  })

  it('leaves no directory behind for the church a token makes up', async () => {
    const churchId = `made-up-${crypto.randomUUID()}`

    const response = await signOut(
      `${churchId}.${'a'.repeat(43)}`,
      JSON.stringify({ deviceToken: tokenOf('ana-a') }),
    )

    expect(response.status).toBe(401)
    expect(await directoryTables(churchId)).toEqual([])
  })

  it('ends a session past its lifetime as no session', async () => {
    const { churchId, signIn } = await seededChurch()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      const token = await signIn('ana')
      vi.setSystemTime(start + LIFETIME)

      expect((await signOut(token)).status).toBe(401)
      expect(await sessionRows(churchId)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** `POST /people/:personId/sign-out` with a session. */
function endSessions(token: string, personId: string): Promise<Response> {
  return asSession(token, `/people/${personId}/sign-out`, { method: 'POST' })
}

/** The close code of the not-a-member close, written out rather than taken from the code. */
const NO_LONGER_A_MEMBER = 4403

describe("an admin ending a person's sessions", () => {
  /**
   * The seeded church with Ben signed in on two phones, one device registered, and a socket open
   * on the Sunday team and prayer channels, and Cy's device registered so a post has a marker.
   */
  async function benOnTwoPhones() {
    const church = await seededChurch()
    const ana = await church.signIn('ana')
    const phoneA = await church.signIn('ben')
    const phoneB = await church.signIn('ben')
    await registerWith(phoneA, tokenOf('ben-a'))
    await registerWith(phoneB, tokenOf('ben-b'))
    await registerWith(await church.signIn('cy'), tokenOf('cy'))
    const sunday = await openSessionSocket(phoneA, 'sunday-team')
    const prayer = await openSessionSocket(phoneB, 'prayer')
    return { ...church, ana, phoneA, phoneB, sunday, prayer }
  }

  it('signs the person out on every phone, closes their sockets and stops their alerts', async () => {
    const expo = fakeExpoPush()
    const { churchId, ana, phoneA, phoneB, sunday, prayer } = await benOnTwoPhones()
    const anaSocket = await openSessionSocket(ana, 'sunday-team')

    expect((await endSessions(ana, 'ben')).status).toBe(204)

    expect(await meStatus(phoneA)).toBe(401)
    expect(await meStatus(phoneB)).toBe(401)
    expect((await sunday.closed()).code).toBe(NO_LONGER_A_MEMBER)
    expect((await prayer.closed()).code).toBe(NO_LONGER_A_MEMBER)
    const message = await postMessage(churchId, 'dee', 'prayer', 'For Ben')
    const marker = await postMessage(churchId, 'dee', 'prayer', 'Marker')
    const pushed = (await expo.pushesFor(message.id, { after: marker.id })).map((p) => p.to)
    expect(pushed).toEqual([tokenOf('cy')])
    expect(await meStatus(ana)).toBe(200)
    anaSocket.send({ type: 'send', body: 'Still here' })
    expect(await anaSocket.nextFrame()).toMatchObject({ type: 'message' })
    anaSocket.close()
  })

  it('lets the person sign in again, and their device alert again once registered', async () => {
    const expo = fakeExpoPush()
    const { churchId, ana, signIn } = await benOnTwoPhones()
    expect((await endSessions(ana, 'ben')).status).toBe(204)

    const again = await signIn('ben')
    expect(await meStatus(again)).toBe(200)
    await registerWith(again, tokenOf('ben-a'))

    const message = await postMessage(churchId, 'dee', 'prayer', 'Welcome back')
    const marker = await postMessage(churchId, 'dee', 'prayer', 'Marker')
    const pushed = (await expo.pushesFor(message.id, { after: marker.id })).map((p) => p.to)
    expect(pushed.sort()).toEqual([tokenOf('ben-a'), tokenOf('cy')].sort())
  })

  it("still ends the sessions and closes the other sockets when one channel's close fails", async () => {
    const { churchId, ana, phoneA, phoneB, sunday, prayer } = await benOnTwoPhones()
    const failing = envWithFailingEvict(channelObjectName(churchId, 'prayer'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = await asSession(ana, '/people/ben/sign-out', { method: 'POST' }, failing)

      expect(response.status).toBe(204)
      expect(await meStatus(phoneA)).toBe(401)
      expect(await meStatus(phoneB)).toBe(401)
      expect((await sunday.closed()).code).toBe(NO_LONGER_A_MEMBER)
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('on prayer'),
        expect.objectContaining({ message: 'Durable Object reset' }),
      )
    } finally {
      logged.mockRestore()
      prayer.close()
    }
  })

  it('answers the same to a person with no session', async () => {
    const { signIn } = await seededChurch()
    const ana = await signIn('ana')

    expect((await endSessions(ana, 'dee')).status).toBe(204)
    expect((await endSessions(ana, 'dee')).status).toBe(204)
  })

  it.each([
    ['a chat admin', 'cy'],
    ['a member', 'dee'],
  ])('refuses %s with 403, and keeps the person signed in', async (_label, callerId) => {
    const { signIn, phoneA, phoneB, sunday, prayer } = await benOnTwoPhones()
    const caller = await signIn(callerId)

    expect((await endSessions(caller, 'ben')).status).toBe(403)

    expect(await meStatus(phoneA)).toBe(200)
    expect(await meStatus(phoneB)).toBe(200)
    sunday.send({ type: 'send', body: 'Still here' })
    expect(await sunday.nextFrame()).toMatchObject({ type: 'message' })
    sunday.close()
    prayer.close()
  })

  it('answers 404 for a person the church does not have', async () => {
    const { signIn } = await seededChurch()
    const ana = await signIn('ana')

    expect((await endSessions(ana, 'nobody')).status).toBe(404)
  })

  it("ends the person of the caller's own church, not the person of that ID in another church", async () => {
    const planningCenter = fakePlanningCenter()
    const a = await seededChurch(planningCenter)
    const b = await seededChurch(planningCenter)
    const ana = await a.signIn('ana')
    const benInB = await b.signIn('ben')

    expect((await endSessions(ana, 'ben')).status).toBe(204)

    expect(await meStatus(benInB)).toBe(200)
  })

  it('answers 405 to a GET, and 401 with no session', async () => {
    const { signIn } = await seededChurch()
    const ana = await signIn('ana')

    expect((await asSession(ana, '/people/ben/sign-out')).status).toBe(405)
    expect((await fetchDeployed('/people/ben/sign-out', { method: 'POST' })).status).toBe(401)
  })

  it("closes another admin's oversight socket on a private channel they are not in", async () => {
    const { signIn } = await seededChurch()
    const ana = await signIn('ana')
    const fay = await signIn('fay')
    const overseen = await openSessionSocket(fay, 'prayer')

    expect((await endSessions(ana, 'fay')).status).toBe(204)

    expect(await meStatus(fay)).toBe(401)
    expect((await overseen.closed()).code).toBe(NO_LONGER_A_MEMBER)
  })

  it('lets an admin end their own sessions', async () => {
    const { signIn } = await seededChurch()
    const ana = await signIn('ana')
    const socket = await openSessionSocket(ana, 'staff')

    expect((await endSessions(ana, 'ana')).status).toBe(204)

    expect(await meStatus(ana)).toBe(401)
    expect((await socket.closed()).code).toBe(NO_LONGER_A_MEMBER)
  })
})
