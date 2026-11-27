import { env } from 'cloudflare:workers'
import type {
  ChannelKind,
  ChannelList,
  ChannelMembers,
  ChannelSummary,
  CreatableChannelKind,
} from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { syncChurch } from '../src/roster-sync.ts'
import { asMember, listChannels, openSocket, seedChurch } from './support/church.ts'

// No direct message kind exists: TypeScript refuses each line below, so `pnpm typecheck` fails if
// one is ever added.
// @ts-expect-error
const _directKind: ChannelKind = 'direct'
// @ts-expect-error
const _directCreatable: CreatableChannelKind = 'direct'
// @ts-expect-error
const _directMessage: ChannelKind = 'dm'
void [_directKind, _directCreatable, _directMessage]

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor', role: 'chat-admin' as const }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const eli = { personId: 'eli', name: 'Eli Brandt' }
const PEOPLE = [ana, ben, cy, dee, eli]
const EVERYONE = PEOPLE.map((person) => person.personId)

const general = { channelId: 'general', name: 'general', kind: 'open' as const }

/** Posts a new channel as the caller. */
function create(churchId: string, callerId: string, body: unknown) {
  return asMember(churchId, callerId, '/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Every person's channel list, by person ID. */
async function everyonesChannels(churchId: string): Promise<Record<string, ChannelList>> {
  const lists: Record<string, ChannelList> = {}
  for (const personId of EVERYONE) lists[personId] = await listChannels(churchId, personId)
  return lists
}

describe('no direct message, from any role', () => {
  const attempts: Array<[string, unknown]> = [
    ['a direct kind', { name: 'Ana and Cy', kind: 'direct' }],
    ['a dm kind', { name: 'Ana and Cy', kind: 'dm' }],
    ['a direct-message kind', { name: 'Ana and Cy', kind: 'direct-message' }],
    ['a group-dm kind', { name: 'Ana, Cy and Dee', kind: 'group-dm' }],
    [
      'a direct kind with members',
      { name: 'Ana and Cy', kind: 'direct', memberIds: ['ana', 'cy'] },
    ],
    ['an announcements channel', { name: 'More announcements', kind: 'announcements' }],
    ['a team channel', { name: 'My team', kind: 'team' }],
    ['a team leads channel', { name: 'My leads', kind: 'team-leads' }],
    ['no kind', { name: 'Ana and Cy' }],
    ['a private channel of one', { name: 'Just me', kind: 'private', memberIds: ['cy'] }],
    ['a private channel of two', { name: 'Ana and Cy', kind: 'private', memberIds: ['ana', 'cy'] }],
    [
      'a private channel of two, one named twice',
      { name: 'Ana and Cy', kind: 'private', memberIds: ['ana', 'cy', 'cy'] },
    ],
    [
      'an open channel that names two people',
      { name: 'Ana and Cy', kind: 'open', memberIds: ['ana', 'cy'] },
    ],
  ]

  for (const caller of ['cy', 'ben', 'ana']) {
    it.each(attempts)(
      `refuses ${caller} %s, and no one's channels change`,
      async (_label, body) => {
        const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })
        const before = await everyonesChannels(churchId)

        const response = await create(churchId, caller, body)

        expect([400, 403]).toContain(response.status)
        expect(await everyonesChannels(churchId)).toEqual(before)
      },
    )
  }
})

describe('a member creating a channel', () => {
  it.each<[string, unknown]>([
    ['an open channel', { name: 'Coffee', kind: 'open' }],
    ['a private channel', { name: 'Staff', kind: 'private', memberIds: ['ana', 'ben', 'cy'] }],
    ['a body that is not JSON', 'not json'],
  ])('is refused with 403 for %s, and nothing is created', async (_label, body) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })
    const before = await everyonesChannels(churchId)

    const response = await asMember(churchId, 'cy', '/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

    expect(response.status).toBe(403)
    expect(await everyonesChannels(churchId)).toEqual(before)
  })
})

