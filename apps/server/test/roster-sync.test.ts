import { env } from 'cloudflare:workers'
import type { ChannelList, ChannelSummary, Member, Role, SignInSession } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { channelObjectName, HOLDER_HEADERS } from '../src/channel.ts'
import { syncAllChurches } from '../src/roster-sync.ts'
import { envWithFailingEvict } from './support/bindings.ts'
import {
  acceptSocket,
  asMember,
  listChannels,
  openSocket,
  postFrame,
  readHistory,
  seedChurch,
} from './support/church.ts'
import { runScheduled } from './support/deployed.ts'
import {
  asSession,
  connectChurch,
  connectSyncAccount,
  pcoChurchId,
  signIn,
} from './support/flows.ts'
import { network } from './support/network.ts'
import { birthdateFor } from './support/people.ts'
import {
  type FakePlanningCenterOptions,
  fakePlanningCenter,
  newOrganizationId,
  PLANNING_CENTER,
} from './support/planning-center.ts'
import { type FakeServicesOptions, type FakeTeam, fakeServices } from './support/services.ts'

const ana = { id: 'ana', name: 'Ana Ortiz' }
const bo = { id: 'bo', name: 'Bo Lindqvist' }
const cy = { id: 'cy', name: 'Cy Park' }
const dee = { id: 'dee', name: 'Dee Mensah' }
const eli = { id: 'eli', name: 'Eli Brandt' }
const fay = { id: 'fay', name: 'Fay Okafor' }
const gus = { id: 'gus', name: 'Gus Ferreira' }
const hal = { id: 'hal', name: 'Hal Nakamura', archived: true }

/**
 * Four Services teams. Kids has three members, so its people span two of the fake's pages, and
 * its leader Fay is not listed among its people. Old is archived, and Hal's Services profile is.
 */
const TEAMS: FakeTeam[] = [
  { id: '11', name: 'Worship', members: [ana, bo], leaders: [ana] },
  { id: '12', name: 'Kids', members: [cy, dee, eli], leaders: [fay] },
  { id: '13', name: 'Old', members: [gus], leaders: [], archived: true },
  { id: '14', name: 'Parking', members: [ana, bo, hal], leaders: [] },
]

/** Everyone on a live team, as person IDs. */
const SERVING = ['ana', 'bo', 'cy', 'dee', 'eli', 'fay']

/** A fresh Planning Center organization whose sync account an administrator has connected. */
async function connectedChurch(
  teams: FakeTeam[] = TEAMS,
  options: {
    planningCenter?: FakePlanningCenterOptions
    rateLimit?: FakeServicesOptions['rateLimit']
  } = {},
) {
  const planningCenter = fakePlanningCenter(options.planningCenter)
  const organizationId = newOrganizationId()
  const services = fakeServices(planningCenter, {
    syncPersonId: 'sync',
    teams,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  })
  const connect = await connectSyncAccount(planningCenter, {
    organizationId,
    personId: 'sync',
    administrator: true,
  })
  expect(connect.session.status).toBe(204)
  return { planningCenter, services, organizationId, churchId: pcoChurchId(organizationId) }
}

/** The status of a person's request for a channel's history. */
async function historyStatus(churchId: string, personId: string, channelId: string) {
  return (await asMember(churchId, personId, `/channels/${channelId}/messages`)).status
}

/** The IDs of the channels of one kind a person lists. */
async function listedOfKind(churchId: string, personId: string, kind: string): Promise<string[]> {
  const { channels } = await listChannels(churchId, personId)
  return channels
    .filter((channel) => channel.kind === kind)
    .map((channel) => channel.id)
    .sort()
}

/** The Services calls made so far, with their bearer tokens and times. */
function servicesCalls() {
  return network.calls().filter((call) => call.url.startsWith(`${PLANNING_CENTER}/services/`))
}

async function post(churchId: string, personId: string, channelId: string, body: string) {
  const socket = await openSocket(churchId, personId, channelId)
  socket.send({ type: 'send', body })
  await socket.nextFrame()
  socket.close()
}

