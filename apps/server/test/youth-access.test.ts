import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { syncChurch } from '../src/roster-sync.ts'
import {
  acceptSocket,
  asMember,
  listChannels,
  openSocket,
  postMessage,
  readMe,
  seedChurch,
} from './support/church.ts'
import { ADULT_BIRTHDATE, birthdateFor } from './support/people.ts'

/**
 * The youth rule (phon#17): a minor, 13 to 17 or with no birthdate on file, opens announcements
 * while they count as serving, and the team and team leads channels they are a synced member of.
 * Nothing else: no open, small group or private channel, whatever their role.
 */

const ada = { personId: 'ada', name: 'Ada Brandt', role: 'admin' as const }
const tia = { personId: 'tia', name: 'Tia Okafor', birthdate: birthdateFor(15) }
const abe = { personId: 'abe', name: 'Abe Lund', birthdate: birthdateFor(30) }
const cal = { personId: 'cal', name: 'Cal Moreno' }
const dot = { personId: 'dot', name: 'Dot Varga' }
const eve = { personId: 'eve', name: 'Eve Sato' }

/** One channel of each kind with Tia and Abe as members, and a team Abe is on without Tia. */
const CHANNELS = [
  { channelId: 'news', name: 'Announcements', kind: 'announcements' as const },
  { channelId: 'general', name: 'General', kind: 'open' as const },
  { channelId: 'team-1', name: 'Worship', kind: 'team' as const, members: ['tia', 'abe'] },
  {
    channelId: 'leads-1',
    name: 'Worship leads',
    kind: 'team-leads' as const,
    members: ['tia', 'abe'],
  },
  {
    channelId: 'group-1',
    name: 'Tuesday group',
    kind: 'small-group' as const,
    members: ['tia', 'abe', 'cal', 'dot', 'eve'],
  },
  // The seed bypasses the check a private channel's members get, so a minor can be in one here.
  {
    channelId: 'staff',
    name: 'Staff',
    kind: 'private' as const,
    members: ['tia', 'abe', 'cal', 'dot'],
  },
  { channelId: 'team-2', name: 'Kids', kind: 'team' as const, members: ['abe'] },
]

/** Whether a person finds a channel listed, reads its history, and opens its socket. */
async function access(churchId: string, personId: string, channelId: string) {
  const { channels } = await listChannels(churchId, personId)
  const history = await asMember(churchId, personId, `/channels/${channelId}/messages`)
  const upgrade = await asMember(churchId, personId, `/channels/${channelId}/socket`, {
    headers: { upgrade: 'websocket' },
  })
  if (upgrade.status === 101) acceptSocket(upgrade, channelId).close()
  return {
    listed: channels.some((channel) => channel.id === channelId),
    history: history.status,
    socket: upgrade.status,
  }
}

const OPENS = { listed: true, history: 200, socket: 101 }
const REFUSED = { listed: false, history: 404, socket: 404 }