describe('a chat admin creating a channel', () => {
  it('creates an open channel that everyone in the church lists and opens', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    const response = await create(churchId, 'ben', { name: '  Coffee crew  ', kind: 'open' })

    expect(response.status).toBe(201)
    const created = (await response.json()) as ChannelSummary
    expect(created).toEqual({ id: created.id, name: 'Coffee crew', kind: 'open', canPost: true })
    for (const personId of EVERYONE) {
      expect((await listChannels(churchId, personId)).channels, personId).toEqual([
        {
          id: created.id,
          name: 'Coffee crew',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
      ])
      expect((await asMember(churchId, personId, `/channels/${created.id}/messages`)).status).toBe(
        200,
      )
    }
  })

  it('creates a channel another church never sees', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })
    const other = await seedChurch({ people: PEOPLE, channels: [] })

    const created = (await (
      await create(churchId, 'ben', { name: 'Coffee crew', kind: 'open' })
    ).json()) as ChannelSummary

    expect((await listChannels(other.churchId, 'cy')).channels).toEqual([])
    expect((await asMember(other.churchId, 'cy', `/channels/${created.id}/messages`)).status).toBe(
      404,
    )
  })

  it('cannot create a private channel, and nothing is created', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })
    const before = await everyonesChannels(churchId)

    const response = await create(churchId, 'ben', {
      name: 'Staff',
      kind: 'private',
      memberIds: ['ben', 'cy', 'dee'],
    })

    expect(response.status).toBe(403)
    expect(await everyonesChannels(churchId)).toEqual(before)
  })

  it.each<[string, unknown]>([
    ['an empty name', { name: '   ', kind: 'open' }],
    ['a name over 80 characters', { name: 'x'.repeat(81), kind: 'open' }],
    ['a name that is not text', { name: 7, kind: 'open' }],
    ['a body that is not an object', ['Coffee', 'open']],
  ])('answers 400 for %s', async (_label, body) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    expect((await create(churchId, 'ben', body)).status).toBe(400)
    expect((await listChannels(churchId, 'ben')).channels).toEqual([])
  })

  it('answers 409 for the name of a channel the church already has, in any case', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })

    expect((await create(churchId, 'ben', { name: 'General', kind: 'open' })).status).toBe(409)
    expect((await listChannels(churchId, 'ben')).channels.map((c) => c.id)).toEqual(['general'])
  })

  it('never takes a channel ID from the request', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })

    const response = await create(churchId, 'ben', {
      name: 'Coffee crew',
      kind: 'open',
      id: 'general',
      channelId: 'general',
    })

    expect(response.status).toBe(201)
    expect(((await response.json()) as ChannelSummary).id).not.toBe('general')
    expect((await listChannels(churchId, 'cy')).channels.map((c) => c.name)).toEqual([
      'Coffee crew',
      'general',
    ])
  })
})