describe('the roster sync', () => {
  it('makes one team channel per live Services team, open to exactly its members and leaders', async () => {
    const { churchId } = await connectedChurch()

    await runScheduled()

    const expected: Record<string, string[]> = {
      ana: ['team-11', 'team-14'],
      bo: ['team-11', 'team-14'],
      cy: ['team-12'],
      dee: ['team-12'],
      eli: ['team-12'],
      fay: ['team-12'],
    }
    for (const personId of SERVING) {
      expect(await listedOfKind(churchId, personId, 'team'), personId).toEqual(expected[personId])
      for (const channelId of ['team-11', 'team-12', 'team-13', 'team-14']) {
        const status = expected[personId]?.includes(channelId) ? 200 : 404
        expect(await historyStatus(churchId, personId, channelId), `${personId} ${channelId}`).toBe(
          status,
        )
      }
    }
    const { channels } = await listChannels(churchId, 'bo')
    expect(channels.filter((channel) => channel.kind === 'team')).toEqual([
      {
        id: 'team-14',
        name: 'Parking',
        kind: 'team',
        canPost: true,
        unread: false,
        mentions: 0,
        lastMessage: null,
        alertLevel: 'mentions-and-team-announcements',
      },
      {
        id: 'team-11',
        name: 'Worship',
        kind: 'team',
        canPost: true,
        unread: false,
        mentions: 0,
        lastMessage: null,
        alertLevel: 'mentions-and-team-announcements',
      },
    ])
  })

  it('fills the team leads channel with exactly the Services team leaders', async () => {
    const { churchId } = await connectedChurch()

    await runScheduled()

    for (const personId of SERVING) {
      const leader = personId === 'ana' || personId === 'fay'
      expect(await listedOfKind(churchId, personId, 'team-leads'), personId).toEqual(
        leader ? ['team-leads'] : [],
      )
      expect(await historyStatus(churchId, personId, 'team-leads'), personId).toBe(
        leader ? 200 : 404,
      )
    }
  })

  it('lets a Services team leader post team announcements in their own team channel only, until they stop leading it', async () => {
    const { churchId, services } = await connectedChurch()
    const announce = (channelId: string) =>
      postFrame(churchId, 'ana', channelId, {
        type: 'send',
        body: 'Rehearsal moves to 6:30',
        teamAnnouncement: true,
      })
    const refusal = {
      type: 'error',
      reason: "Only this team's leaders post team announcements here.",
    }

    await runScheduled()

    expect(await announce('team-11')).toMatchObject({
      type: 'message',
      message: { authorId: 'ana', teamAnnouncement: true },
    })
    expect(await announce('team-14')).toEqual(refusal)
    const leads = (await listChannels(churchId, 'ana')).channels.filter((c) => c.leads === true)
    expect(leads.map((channel) => channel.id)).toEqual(['team-11'])

    services.setLeaders('11', [])
    await runScheduled()

    expect(await announce('team-11')).toEqual(refusal)
    expect((await listChannels(churchId, 'ana')).channels.some((c) => c.leads === true)).toBe(false)
  })

  it('puts everyone on any Services team in general, off-topic, prayer-requests and announcements', async () => {
    const { churchId } = await connectedChurch()

    await runScheduled()

    for (const personId of SERVING) {
      const { channels } = await listChannels(churchId, personId)
      expect(
        channels.filter((channel) => channel.kind === 'open' || channel.kind === 'announcements'),
        personId,
      ).toEqual([
        {
          id: 'announcements',
          name: 'announcements',
          kind: 'announcements',
          canPost: false,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'every-message',
        },
        {
          id: 'general',
          name: 'general',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
        {
          id: 'off-topic',
          name: 'off-topic',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
        {
          id: 'prayer-requests',
          name: 'prayer-requests',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
      ])
      for (const channelId of ['general', 'off-topic', 'prayer-requests', 'announcements']) {
        expect(await historyStatus(churchId, personId, channelId), personId).toBe(200)
      }
    }
    // On an archived team only, or archived in Services: not someone who serves.
    for (const personId of ['gus', 'hal']) {
      expect((await asMember(churchId, personId, '/channels')).status, personId).toBe(404)
      expect(await historyStatus(churchId, personId, 'general'), personId).toBe(404)
    }
  })

  it('takes a team channel and its history from a person removed from the team, live socket included', async () => {
    const { churchId, services } = await connectedChurch()
    await runScheduled()
    await post(churchId, 'ana', 'team-11', 'Rehearsal moved to 6')
    const bosSocket = await openSocket(churchId, 'bo', 'team-11')

    services.removeMember('11', 'bo')
    await runScheduled()

    expect(await listedOfKind(churchId, 'bo', 'team')).toEqual(['team-14'])
    expect(await historyStatus(churchId, 'bo', 'team-11')).toBe(404)
    expect(await bosSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    const socketAgain = await asMember(churchId, 'bo', '/channels/team-11/socket', {
      headers: { upgrade: 'websocket' },
    })
    expect(socketAgain.status).toBe(404)
    // Bo still serves on Parking, so he keeps it and the church-wide channels.
    expect(await historyStatus(churchId, 'bo', 'team-14')).toBe(200)
    expect(await historyStatus(churchId, 'bo', 'general')).toBe(200)
    // Ana still reads the team channel and its history.
    const history = await readHistory(churchId, 'ana', 'team-11')
    expect(history.messages.map((message) => message.body)).toEqual(['Rehearsal moved to 6'])
  })

  it("still closes every other lost socket when one channel's eviction fails, and retries that one on the next sync", async () => {
    const { churchId, services } = await connectedChurch()
    await runScheduled()
    const bosSocket = await openSocket(churchId, 'bo', 'team-11')
    const cysSocket = await openSocket(churchId, 'cy', 'team-12')

    services.removeMember('11', 'bo')
    services.removeMember('12', 'cy')
    await syncAllChurches(envWithFailingEvict(channelObjectName(churchId, 'team-11')))

    expect(await cysSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect(await historyStatus(churchId, 'bo', 'team-11')).toBe(404)

    await runScheduled()

    expect(await bosSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
  })

  it("keeps a failed eviction's socket open once the person is back on the team by the next sync", async () => {
    const { churchId, services } = await connectedChurch()
    await runScheduled()
    const bosSocket = await openSocket(churchId, 'bo', 'team-11')

    services.removeMember('11', 'bo')
    await syncAllChurches(envWithFailingEvict(channelObjectName(churchId, 'team-11')))
    services.addMember('11', bo)
    await runScheduled()

    await post(churchId, 'ana', 'team-11', 'Welcome back')
    expect(await bosSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { body: 'Welcome back' },
    })
  })

  it('refuses a socket the Worker let through just before the person lost the channel', async () => {
    const { churchId, services } = await connectedChurch()
    await runScheduled()
    services.removeMember('11', 'bo')
    await runScheduled()

    // What reaches the channel when the sync lands between the Worker's check and its forward.
    const response = await env.CHANNEL.getByName(channelObjectName(churchId, 'team-11')).fetch(
      'https://channel.internal/socket',
      {
        headers: {
          upgrade: 'websocket',
          [HOLDER_HEADERS.churchId]: churchId,
          [HOLDER_HEADERS.channelId]: 'team-11',
          [HOLDER_HEADERS.personId]: 'bo',
        },
      },
    )

    expect(response.status).toBe(404)
    expect(response.webSocket).toBeNull()
  })

  it('takes away a person who left every team: no session works and no new sign-in starts', async () => {
    const { churchId, planningCenter, services, organizationId } = await connectedChurch()
    await runScheduled()
    const first = await signIn(planningCenter, { organizationId, personId: 'eli' })
    expect(first.session.status).toBe(200)
    const { token } = JSON.parse(first.sessionBody) as SignInSession
    expect((await asSession(token, '/me')).status).toBe(200)

    services.removeMember('12', 'eli')
    await runScheduled()

    expect((await asSession(token, '/me')).status).toBe(401)
    expect((await asSession(token, '/channels')).status).toBe(401)
    const again = await signIn(planningCenter, { organizationId, personId: 'eli' })
    expect(again.session.status).toBe(403)
    expect(JSON.parse(again.sessionBody)).toEqual({ problem: 'not-known' })
    // Everyone still on Kids is unaffected.
    expect(await historyStatus(churchId, 'cy', 'team-12')).toBe(200)
  })
})

/**
 * A connected church whose first admin, Ivy, works in the church office: she connected the church
 * as a Planning Center administrator, and serves on no Services team and is in no Group. With
 * `syncFirst`, a sync runs before she connects, so the synced channels already exist.
 *
 * Her adult birthdate is seeded before she connects: the sync never reads the birthdate of an
 * admin on no team, and with none on file the youth rule (phon#18) would treat her as a minor.
 */
async function churchWithOfficeAdmin(options: { syncFirst?: boolean } = {}) {
  const church = await connectedChurch()
  if (options.syncFirst === true) await runScheduled()
  await seedChurch({
    churchId: church.churchId,
    people: [{ personId: 'ivy', name: 'Ivy Chen' }],
    channels: [],
  })
  const connect = await connectChurch(church.planningCenter, {
    organizationId: church.organizationId,
    personId: 'ivy',
    administrator: true,
    claims: { name: 'Ivy Chen' },
  })
  expect(connect.session.status).toBe(200)
  const { token } = JSON.parse(connect.sessionBody) as SignInSession
  return { ...church, ivyToken: token }
}

/** A person's own `/me`, read with a session token: its status, and the role it names. */
async function meOf(token: string): Promise<{ status: number; role: Role | undefined }> {
  const response = await asSession(token, '/me')
  if (response.status !== 200) return { status: response.status, role: undefined }
  return { status: 200, role: ((await response.json()) as Member).role }
}

/** Signs a person in through the deployed entry, and answers their `/me`. */
async function signInAndMe(
  planningCenter: ReturnType<typeof fakePlanningCenter>,
  organizationId: number,
  personId: string,
) {
  const run = await signIn(planningCenter, { organizationId, personId })
  if (run.session.status !== 200) return { status: run.session.status, role: undefined }
  return meOf((JSON.parse(run.sessionBody) as SignInSession).token)
}

/** The church-wide channels a person lists with a session: `open` and `announcements` kinds. */
async function churchWideOf(token: string) {
  const response = await asSession(token, '/channels')
  expect(response.status).toBe(200)
  const { channels } = (await response.json()) as ChannelList
  return channels.filter((channel) => channel.kind === 'open' || channel.kind === 'announcements')
}

/** Opens a channel's WebSocket with a session, through the deployed entry. */
async function sessionSocket(token: string, channelId: string) {
  const response = await asSession(token, `/channels/${channelId}/socket`, {
    headers: { upgrade: 'websocket' },
  })
  return acceptSocket(response, channelId)
}

/** Sends one message with a session on a fresh socket, and answers the first frame back. */
async function sendWith(token: string, channelId: string, body: string) {
  const socket = await sessionSocket(token, channelId)
  try {
    socket.send({ type: 'send', body })
    return await socket.nextFrame()
  } finally {
    socket.close()
  }
}

/** The church-wide channels, each as a person who may post in all four lists it. */
const CHURCH_WIDE_POSTING = [
  {
    id: 'announcements',
    name: 'announcements',
    kind: 'announcements',
    canPost: true,
    unread: false,
    mentions: 0,
    lastMessage: null,
    alertLevel: 'every-message',
  },
  {
    id: 'general',
    name: 'general',
    kind: 'open',
    canPost: true,
    unread: false,
    mentions: 0,
    lastMessage: null,
    alertLevel: 'mentions',
  },
  {
    id: 'off-topic',
    name: 'off-topic',
    kind: 'open',
    canPost: true,
    unread: false,
    mentions: 0,
    lastMessage: null,
    alertLevel: 'mentions',
  },
  {
    id: 'prayer-requests',
    name: 'prayer-requests',
    kind: 'open',
    canPost: true,
    unread: false,
    mentions: 0,
    lastMessage: null,
    alertLevel: 'mentions',
  },
]

/** Sets a person's role as an admin, through the deployed entry. */
async function assignRole(adminToken: string, personId: string, role: Role) {
  const response = await asSession(adminToken, `/people/${personId}/role`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  expect(response.status).toBe(204)
}

describe('the roster sync and the people who hold a role', () => {
  it('keeps the first admin, on no team and in no Group, current: their session, sign-in and role survive a sync', async () => {
    const { planningCenter, organizationId, ivyToken } = await churchWithOfficeAdmin()

    await runScheduled()
    await runScheduled()

    expect(await meOf(ivyToken)).toEqual({ status: 200, role: 'admin' })
    expect(await signInAndMe(planningCenter, organizationId, 'ivy')).toEqual({
      status: 200,
      role: 'admin',
    })
  })

  it('keeps a chat admin taken off every team current, with their role', async () => {
    const { planningCenter, services, organizationId, ivyToken } = await churchWithOfficeAdmin()
    await runScheduled()
    await assignRole(ivyToken, 'bo', 'chat-admin')

    services.removeMember('11', 'bo')
    services.removeMember('14', 'bo')
    await runScheduled()
    await runScheduled()

    expect(await signInAndMe(planningCenter, organizationId, 'bo')).toEqual({
      status: 200,
      role: 'chat-admin',
    })
  })

  it('still marks a member on no team as left, beside an admin on no team who stays', async () => {
    const { planningCenter, services, organizationId, ivyToken } = await churchWithOfficeAdmin()
    await runScheduled()
    const cy = await signIn(planningCenter, { organizationId, personId: 'cy' })
    const { token: cyToken } = JSON.parse(cy.sessionBody) as SignInSession

    services.removeMember('12', 'cy')
    await runScheduled()

    expect(await meOf(cyToken)).toEqual({ status: 401, role: undefined })
    expect(await signInAndMe(planningCenter, organizationId, 'cy')).toEqual({
      status: 403,
      role: undefined,
    })
    expect(await meOf(ivyToken)).toEqual({ status: 200, role: 'admin' })
  })

  it('marks an admin on no team as left at the next sync once they are made a member', async () => {
    const { planningCenter, services, organizationId, ivyToken } = await churchWithOfficeAdmin()
    await runScheduled()
    await assignRole(ivyToken, 'bo', 'admin')
    services.removeMember('11', 'bo')
    services.removeMember('14', 'bo')
    await runScheduled()
    const bo = await signIn(planningCenter, { organizationId, personId: 'bo' })
    expect(bo.session.status).toBe(200)
    const { token: boToken } = JSON.parse(bo.sessionBody) as SignInSession

    await assignRole(ivyToken, 'bo', 'member')
    expect(await meOf(boToken)).toEqual({ status: 200, role: 'member' })
    await runScheduled()

    expect(await meOf(boToken)).toEqual({ status: 401, role: undefined })
    expect(await signInAndMe(planningCenter, organizationId, 'bo')).toEqual({
      status: 403,
      role: undefined,
    })
  })

  it('lets the first admin, on no team and in no Group, open the church-wide channels as a member after a sync, post in announcements and create an open channel', async () => {
    const { ivyToken } = await churchWithOfficeAdmin()

    await runScheduled()

    // Listed as a member: no `oversight` mark on any of the four.
    expect(await churchWideOf(ivyToken)).toEqual(CHURCH_WIDE_POSTING)
    for (const channelId of ['general', 'off-topic', 'prayer-requests', 'announcements']) {
      const history = await asSession(ivyToken, `/channels/${channelId}/messages`)
      expect(history.status, channelId).toBe(200)
    }
    expect(await sendWith(ivyToken, 'announcements', 'The office is closed Monday')).toMatchObject({
      type: 'message',
      message: { authorId: 'ivy', body: 'The office is closed Monday' },
    })
    const me = (await (await asSession(ivyToken, '/me')).json()) as Member
    expect(me.canCreate).toEqual(['open', 'private'])
  })

  it('lets a chat admin taken off every team open the church-wide channels as a member and post in them', async () => {
    const { planningCenter, services, organizationId, ivyToken } = await churchWithOfficeAdmin()
    await runScheduled()
    await assignRole(ivyToken, 'bo', 'chat-admin')

    services.removeMember('11', 'bo')
    services.removeMember('14', 'bo')
    await runScheduled()
    const bo = await signIn(planningCenter, { organizationId, personId: 'bo' })
    expect(bo.session.status).toBe(200)
    const { token: boToken } = JSON.parse(bo.sessionBody) as SignInSession

    expect(await churchWideOf(boToken)).toEqual(CHURCH_WIDE_POSTING)
    for (const channelId of ['general', 'announcements']) {
      expect(await sendWith(boToken, channelId, `Hello ${channelId}`), channelId).toMatchObject({
        type: 'message',
        message: { authorId: 'bo', body: `Hello ${channelId}` },
      })
    }
    const me = (await (await asSession(boToken, '/me')).json()) as Member
    expect(me.canCreate).toEqual(['open'])
  })

  it("keeps the first admin's live socket on general open through a sync", async () => {
    // A sync first, so general exists before Ivy connects the church and opens it.
    const { churchId, ivyToken } = await churchWithOfficeAdmin({ syncFirst: true })
    const ivysSocket = await sessionSocket(ivyToken, 'general')

    await runScheduled()

    await post(churchId, 'ana', 'general', 'Coffee in the lobby')
    expect(await ivysSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { authorId: 'ana', body: 'Coffee in the lobby' },
    })
    ivysSocket.close()
  })

  it('still takes out an admin whose Planning Center birthdate turns out to be under 13', async () => {
    const { planningCenter, services, organizationId, ivyToken } = await churchWithOfficeAdmin()
    await runScheduled()
    await assignRole(ivyToken, 'eli', 'admin')
    const eli = await signIn(planningCenter, { organizationId, personId: 'eli' })
    const { token: eliToken } = JSON.parse(eli.sessionBody) as SignInSession
    expect(await meOf(eliToken)).toEqual({ status: 200, role: 'admin' })

    services.setBirthdate('eli', birthdateFor(12))
    await runScheduled()

    expect(await meOf(eliToken)).toEqual({ status: 401, role: undefined })
    expect(await signInAndMe(planningCenter, organizationId, 'eli')).toEqual({
      status: 403,
      role: undefined,
    })
  })
})

describe('the roster sync and a private channel', () => {
  it('closes a private channel to its last two members once the third leaves the church, live sockets included, and an admin still reads it', async () => {
    const { churchId, services, ivyToken } = await churchWithOfficeAdmin()
    await runScheduled()
    const created = await asSession(ivyToken, '/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Core', kind: 'private', memberIds: ['bo', 'cy', 'eli'] }),
    })
    expect(created.status).toBe(201)
    const channelId = ((await created.json()) as ChannelSummary).id
    const bosSocket = await openSocket(churchId, 'bo', channelId)
    const cysSocket = await openSocket(churchId, 'cy', channelId)

    services.removeMember('12', 'eli')
    await runScheduled()

    expect(await bosSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect(await cysSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    for (const personId of ['bo', 'cy']) {
      expect(await historyStatus(churchId, personId, channelId), personId).toBe(404)
      expect(await listedOfKind(churchId, personId, 'private'), personId).toEqual([])
    }
    expect((await asSession(ivyToken, `/channels/${channelId}/messages`)).status).toBe(200)

    services.addMember('12', eli)
    await runScheduled()

    for (const personId of ['bo', 'cy', 'eli']) {
      expect(await historyStatus(churchId, personId, channelId), personId).toBe(200)
    }
  })
})

describe("the roster sync and Planning Center's rate limit", () => {
  it('waits out a 429 for its Retry-After, repeats the call, and completes', async () => {
    const { churchId, services } = await connectedChurch()
    services.throttle('/services/v2/teams', ['1'])

    await runScheduled()

    const calls = servicesCalls()
    const [throttled, repeated] = calls
    expect(throttled?.url).toBe(`${PLANNING_CENTER}/services/v2/teams?per_page=100`)
    expect(repeated?.url).toBe(throttled?.url)
    expect((repeated?.at ?? 0) - (throttled?.at ?? 0)).toBeGreaterThanOrEqual(1000)
    expect(await listedOfKind(churchId, 'ana', 'team')).toEqual(['team-11', 'team-14'])
    expect(await listedOfKind(churchId, 'fay', 'team-leads')).toEqual(['team-leads'])
  })

  it('waits the rate period once an answer says the limit is reached, before its next call', async () => {
    const { churchId } = await connectedChurch([TEAMS[0] as FakeTeam], {
      rateLimit: { limit: 2, periodSeconds: 1 },
    })

    await runScheduled()

    // Teams, Worship's people, Worship's leaders: the second answer reports 2 of 2.
    const calls = servicesCalls()
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/services/v2/teams',
      '/services/v2/teams/11/people',
      '/services/v2/teams/11/team_leaders',
    ])
    expect((calls[2]?.at ?? 0) - (calls[1]?.at ?? 0)).toBeGreaterThanOrEqual(1000)
    expect(await listedOfKind(churchId, 'bo', 'team')).toEqual(['team-11'])
  })

  it('changes nothing when Planning Center still answers 429 after five retries', async () => {
    const { churchId, services } = await connectedChurch()
    await runScheduled()
    // Worship is read first and Parking last, so a sync that applied what it had read would
    // already have taken Worship from Bo.
    services.removeMember('11', 'bo')
    services.throttle('/services/v2/teams/14/people', ['0', '0', '0', '0', '0', '0'])

    await runScheduled()

    const parkingCalls = servicesCalls().filter(
      (call) => call.url === `${PLANNING_CENTER}/services/v2/teams/14/people?per_page=100`,
    )
    // Parking's first page: one read in the first sync, then one call and five retries.
    expect(parkingCalls).toHaveLength(7)
    expect(await listedOfKind(churchId, 'bo', 'team')).toEqual(['team-11', 'team-14'])
    expect(await historyStatus(churchId, 'bo', 'team-11')).toBe(200)
  })
})

describe("the roster sync's token", () => {
  it("reads with the sync account's token only, never a volunteer's", async () => {
    const { planningCenter, organizationId } = await connectedChurch()
    await runScheduled()
    const before = planningCenter.issuedTokens()
    const volunteer = await signIn(planningCenter, { organizationId, personId: 'ana' })
    expect(volunteer.session.status).toBe(200)
    const volunteerTokens = planningCenter.issuedTokens().filter((token) => !before.includes(token))
    expect(volunteerTokens).toHaveLength(3)

    await runScheduled()

    const calls = servicesCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${planningCenter.accessTokenOf('sync')}`)
    }
    for (const call of network.calls()) {
      const sent = `${JSON.stringify(call.headers)}\n${call.url}\n${call.body ?? ''}`
      for (const token of volunteerTokens) expect(sent).not.toContain(token)
    }
  })

  it('refreshes an access token about to expire before it reads, and reads with the new one', async () => {
    // Every token expires within the refresh margin, so every sync refreshes.
    const { planningCenter, churchId, services } = await connectedChurch(TEAMS, {
      planningCenter: { codeTokenLifetime: 60, refreshTokenLifetime: 60 },
    })
    let previous = planningCenter.accessTokenOf('sync')

    // The second sync can refresh only with the refresh token the first one stored, because
    // Planning Center rotates it and refuses a used one.
    for (const round of [1, 2]) {
      if (round === 2) services.removeMember('11', 'bo')
      const callsBefore = network.calls().length

      await runScheduled()

      const refreshed = planningCenter.accessTokenOf('sync')
      expect(refreshed, `round ${round}`).not.toBe(previous)
      const sync = network.calls().slice(callsBefore)
      expect(sync[0]?.url, `round ${round}`).toBe(`${PLANNING_CENTER}/oauth/token`)
      expect(new URLSearchParams(sync[0]?.body ?? '').get('grant_type')).toBe('refresh_token')
      const reads = sync.filter((call) => call.url.startsWith(`${PLANNING_CENTER}/services/`))
      expect(reads.length, `round ${round}`).toBeGreaterThan(0)
      for (const call of reads) expect(call.headers.authorization).toBe(`Bearer ${refreshed}`)
      previous = refreshed
    }
    expect(await listedOfKind(churchId, 'ana', 'team')).toEqual(['team-11', 'team-14'])
    expect(await listedOfKind(churchId, 'bo', 'team')).toEqual(['team-14'])
  })
})