describe('a minor and an adult, channel kind by channel kind', () => {
  it.each([
    ['announcements', 'news', OPENS, OPENS],
    ['open', 'general', REFUSED, OPENS],
    ['team', 'team-1', OPENS, OPENS],
    ['team leads', 'leads-1', OPENS, OPENS],
    ['small group', 'group-1', REFUSED, OPENS],
    ['private', 'staff', REFUSED, OPENS],
  ])(
    '%s: the minor and the adult open it as the rule says',
    async (_kind, channelId, minor, adult) => {
      const { churchId } = await seedChurch({
        people: [ada, tia, abe, cal, dot, eve],
        channels: CHANNELS,
      })

      expect(await access(churchId, 'tia', channelId)).toEqual(minor)
      expect(await access(churchId, 'abe', channelId)).toEqual(adult)
    },
  )

  it('lists the minor announcements and their own team channels only, and every one to the adult', async () => {
    const { churchId } = await seedChurch({
      people: [ada, tia, abe, cal, dot, eve],
      channels: CHANNELS,
    })

    expect((await listChannels(churchId, 'tia')).channels.map((c) => c.id)).toEqual([
      'news',
      'team-1',
      'leads-1',
    ])
    expect((await listChannels(churchId, 'abe')).channels.map((c) => c.id)).toEqual([
      'news',
      'general',
      'team-2',
      'staff',
      'group-1',
      'team-1',
      'leads-1',
    ])
  })

  it('delivers the minor a post in their team channels, and refuses one anywhere else', async () => {
    const { churchId } = await seedChurch({
      people: [ada, tia, abe, cal, dot, eve],
      channels: CHANNELS,
    })

    expect((await postMessage(churchId, 'tia', 'team-1', 'Running late')).body).toBe('Running late')
    expect((await postMessage(churchId, 'tia', 'leads-1', 'Set list is up')).body).toBe(
      'Set list is up',
    )
    for (const channelId of ['general', 'group-1', 'staff']) {
      await expect(postMessage(churchId, 'tia', channelId, 'Hello')).rejects.toThrow(
        `Socket for ${channelId} answered 404`,
      )
      expect((await postMessage(churchId, 'abe', channelId, 'Hello')).body).toBe('Hello')
    }
  })

  it('keeps a team channel from a minor who is not on the team', async () => {
    const { churchId } = await seedChurch({
      people: [ada, tia, abe, cal, dot, eve],
      channels: CHANNELS,
    })

    expect(await access(churchId, 'tia', 'team-2')).toEqual(REFUSED)
    expect(await access(churchId, 'abe', 'team-2')).toEqual(OPENS)
  })

  it('never widens a minor admin past the rule, by membership or by oversight', async () => {
    const kid = {
      personId: 'kid',
      name: 'Kid Park',
      role: 'admin' as const,
      birthdate: birthdateFor(16),
    }
    const { churchId } = await seedChurch({
      people: [ada, tia, abe, cal, dot, eve, kid],
      channels: CHANNELS.map((channel) =>
        channel.channelId === 'group-1' || channel.channelId === 'staff'
          ? { ...channel, members: [...(channel.members ?? []), 'kid'] }
          : channel,
      ),
    })

    expect((await listChannels(churchId, 'kid')).channels.map((c) => c.id)).toEqual(['news'])
    for (const channelId of ['general', 'group-1', 'staff', 'team-1', 'leads-1', 'team-2']) {
      expect(await access(churchId, 'kid', channelId)).toEqual(REFUSED)
    }
    // The adult admin still reads every channel by oversight.
    expect((await listChannels(churchId, 'ada')).channels).toHaveLength(CHANNELS.length)
  })
})

describe('a person with no birthdate on file', () => {
  const nan = { personId: 'nan', name: 'Nan Achebe', birthdate: null }

  it.each([
    ['announcements', 'news', OPENS],
    ['open', 'general', REFUSED],
    ['team', 'team-1', OPENS],
    ['team leads', 'leads-1', OPENS],
    ['small group', 'group-1', REFUSED],
    ['private', 'staff', REFUSED],
  ])("%s: gets a minor's access", async (_kind, channelId, expected) => {
    const { churchId } = await seedChurch({
      people: [ada, abe, cal, dot, eve, nan],
      channels: CHANNELS.map((channel) =>
        channel.members?.includes('tia')
          ? { ...channel, members: channel.members.map((id) => (id === 'tia' ? 'nan' : id)) }
          : channel,
      ),
    })

    expect(await access(churchId, 'nan', channelId)).toEqual(expected)
  })
})

describe('the three a small group needs', () => {
  it('counts only adults, so two adults and a minor stay closed to everyone', async () => {
    const { churchId } = await seedChurch({
      people: [ada, tia, abe, cal],
      channels: [
        {
          channelId: 'group-1',
          name: 'Tuesday group',
          kind: 'small-group',
          members: ['tia', 'abe', 'cal'],
        },
      ],
    })

    for (const personId of ['tia', 'abe', 'cal']) {
      expect(await access(churchId, personId, 'group-1'), personId).toEqual(REFUSED)
    }
  })

  it('opens to the three adults, and not the minor, once a third adult joins', async () => {
    const { churchId } = await seedChurch({
      people: [ada, tia, abe, cal, dot],
      channels: [
        {
          channelId: 'group-1',
          name: 'Tuesday group',
          kind: 'small-group',
          members: ['tia', 'abe', 'cal', 'dot'],
        },
      ],
    })

    for (const personId of ['abe', 'cal', 'dot']) {
      expect(await access(churchId, personId, 'group-1'), personId).toEqual(OPENS)
    }
    expect(await access(churchId, 'tia', 'group-1')).toEqual(REFUSED)
  })
})

