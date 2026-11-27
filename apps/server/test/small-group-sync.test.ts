import { env } from 'cloudflare:workers'
import type { ChannelList, GroupTypeList, Member, Role, SignInSession } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { syncChurch } from '../src/roster-sync.ts'
import {
  acceptSocket,
  asMember,
  listChannels,
  openSocket,
  readHistory,
  readMe,
  setRole,
} from './support/church.ts'
import { fetchDeployed, runScheduled } from './support/deployed.ts'
import {
  asSession,
  connectChurch,
  connectSyncAccount,
  pcoChurchId,
  signIn,
} from './support/flows.ts'
import { type FakeGroupType, fakeGroups } from './support/groups.ts'
import { network } from './support/network.ts'
import { birthdateFor } from './support/people.ts'
import {
  fakePlanningCenter,
  newOrganizationId,
  PLANNING_CENTER,
} from './support/planning-center.ts'
import { type FakeTeam, fakeServices } from './support/services.ts'

const ana = { id: 'ana', name: 'Ana Ortiz' }
const bo = { id: 'bo', name: 'Bo Lindqvist' }
const cy = { id: 'cy', name: 'Cy Park' }
const dee = { id: 'dee', name: 'Dee Mensah' }
const eli = { id: 'eli', name: 'Eli Brandt' }
const fay = { id: 'fay', name: 'Fay Okafor' }
const gus = { id: 'gus', name: 'Gus Ferreira' }
const hal = { id: 'hal', name: 'Hal Nakamura' }
const ivy = { id: 'ivy', name: 'Ivy Chen' }
const jo = { id: 'jo', name: 'Jo Adeyemi' }
const kit = { id: 'kit', name: 'Kit Moreau' }

/** One Services team: Ana, the church's admin, and Bo serve on it. */
const TEAMS: FakeTeam[] = [{ id: '11', name: 'Worship', members: [ana, bo], leaders: [ana] }]

/**
 * Two Group types. Tuesday Night has five members (Bo serves, the rest do not), so its members
 * span the fake's pages; Eli leads it. Young Couples has two; Membership Class, of the other type,
 * three.
 */
const GROUP_TYPES: FakeGroupType[] = [
  {
    id: '21',
    name: 'Small Groups',
    groups: [
      {
        id: '301',
        name: 'Tuesday Night',
        members: [bo, cy, dee, { ...eli, role: 'leader' }, kit],
      },
      { id: '302', name: 'Young Couples', members: [fay, gus] },
    ],
  },
  {
    id: '22',
    name: 'Classes',
    groups: [{ id: '311', name: 'Membership Class', members: [hal, ivy, jo] }],
  },
]

/**
 * A fresh Planning Center organization with its sync account connected and Ana, who serves on
 * Worship, as the church's admin.
 */
async function groupChurch(groupTypes: FakeGroupType[] = GROUP_TYPES) {
  const planningCenter = fakePlanningCenter()
  const organizationId = newOrganizationId()
  const services = fakeServices(planningCenter, { syncPersonId: 'sync', teams: TEAMS })
  const groups = fakeGroups(planningCenter, { syncPersonId: 'sync', groupTypes })
  const sync = await connectSyncAccount(planningCenter, {
    organizationId,
    personId: 'sync',
    administrator: true,
  })
  expect(sync.session.status).toBe(204)
  const admin = await connectChurch(planningCenter, {
    organizationId,
    personId: 'ana',
    administrator: true,
  })
  expect(admin.session.status).toBe(200)
  return {
    planningCenter,
    services,
    groups,
    organizationId,
    churchId: pcoChurchId(organizationId),
  }
}