describe('an admin creating a private channel', () => {
  it('creates it for exactly the people it names, and answers its members', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    const response = await create(churchId, 'ana', {
      name: 'Staff',
      kind: 'private',
      memberIds: ['ben', 'cy', 'dee'],
    })

    expect(response.status).toBe(201)
    const created = (await response.json()) as ChannelSummary
    expect(created).toMatchObject({ name: 'Staff', kind: 'private' })
    for (const personId of EVERYONE) {
      const inIt = ['ben', 'cy', 'dee'].includes(personId)
      // Ana is an admin outside it: she reads it by oversight, and may not post.
      const overseer = personId === 'ana'
      expect((await listChannels(churchId, personId)).channels, personId).toEqual(
        inIt
          ? [
              {
                id: created.id,
                name: 'Staff',
                kind: 'private',
                canPost: true,
                unread: false,
                mentions: 0,
                lastMessage: null,
                alertLevel: 'every-message',
              },
            ]
          : overseer
            ? [{ id: created.id, name: 'Staff', kind: 'private', canPost: false, oversight: true }]
            : [],
      )
      expect(
        (await asMember(churchId, personId, `/channels/${created.id}/messages`)).status,
        personId,
      ).toBe(inIt || overseer ? 200 : 404)
    }
    const members = await asMember(churchId, 'ana', `/channels/${created.id}/members`)
    expect(members.status).toBe(200)
    expect((await members.json()) as ChannelMembers).toEqual({ personIds: ['ben', 'cy', 'dee'] })
  })

  it('sets its members again, and a person taken out can no longer open it', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })
    const created = (await (
      await create(churchId, 'ana', {
        name: 'Staff',
        kind: 'private',
        memberIds: ['ben', 'cy', 'dee'],
      })
    ).json()) as ChannelSummary

    const response = await asMember(churchId, 'ana', `/channels/${created.id}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'cy', 'dee', 'eli'] }),
    })

    expect(response.status).toBe(204)
    expect((await asMember(churchId, 'ben', `/channels/${created.id}/messages`)).status).toBe(404)
    expect((await listChannels(churchId, 'ben')).channels).toEqual([])
    for (const personId of ['ana', 'cy', 'dee', 'eli']) {
      expect(
        (await listChannels(churchId, personId)).channels.map((c) => c.id),
        personId,
      ).toEqual([created.id])
      const socket = await openSocket(churchId, personId, created.id)
      socket.close()
    }
  })

  it("closes the live socket of a person taken out, and keeps everyone else's", async () => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ben', 'cy', 'dee'] },
      ],
    })
    const bensSocket = await openSocket(churchId, 'ben', 'staff')
    const cysSocket = await openSocket(churchId, 'cy', 'staff')

    const response = await asMember(churchId, 'ana', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['cy', 'dee', 'eli'] }),
    })

    expect(response.status).toBe(204)
    expect(await bensSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    cysSocket.send({ type: 'send', body: 'Staff only from here' })
    expect(await cysSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { authorId: 'cy', body: 'Staff only from here' },
    })
    expect(bensSocket.received()).toEqual([])
    cysSocket.close()
  })

  it('records the socket of a person taken out, so the next sync closes it when closing it failed', async () => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ben', 'cy', 'dee'] },
      ],
    })
    const bensSocket = await openSocket(churchId, 'ben', 'staff')
    const directory = env.CHURCH_DIRECTORY.getByName(churchId)

    // The directory's own write, with no eviction after it, as when closing the socket failed.
    expect(
      await directory.setChannelMembers({ churchId, personId: 'ana' }, 'staff', [
        'cy',
        'dee',
        'eli',
      ]),
    ).toBe('set')

    expect(await directory.pendingEvictions(churchId)).toEqual([
      { personId: 'ben', channelId: 'staff', takeMentions: true },
    ])
    await syncChurch(env, churchId)
    expect(await bensSocket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect(await directory.pendingEvictions(churchId)).toEqual([])
  })

  it('creates an open channel too', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    const response = await create(churchId, 'ana', { name: 'Coffee crew', kind: 'open' })

    expect(response.status).toBe(201)
    expect((await listChannels(churchId, 'cy')).channels.map((c) => c.name)).toEqual([
      'Coffee crew',
    ])
  })

  it.each<[string, unknown]>([
    ['a person of another church', ['ben', 'cy', 'zed']],
    ['no members', undefined],
    ['members that are not text', ['ben', 'cy', 3]],
  ])('answers 400 for %s, and nothing is created', async (_label, memberIds) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })
    await seedChurch({ people: [{ personId: 'zed', name: 'Zed of church B' }], channels: [] })

    const response = await create(churchId, 'ana', { name: 'Staff', kind: 'private', memberIds })

    expect(response.status).toBe(400)
    expect(await everyonesChannels(churchId)).toEqual(
      Object.fromEntries(EVERYONE.map((personId) => [personId, { channels: [] }])),
    )
  })

  it.each<[string, unknown]>([
    ['one person', { personIds: ['cy'] }],
    ['two people', { personIds: ['cy', 'dee'] }],
    ['a person of another church', { personIds: ['cy', 'dee', 'zed'] }],
    ['no list', {}],
  ])('refuses to set its members to %s, and keeps them', async (_label, body) => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ben', 'cy', 'dee'] },
      ],
    })

    const response = await asMember(churchId, 'ana', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(400)
    const members = await asMember(churchId, 'ana', '/channels/staff/members')
    expect((await members.json()) as ChannelMembers).toEqual({ personIds: ['ben', 'cy', 'dee'] })
  })

  it("answers 404 for another church's private channel of the same ID", async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })
    await seedChurch({
      people: PEOPLE,
      channels: [
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ben', 'cy', 'dee'] },
      ],
    })

    expect((await asMember(churchId, 'ana', '/channels/staff/members')).status).toBe(404)
  })

  it('cannot set the members of an open channel', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })

    const response = await asMember(churchId, 'ana', '/channels/general/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'cy', 'dee'] }),
    })

    expect(response.status).toBe(403)
  })
})

describe('a chat admin and a private channel', () => {
  const staff = {
    channelId: 'staff',
    name: 'Staff',
    kind: 'private' as const,
    members: ['ana', 'cy', 'dee'],
  }

  it('cannot add themselves to one they are not in, and still cannot list or open it', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [staff] })

    const response = await asMember(churchId, 'ben', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'ben', 'cy', 'dee'] }),
    })

    expect(response.status).toBe(404)
    expect((await listChannels(churchId, 'ben')).channels).toEqual([])
    expect((await asMember(churchId, 'ben', '/channels/staff/messages')).status).toBe(404)
    const members = await asMember(churchId, 'ana', '/channels/staff/members')
    expect((await members.json()) as ChannelMembers).toEqual({ personIds: ['ana', 'cy', 'dee'] })
  })

  it('cannot read its members when not in it', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [staff] })

    expect((await asMember(churchId, 'ben', '/channels/staff/members')).status).toBe(404)
  })

  it('cannot change the members of one they are in', async () => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [{ ...staff, members: ['ana', 'ben', 'cy'] }],
    })

    const response = await asMember(churchId, 'ben', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'ben', 'cy', 'eli'] }),
    })

    expect(response.status).toBe(403)
    expect((await asMember(churchId, 'ben', '/channels/staff/members')).status).toBe(403)
    expect((await listChannels(churchId, 'eli')).channels).toEqual([])
  })

  it('cannot add themselves by creating one', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [staff] })

    const response = await create(churchId, 'ben', {
      name: 'Staff two',
      kind: 'private',
      memberIds: ['ana', 'ben', 'cy'],
    })

    expect(response.status).toBe(403)
    expect((await listChannels(churchId, 'ben')).channels).toEqual([])
  })
})

describe('a member and a private channel', () => {
  it('cannot add themselves, whether in it or not', async () => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ana', 'ben', 'dee'] },
        { channelId: 'core', name: 'Core', kind: 'private', members: ['ana', 'cy', 'dee'] },
      ],
    })
    const put = (channelId: string, personIds: string[]) =>
      asMember(churchId, 'cy', `/channels/${channelId}/members`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personIds }),
      })

    expect((await put('staff', ['ana', 'ben', 'cy', 'dee'])).status).toBe(404)
    expect((await put('core', ['ana', 'cy', 'dee', 'eli'])).status).toBe(403)
    expect((await listChannels(churchId, 'cy')).channels.map((c) => c.id)).toEqual(['core'])
  })
})

describe('the members route', () => {
  it('answers 405 for a method other than GET or PUT', async () => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ana', 'cy', 'dee'] },
      ],
    })

    expect(
      (await asMember(churchId, 'ana', '/channels/staff/members', { method: 'POST' })).status,
    ).toBe(405)
  })
})