describe('an adult whose Planning Center birthdate goes away', () => {
  it('loses the open channel and the small group live, and keeps their team', async () => {
    const { churchId } = await seedChurch({
      people: [ada, abe, cal, dot, eve],
      channels: [
        { channelId: 'general', name: 'General', kind: 'open' },
        {
          channelId: 'group-1',
          name: 'Tuesday group',
          kind: 'small-group',
          members: ['abe', 'cal', 'dot', 'eve'],
        },
        { channelId: 'team-1', name: 'Worship', kind: 'team', members: ['abe', 'cal'] },
      ],
    })
    const general = await openSocket(churchId, 'abe', 'general')
    const group = await openSocket(churchId, 'abe', 'group-1')
    const team = await openSocket(churchId, 'abe', 'team-1')

    await env.CHURCH_DIRECTORY.getByName(churchId).applyRoster(churchId, {
      people: [abe, cal, dot, eve].map(({ personId, name }) => ({
        personId,
        name,
        serves: true,
        birthdate: personId === 'abe' ? null : ADULT_BIRTHDATE,
        avatar: null,
      })),
      dropped: [],
      groupTypes: null,
      channels: [],
      // The synced memberships stay as they are: only Abe's birthdate changes.
      memberships: [
        ...['abe', 'cal', 'dot', 'eve'].map((personId) => ({ channelId: 'group-1', personId })),
        ...['abe', 'cal'].map((personId) => ({ channelId: 'team-1', personId })),
      ],
      leaders: [],
    })
    await syncChurch(env, churchId)

    expect(await general.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect(await group.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    for (const channelId of ['general', 'group-1']) {
      expect(await access(churchId, 'abe', channelId), channelId).toEqual(REFUSED)
    }
    team.send({ type: 'send', body: 'Still here' })
    expect(await team.nextFrame()).toMatchObject({
      type: 'message',
      message: { authorId: 'abe', body: 'Still here' },
    })
    team.close()
  })
})

describe('a private channel and a minor', () => {
  const nan = { personId: 'nan', name: 'Nan Achebe', birthdate: null }

  /** An admin's `POST /channels` for a private channel. */
  function createPrivate(churchId: string, memberIds: string[]) {
    return asMember(churchId, 'ada', '/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Core', kind: 'private', memberIds }),
    })
  }

  /** An admin's `PUT /channels/:id/members`. */
  function replaceMembers(churchId: string, channelId: string, personIds: string[]) {
    return asMember(churchId, 'ada', `/channels/${channelId}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds }),
    })
  }

  it.each([
    ['13 to 17', 'tia'],
    ['with no birthdate', 'nan'],
  ])(
    'refuses an admin a new one naming a minor %s with 400, and creates nothing',
    async (_l, minor) => {
      const { churchId } = await seedChurch({
        people: [ada, tia, nan, abe, cal, dot],
        channels: [],
      })

      expect((await createPrivate(churchId, ['abe', 'cal', minor])).status).toBe(400)

      for (const personId of ['ada', 'abe', 'cal']) {
        expect((await listChannels(churchId, personId)).channels, personId).toEqual([])
      }
    },
  )

  it.each([
    ['13 to 17', 'tia'],
    ['with no birthdate', 'nan'],
  ])(
    "refuses an admin's member change adding a minor %s with 400, and keeps the members",
    async (_l, minor) => {
      const { churchId } = await seedChurch({
        people: [ada, tia, nan, abe, cal, dot],
        channels: [
          { channelId: 'core', name: 'Core', kind: 'private', members: ['abe', 'cal', 'dot'] },
        ],
      })

      expect((await replaceMembers(churchId, 'core', ['abe', 'cal', minor])).status).toBe(400)

      const members = await asMember(churchId, 'ada', '/channels/core/members')
      expect(await members.json()).toEqual({ personIds: ['abe', 'cal', 'dot'] })
    },
  )

  it('still creates one for adults only', async () => {
    const { churchId } = await seedChurch({ people: [ada, tia, abe, cal, dot], channels: [] })

    expect((await createPrivate(churchId, ['abe', 'cal', 'dot'])).status).toBe(201)
  })

  it('gives a minor chat admin or admin no kind of channel to create', async () => {
    const { churchId } = await seedChurch({
      people: [
        ada,
        { ...tia, role: 'chat-admin' as const },
        { ...nan, role: 'admin' as const },
        { ...abe, role: 'chat-admin' as const },
      ],
      channels: [],
    })

    expect((await readMe(churchId, 'tia')).canCreate).toEqual([])
    expect((await readMe(churchId, 'nan')).canCreate).toEqual([])
    expect((await readMe(churchId, 'abe')).canCreate).toEqual(['open'])
    expect((await readMe(churchId, 'ada')).canCreate).toEqual(['open', 'private'])
  })

  it("keeps a private channel's members from a minor admin", async () => {
    const { churchId } = await seedChurch({
      people: [ada, { ...nan, role: 'admin' as const }, abe, cal, dot],
      channels: [
        { channelId: 'core', name: 'Core', kind: 'private', members: ['abe', 'cal', 'dot'] },
      ],
    })

    expect((await asMember(churchId, 'nan', '/channels/core/members')).status).toBe(404)
    const replaced = await asMember(churchId, 'nan', '/channels/core/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['abe', 'cal', 'nan'] }),
    })
    expect(replaced.status).toBe(404)
  })
})