/** Sets a Group type's sync as the caller, through `PUT /group-types/:groupTypeId/sync`. */
function setGroupTypeSync(churchId: string, callerId: string, groupTypeId: string, body: unknown) {
  return asMember(churchId, callerId, `/group-types/${groupTypeId}/sync`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Turns a Group type's sync on as Ana, the admin. */
async function enable(churchId: string, groupTypeId: string, enabled = true) {
  const response = await setGroupTypeSync(churchId, 'ana', groupTypeId, { enabled })
  expect(response.status).toBe(204)
}

/** The Group types an admin lists. Fails when the route does not answer 200. */
async function listGroupTypes(churchId: string, callerId: string): Promise<GroupTypeList> {
  const response = await asMember(churchId, callerId, '/group-types')
  if (response.status !== 200) throw new Error(`/group-types answered ${response.status}`)
  return response.json()
}

/** The IDs of the channels of one kind a person lists. */
async function listedOfKind(churchId: string, personId: string, kind: string): Promise<string[]> {
  const { channels } = await listChannels(churchId, personId)
  return channels
    .filter((channel) => channel.kind === kind)
    .map((channel) => channel.id)
    .sort()
}

/** The status of a person's request for a channel's history. */
async function historyStatus(churchId: string, personId: string, channelId: string) {
  return (await asMember(churchId, personId, `/channels/${channelId}/messages`)).status
}

/** The status of a person's request to open a channel's socket. */
async function socketStatus(churchId: string, personId: string, channelId: string) {
  const response = await asMember(churchId, personId, `/channels/${channelId}/socket`, {
    headers: { upgrade: 'websocket' },
  })
  response.webSocket?.accept()
  response.webSocket?.close(1000, 'test done')
  return response.status
}

/** The paths of the Groups API calls made so far. */
function groupsPaths(): string[] {
  return network
    .calls()
    .filter((call) => call.url.startsWith(`${PLANNING_CENTER}/groups/`))
    .map((call) => new URL(call.url).pathname)
}

async function post(churchId: string, personId: string, channelId: string, body: string) {
  const socket = await openSocket(churchId, personId, channelId)
  socket.send({ type: 'send', body })
  await socket.nextFrame()
  socket.close()
}

describe('small group sync', () => {
  it('syncs no Group until an admin turns on its Group type', async () => {
    const { churchId, planningCenter, organizationId } = await groupChurch()

    await runScheduled()

    expect(groupsPaths()).toContain('/groups/v2/group_types')
    expect(groupsPaths().filter((path) => path !== '/groups/v2/group_types')).toEqual([])
    for (const personId of ['ana', 'bo']) {
      expect(await listedOfKind(churchId, personId, 'small-group'), personId).toEqual([])
    }
    for (const personId of ['cy', 'dee', 'eli', 'hal']) {
      expect((await asMember(churchId, personId, '/channels')).status, personId).toBe(404)
    }
    const cySignIn = await signIn(planningCenter, { organizationId, personId: 'cy' })
    expect(cySignIn.session.status).toBe(403)
    expect(await listGroupTypes(churchId, 'ana')).toEqual({
      groupTypes: [
        { id: '22', name: 'Classes', syncEnabled: false },
        { id: '21', name: 'Small Groups', syncEnabled: false },
      ],
    })

    await enable(churchId, '21')
    await runScheduled()

    expect(await listGroupTypes(churchId, 'ana')).toEqual({
      groupTypes: [
        { id: '22', name: 'Classes', syncEnabled: false },
        { id: '21', name: 'Small Groups', syncEnabled: true },
      ],
    })
    expect(await listedOfKind(churchId, 'cy', 'small-group')).toEqual(['group-301'])
    expect(await listedOfKind(churchId, 'bo', 'small-group')).toEqual(['group-301'])
    expect((await asMember(churchId, 'hal', '/channels')).status).toBe(404)
    expect(await historyStatus(churchId, 'cy', 'group-311')).toBe(404)
    expect(groupsPaths()).toContain('/groups/v2/group_types/21/groups')
    expect(groupsPaths()).toContain('/groups/v2/groups/301/memberships')
    expect(groupsPaths()).not.toContain('/groups/v2/group_types/22/groups')
    expect(groupsPaths()).not.toContain('/groups/v2/groups/311/memberships')
    const cyAgain = await signIn(planningCenter, { organizationId, personId: 'cy' })
    expect(cyAgain.session.status).toBe(200)
  })

  it('keeps a Group of two closed, opens its channel once a third member joins, and closes it again at two', async () => {
    const { churchId, groups } = await groupChurch()
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()

    for (const personId of ['fay', 'gus']) {
      expect(await listedOfKind(churchId, personId, 'small-group'), personId).toEqual([])
      expect(await historyStatus(churchId, personId, 'group-302'), personId).toBe(404)
      expect(await socketStatus(churchId, personId, 'group-302'), personId).toBe(404)
    }

    groups.addMember('302', hal)
    await runScheduled()

    for (const personId of ['fay', 'gus', 'hal']) {
      expect(await listedOfKind(churchId, personId, 'small-group'), personId).toEqual(['group-302'])
      expect(await historyStatus(churchId, personId, 'group-302'), personId).toBe(200)
    }
    const { channels } = await listChannels(churchId, 'fay')
    expect(channels).toEqual([
      {
        id: 'group-302',
        name: 'Young Couples',
        kind: 'small-group',
        canPost: true,
        unread: false,
        mentions: 0,
        lastMessage: null,
        alertLevel: 'mentions',
      },
    ])
    const gussSocket = await openSocket(churchId, 'gus', 'group-302')
    await post(churchId, 'fay', 'group-302', 'Dinner at ours on Friday')
    expect(await gussSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { body: 'Dinner at ours on Friday' },
    })

    groups.removeMember('302', 'hal')
    await runScheduled()

    expect(await gussSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    for (const personId of ['fay', 'gus']) {
      expect(await listedOfKind(churchId, personId, 'small-group'), personId).toEqual([])
      expect(await historyStatus(churchId, personId, 'group-302'), personId).toBe(404)
      expect(await socketStatus(churchId, personId, 'group-302'), personId).toBe(404)
    }
  })

  it('gives a Group member who serves on no Services team only their small group channels', async () => {
    const { churchId, planningCenter, organizationId } = await groupChurch()
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()

    const { channels } = await listChannels(churchId, 'cy')
    expect(channels).toEqual([
      {
        id: 'group-301',
        name: 'Tuesday Night',
        kind: 'small-group',
        canPost: true,
        unread: false,
        mentions: 0,
        lastMessage: null,
        alertLevel: 'mentions',
      },
    ])
    for (const channelId of ['general', 'off-topic', 'prayer-requests', 'announcements']) {
      expect(await historyStatus(churchId, 'cy', channelId), channelId).toBe(404)
      expect(await socketStatus(churchId, 'cy', channelId), channelId).toBe(404)
    }
    expect(await historyStatus(churchId, 'cy', 'group-301')).toBe(200)
    const signedIn = await signIn(planningCenter, { organizationId, personId: 'cy' })
    expect(signedIn.session.status).toBe(200)
    const { token } = JSON.parse(signedIn.sessionBody) as SignInSession
    expect((await asSession(token, '/me')).status).toBe(200)

    // Bo serves on Worship and is in the same Group: he lists both kinds.
    expect((await listChannels(churchId, 'bo')).channels.map((channel) => channel.id)).toEqual([
      'group-301',
      'team-11',
      'announcements',
      'general',
      'off-topic',
      'prayer-requests',
    ])
    expect(await historyStatus(churchId, 'bo', 'general')).toBe(200)
    expect(await historyStatus(churchId, 'bo', 'group-301')).toBe(200)
    // Named as Planning Center Groups gives the name.
    expect(await readMe(churchId, 'cy')).toMatchObject({ name: 'Cy Park', role: 'member' })
  })

  it('takes the church-wide channels from a person who stops serving but stays in a Group, live socket included', async () => {
    const { churchId, services } = await groupChurch()
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()
    const bosSocket = await openSocket(churchId, 'bo', 'general')

    // Bo leaves Worship, his only team, and stays in Tuesday Night.
    services.removeMember('11', 'bo')
    await runScheduled()

    expect(await bosSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect(await listChannels(churchId, 'bo')).toEqual({
      channels: [
        {
          id: 'group-301',
          name: 'Tuesday Night',
          kind: 'small-group',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
      ],
    })
    for (const channelId of ['general', 'off-topic', 'prayer-requests', 'announcements']) {
      expect(await historyStatus(churchId, 'bo', channelId), channelId).toBe(404)
      expect(await socketStatus(churchId, 'bo', channelId), channelId).toBe(404)
    }
    expect(await historyStatus(churchId, 'bo', 'group-301')).toBe(200)
  })

  it('names a person on a team and in a Group as Services does, whatever the Group calls them', async () => {
    const { churchId } = await groupChurch([
      {
        id: '21',
        name: 'Small Groups',
        groups: [
          {
            id: '301',
            name: 'Tuesday Night',
            members: [{ id: 'bo', name: 'Bobby Lindqvist' }, cy, dee],
          },
        ],
      },
    ])
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()

    expect(await listedOfKind(churchId, 'bo', 'small-group')).toEqual(['group-301'])
    expect(await readMe(churchId, 'bo')).toMatchObject({ name: 'Bo Lindqvist' })
    const response = await asMember(churchId, 'ana', '/people')
    expect(response.status).toBe(200)
    const { people } = (await response.json()) as {
      people: Array<{ personId: string; name: string }>
    }
    expect(people.find((person) => person.personId === 'bo')?.name).toBe('Bo Lindqvist')
  })

  it('offers a chat admin or admin who serves on no team, and is in a Group, an open channel to create', async () => {
    const { churchId } = await groupChurch()
    await runScheduled()
    await enable(churchId, '22')
    await runScheduled()
    // Hal and Ivy are only in Membership Class, so neither is on a team; their roles count them
    // as serving.
    expect((await setRole(churchId, 'ana', 'hal', 'chat-admin')).status).toBe(204)
    expect((await setRole(churchId, 'ana', 'ivy', 'admin')).status).toBe(204)

    expect(await readMe(churchId, 'hal')).toMatchObject({ role: 'chat-admin', canCreate: ['open'] })
    expect(await readMe(churchId, 'ivy')).toMatchObject({
      role: 'admin',
      canCreate: ['open', 'private'],
    })
    for (const personId of ['hal', 'ivy']) {
      const response = await asMember(churchId, personId, '/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `Open from ${personId}`, kind: 'open' }),
      })
      expect(response.status, personId).toBe(201)
    }
    expect((await listChannels(churchId, 'ana')).channels.map((channel) => channel.name)).toEqual(
      expect.arrayContaining(['Open from hal', 'Open from ivy']),
    )
    const privateChannel = await asMember(churchId, 'ivy', '/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Class helpers',
        kind: 'private',
        memberIds: ['hal', 'ivy', 'jo'],
      }),
    })
    expect(privateChannel.status).toBe(201)
  })

  it('takes a Group channel and its history from a person removed from the Group, live socket included', async () => {
    const { churchId, groups, planningCenter, organizationId } = await groupChurch()
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()
    await post(churchId, 'cy', 'group-301', 'Bring a friend next week')
    const bosSocket = await openSocket(churchId, 'bo', 'group-301')
    const deesSocket = await openSocket(churchId, 'dee', 'group-301')

    groups.removeMember('301', 'bo')
    groups.removeMember('301', 'dee')
    await runScheduled()

    for (const socket of [bosSocket, deesSocket]) {
      expect(await socket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    }
    // Bo still serves on Worship: he keeps his other channels, and only this one goes.
    expect(await listedOfKind(churchId, 'bo', 'small-group')).toEqual([])
    expect(await historyStatus(churchId, 'bo', 'group-301')).toBe(404)
    expect(await socketStatus(churchId, 'bo', 'group-301')).toBe(404)
    expect(await historyStatus(churchId, 'bo', 'general')).toBe(200)
    // Dee is in no other synced Group and on no team, so she can no longer sign in.
    expect((await asMember(churchId, 'dee', '/channels')).status).toBe(404)
    expect(await historyStatus(churchId, 'dee', 'group-301')).toBe(404)
    const deeSignIn = await signIn(planningCenter, { organizationId, personId: 'dee' })
    expect(deeSignIn.session.status).toBe(403)
    expect(JSON.parse(deeSignIn.sessionBody)).toEqual({ problem: 'not-known' })
    // Three remain, so the channel stays open to them with its history.
    for (const personId of ['cy', 'eli', 'kit']) {
      const history = await readHistory(churchId, personId, 'group-301')
      expect(
        history.messages.map((message) => message.body),
        personId,
      ).toEqual(['Bring a friend next week'])
    }
  })

  it('keeps the channel and its history when an admin turns the Group type off, and gives it back when they turn it on', async () => {
    const { churchId } = await groupChurch()
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()
    await post(churchId, 'cy', 'group-301', 'Potluck this week')
    const cysSocket = await openSocket(churchId, 'cy', 'group-301')

    await enable(churchId, '21', false)
    await runScheduled()

    expect(await cysSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect((await asMember(churchId, 'cy', '/channels')).status).toBe(404)
    expect(await listedOfKind(churchId, 'bo', 'small-group')).toEqual([])
    expect(await historyStatus(churchId, 'bo', 'group-301')).toBe(404)

    await enable(churchId, '21')
    await runScheduled()

    const history = await readHistory(churchId, 'cy', 'group-301')
    expect(history.messages.map((message) => message.body)).toEqual(['Potluck this week'])
  })

  it('lists a new Group type turned off, and never syncs its archived Groups', async () => {
    const { churchId, groups } = await groupChurch()
    await runScheduled()
    groups.addGroupType({
      id: '23',
      name: 'Retreats',
      groups: [
        { id: '321', name: 'Fall Retreat', archived: true, members: [cy, dee, eli] },
        { id: '322', name: 'Spring Retreat', members: [fay, gus, hal] },
      ],
    })

    await runScheduled()

    expect((await listGroupTypes(churchId, 'ana')).groupTypes).toContainEqual({
      id: '23',
      name: 'Retreats',
      syncEnabled: false,
    })

    await enable(churchId, '23')
    await runScheduled()

    expect(await listedOfKind(churchId, 'fay', 'small-group')).toEqual(['group-322'])
    expect((await asMember(churchId, 'cy', '/channels')).status).toBe(404)
    expect(await historyStatus(churchId, 'fay', 'group-321')).toBe(404)
    expect(groupsPaths()).not.toContain('/groups/v2/groups/321/memberships')
  })

  it("reads Groups with the sync account's token only, and waits out a 429 on a Groups call", async () => {
    const { churchId, groups, planningCenter } = await groupChurch()
    await runScheduled()
    await enable(churchId, '21')
    groups.throttle('/groups/v2/groups/301/memberships', ['1'])

    await runScheduled()

    const calls = network
      .calls()
      .filter((call) => call.url.startsWith(`${PLANNING_CENTER}/groups/`))
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${planningCenter.accessTokenOf('sync')}`)
    }
    const memberships = calls.filter(
      (call) => new URL(call.url).pathname === '/groups/v2/groups/301/memberships',
    )
    const [throttled, repeated] = memberships
    expect(repeated?.url).toBe(throttled?.url)
    expect((repeated?.at ?? 0) - (throttled?.at ?? 0)).toBeGreaterThanOrEqual(1000)
    expect(await listedOfKind(churchId, 'cy', 'small-group')).toEqual(['group-301'])
  })

  it('applies the Services roster while the Group types read fails and no Group type is on, and keeps the type list', async () => {
    const { churchId, services } = await groupChurch()
    await runScheduled()
    failGroupTypesRead()

    // Bo leaves Worship, his only team.
    services.removeMember('11', 'bo')
    await runScheduled()

    expect((await asMember(churchId, 'bo', '/channels')).status).toBe(404)
    expect(await historyStatus(churchId, 'bo', 'general')).toBe(404)
    expect(await listGroupTypes(churchId, 'ana')).toEqual({
      groupTypes: [
        { id: '22', name: 'Classes', syncEnabled: false },
        { id: '21', name: 'Small Groups', syncEnabled: false },
      ],
    })
  })

  it('keeps every Group channel while the Group types read fails and a Group type is on', async () => {
    const { churchId } = await groupChurch()
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()
    failGroupTypesRead()

    await runScheduled()

    expect(await listedOfKind(churchId, 'cy', 'small-group')).toEqual(['group-301'])
    expect(await historyStatus(churchId, 'cy', 'group-301')).toBe(200)
  })

  it('applies the Services roster while the Group types read fails and the only type on was deleted in Planning Center', async () => {
    const { churchId, planningCenter, services } = await groupChurch()
    await runScheduled()
    await enable(churchId, '22')
    await runScheduled()
    // The church deletes Classes in Planning Center while its sync is on.
    const remaining = GROUP_TYPES.filter((type) => type.id !== '22')
    fakeGroups(planningCenter, { syncPersonId: 'sync', groupTypes: remaining })
    await runScheduled()
    failGroupTypesRead()

    // Bo leaves Worship, his only team.
    services.removeMember('11', 'bo')
    await runScheduled()

    expect((await asMember(churchId, 'bo', '/channels')).status).toBe(404)
    expect(await historyStatus(churchId, 'bo', 'general')).toBe(404)
  })
})

/**
 * Answers every Group types read with 403, as Planning Center might for an organization without
 * Groups.
 */
function failGroupTypesRead(): void {
  network.stubPath(
    'GET',
    `${PLANNING_CENTER}/groups/v2/group_types`,
    () => new Response('{"errors":[{"status":"403"}]}', { status: 403 }),
  )
}

/** The church-wide channels, each as a person who may post in all four lists it as a member. */
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

/**
 * A Group church synced with Small Groups on, so Cy, Dee, Eli and Kit are in Tuesday Night only,
 * and a sign-in through the deployed entry, as a session token, for Ana and for `personId`.
 */
async function syncedGroupChurchWith(personId: string) {
  const church = await groupChurch()
  await runScheduled()
  await enable(church.churchId, '21')
  await runScheduled()
  const sessionOf = async (id: string) => {
    const run = await signIn(church.planningCenter, {
      organizationId: church.organizationId,
      personId: id,
    })
    expect(run.session.status, id).toBe(200)
    return (JSON.parse(run.sessionBody) as SignInSession).token
  }
  return { ...church, anaToken: await sessionOf('ana'), token: await sessionOf(personId) }
}

/** Sets a person's role with an admin's session, through the deployed entry. */
async function assignRole(adminToken: string, personId: string, role: Role) {
  const response = await asSession(adminToken, `/people/${personId}/role`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  expect(response.status).toBe(204)
}

/** Every channel a person lists with a session. */
async function channelsOf(token: string): Promise<ChannelList['channels']> {
  const response = await asSession(token, '/channels')
  expect(response.status).toBe(200)
  return ((await response.json()) as ChannelList).channels
}

/** The church-wide channels a person lists with a session: the `open` and `announcements` kinds. */
async function churchWideOf(token: string) {
  return (await channelsOf(token)).filter(
    (channel) => channel.kind === 'open' || channel.kind === 'announcements',
  )
}

/** The status of a person's request for a channel's history, with a session. */
async function sessionHistoryStatus(token: string, channelId: string) {
  return (await asSession(token, `/channels/${channelId}/messages`)).status
}

/** The status of a person's request to open a channel's socket, with a session. */
async function sessionSocketStatus(token: string, channelId: string) {
  const response = await asSession(token, `/channels/${channelId}/socket`, {
    headers: { upgrade: 'websocket' },
  })
  response.webSocket?.accept()
  response.webSocket?.close(1000, 'test done')
  return response.status
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

/** A person's own `/me` with a session. */
async function meWith(token: string): Promise<Member> {
  const response = await asSession(token, '/me')
  expect(response.status).toBe(200)
  return response.json()
}

const TUESDAY_NIGHT = {
  id: 'group-301',
  name: 'Tuesday Night',
  kind: 'small-group',
  canPost: true,
  unread: false,
  mentions: 0,
  lastMessage: null,
  alertLevel: 'mentions',
}

describe('small group sync and the people who hold a role', () => {
  it('lets an admin on no team who is in a synced Group open the church-wide channels as a member, from the grant and after a sync, and post in announcements', async () => {
    const { anaToken, token: cyToken } = await syncedGroupChurchWith('cy')

    await assignRole(anaToken, 'cy', 'admin')
    expect(await churchWideOf(cyToken)).toEqual(CHURCH_WIDE_POSTING)
    await runScheduled()

    // Listed as a member: no `oversight` mark on any of the four.
    expect(await churchWideOf(cyToken)).toEqual(CHURCH_WIDE_POSTING)
    for (const channelId of ['general', 'off-topic', 'prayer-requests', 'announcements']) {
      expect(await sessionHistoryStatus(cyToken, channelId), channelId).toBe(200)
      expect(await sessionSocketStatus(cyToken, channelId), channelId).toBe(101)
    }
    expect(await sendWith(cyToken, 'announcements', 'Potluck after service')).toMatchObject({
      type: 'message',
      message: { authorId: 'cy', body: 'Potluck after service' },
    })
    // Still a member of Tuesday Night: no `oversight` mark on it.
    expect(await channelsOf(cyToken)).toContainEqual(TUESDAY_NIGHT)
    expect(await meWith(cyToken)).toMatchObject({ role: 'admin', canCreate: ['open', 'private'] })
  })

  it('lets a chat admin on no team who is in a synced Group open the church-wide channels as a member after a sync, and post in general', async () => {
    const { anaToken, token: kitToken } = await syncedGroupChurchWith('kit')

    await assignRole(anaToken, 'kit', 'chat-admin')
    await runScheduled()

    expect(await churchWideOf(kitToken)).toEqual(CHURCH_WIDE_POSTING)
    for (const channelId of ['general', 'off-topic', 'prayer-requests']) {
      expect(await sessionHistoryStatus(kitToken, channelId), channelId).toBe(200)
      expect(await sessionSocketStatus(kitToken, channelId), channelId).toBe(101)
    }
    expect(await sendWith(kitToken, 'general', 'Who has the projector key?')).toMatchObject({
      type: 'message',
      message: { authorId: 'kit', body: 'Who has the projector key?' },
    })
    expect(await meWith(kitToken)).toMatchObject({ role: 'chat-admin', canCreate: ['open'] })
  })

  it('takes the church-wide channels from a Group-only admin made a member, live socket included, and leaves their small group channel', async () => {
    const { anaToken, token: cyToken } = await syncedGroupChurchWith('cy')
    await assignRole(anaToken, 'cy', 'admin')
    await runScheduled()
    const cysSocket = await sessionSocket(cyToken, 'general')

    await assignRole(anaToken, 'cy', 'member')
    await runScheduled()

    expect(await cysSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect(await channelsOf(cyToken)).toEqual([TUESDAY_NIGHT])
    for (const channelId of ['general', 'off-topic', 'prayer-requests', 'announcements']) {
      expect(await sessionHistoryStatus(cyToken, channelId), channelId).toBe(404)
      expect(await sessionSocketStatus(cyToken, channelId), channelId).toBe(404)
    }
    expect(await sessionHistoryStatus(cyToken, 'group-301')).toBe(200)
    expect(await meWith(cyToken)).toMatchObject({ role: 'member', canCreate: [] })
  })
})

describe('the Group sync endpoints', () => {
  it('let only an admin list Group types and turn their sync on or off', async () => {
    const { churchId } = await groupChurch()
    await runScheduled()
    expect((await setRole(churchId, 'ana', 'bo', 'chat-admin')).status).toBe(204)
    await enable(churchId, '22')
    await runScheduled()

    // Bo is a chat admin; Hal, synced from Membership Class, a member.
    for (const personId of ['bo', 'hal']) {
      expect((await asMember(churchId, personId, '/group-types')).status, personId).toBe(403)
      const put = await setGroupTypeSync(churchId, personId, '21', { enabled: true })
      expect(put.status, personId).toBe(403)
    }
    expect((await asMember(churchId, 'nobody', '/group-types')).status).toBe(404)
    expect((await listGroupTypes(churchId, 'ana')).groupTypes).toEqual([
      { id: '22', name: 'Classes', syncEnabled: true },
      { id: '21', name: 'Small Groups', syncEnabled: false },
    ])
  })

  it("refuses a Group type this church's sync never saw, a bad body, and other methods", async () => {
    // Another church, synced first: the fakes are global, so its own sync runs before this one's.
    const other = await groupChurch([
      {
        id: '99',
        name: 'Elsewhere',
        groups: [{ id: '901', name: 'Far', members: [cy, dee, eli] }],
      },
    ])
    await runScheduled()
    const { churchId } = await groupChurch()
    await syncChurch(env, churchId)

    // The other church's Group type, and one no church has.
    expect((await setGroupTypeSync(churchId, 'ana', '99', { enabled: true })).status).toBe(404)
    expect((await setGroupTypeSync(churchId, 'ana', 'nope', { enabled: true })).status).toBe(404)
    for (const body of [{}, { enabled: 'yes' }, [true], null]) {
      const response = await setGroupTypeSync(churchId, 'ana', '21', body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect((await asMember(churchId, 'ana', '/group-types/21/sync')).status).toBe(405)
    expect((await asMember(churchId, 'ana', '/group-types', { method: 'POST' })).status).toBe(405)
    expect((await fetchDeployed('/group-types')).status).toBe(401)
    expect((await listGroupTypes(churchId, 'ana')).groupTypes.map((type) => type.id)).toEqual([
      '22',
      '21',
    ])
    expect(await listGroupTypes(other.churchId, 'ana')).toEqual({
      groupTypes: [{ id: '99', name: 'Elsewhere', syncEnabled: false }],
    })
  })

  it('lists no Group types before the first sync has run', async () => {
    const { churchId } = await groupChurch()

    expect(await listGroupTypes(churchId, 'ana')).toEqual({ groupTypes: [] })
    expect((await setGroupTypeSync(churchId, 'ana', '21', { enabled: true })).status).toBe(404)
  })
})

/** One Group type with one Group of these members, for the age rule tests. */
function oneGroup(members: FakeGroupType['groups'][number]['members']): FakeGroupType[] {
  return [
    { id: '21', name: 'Small Groups', groups: [{ id: '301', name: 'Tuesday Night', members }] },
  ]
}

/** A person's own birthdate status, through `GET /me/birthdate`. */
async function birthdateStatus(churchId: string, personId: string) {
  const response = await asMember(churchId, personId, '/me/birthdate')
  if (response.status !== 200) throw new Error(`/me/birthdate answered ${response.status}`)
  return response.json()
}

/** The People profile paths read so far. */
function peoplePaths(): string[] {
  return network
    .calls()
    .filter((call) => call.url.startsWith(`${PLANNING_CENTER}/people/v2/people/`))
    .map((call) => new URL(call.url).pathname)
}

describe('the age rules for Group members', () => {
  it('never syncs a Group-only person whose People birthdate is under 13, nor counts them toward the three', async () => {
    const { churchId } = await groupChurch(
      oneGroup([cy, dee, { ...kit, birthdate: birthdateFor(12) }]),
    )
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()

    expect((await asMember(churchId, 'kit', '/channels')).status).toBe(404)
    // Cy and Dee are left, two, so the Group's channel stays closed.
    expect(await listedOfKind(churchId, 'cy', 'small-group')).toEqual([])
    expect(await historyStatus(churchId, 'cy', 'group-301')).toBe(404)
    expect(peoplePaths()).toContain('/people/v2/people/kit')
  })

  it('never syncs a person Groups marks as a child, and reads no People profile for them', async () => {
    const { churchId } = await groupChurch(
      oneGroup([cy, dee, eli, { ...kit, child: true, birthdate: null }]),
    )
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()

    expect((await asMember(churchId, 'kit', '/channels')).status).toBe(404)
    expect(await listedOfKind(churchId, 'cy', 'small-group')).toEqual(['group-301'])
    expect(peoplePaths()).not.toContain('/people/v2/people/kit')
    expect(
      network
        .calls()
        .filter((call) => call.url.includes('/groups/v2/groups/301/memberships'))
        .every((call) => new URL(call.url).searchParams.get('fields[Person]')?.includes('child')),
    ).toBe(true)
  })

  it("gives a Group-only person the age group their People birthdate makes, or a minor's with none", async () => {
    const teen = birthdateFor(15)
    const adult = birthdateFor(30)
    const { churchId } = await groupChurch(
      oneGroup([
        { ...cy, birthdate: teen },
        { ...dee, birthdate: adult },
        { ...eli, birthdate: null },
      ]),
    )
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()

    expect(await birthdateStatus(churchId, 'cy')).toEqual({
      birthdate: teen,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
    expect(await birthdateStatus(churchId, 'dee')).toEqual({
      birthdate: adult,
      pendingBirthdate: null,
      ageGroup: 'adult',
    })
    expect(await birthdateStatus(churchId, 'eli')).toEqual({
      birthdate: null,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
    // Cy is a minor, who opens no small group (phon#17), and Dee is the Group's one adult.
    expect(await listedOfKind(churchId, 'cy', 'small-group')).toEqual([])
    expect(peoplePaths().sort()).toEqual(
      ['/people/v2/people/cy', '/people/v2/people/dee', '/people/v2/people/eli'].sort(),
    )
  })

  it('takes the birthdate of a person on a team and in a Group from Services, and reads no People profile for them', async () => {
    const { churchId, services } = await groupChurch(
      oneGroup([{ ...bo, birthdate: birthdateFor(12) }, cy, dee]),
    )
    const adult = birthdateFor(40)
    services.setBirthdate('bo', adult)
    await runScheduled()
    await enable(churchId, '21')
    await runScheduled()

    expect(await birthdateStatus(churchId, 'bo')).toEqual({
      birthdate: adult,
      pendingBirthdate: null,
      ageGroup: 'adult',
    })
    expect(await listedOfKind(churchId, 'bo', 'small-group')).toEqual(['group-301'])
    expect(peoplePaths()).not.toContain('/people/v2/people/bo')
  })
})
