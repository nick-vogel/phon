import type { PeopleList, Role } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
  asMember,
  listChannels,
  openSocket,
  readMe,
  seedChurch,
  setRole,
} from './support/church.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor', role: 'chat-admin' as const }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }

describe('who the signed-in person is, with their role', () => {
  it('tells a member they may create nothing and assign no roles', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [] })

    expect(await readMe(churchId, 'cy')).toEqual({
      personId: 'cy',
      name: 'Cy Park',
      role: 'member',
      canCreate: [],
      canAssignRoles: false,
      canReadOversight: false,
      canMarkUrgent: false,
      canManageBirthdates: false,
      canModerate: false,
      avatar: null,
    })
  })

  it('tells a chat admin they may create open channels only, and assign no roles', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [] })

    expect(await readMe(churchId, 'ben')).toEqual({
      personId: 'ben',
      name: 'Ben Okafor',
      role: 'chat-admin',
      canCreate: ['open'],
      canAssignRoles: false,
      canReadOversight: false,
      canMarkUrgent: true,
      canManageBirthdates: false,
      canModerate: true,
      avatar: null,
    })
  })

  it('tells an admin they may create open and private channels, and assign roles', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [] })

    expect(await readMe(churchId, 'ana')).toEqual({
      personId: 'ana',
      name: 'Ana Ortiz',
      role: 'admin',
      canCreate: ['open', 'private'],
      canAssignRoles: true,
      canReadOversight: true,
      canMarkUrgent: true,
      canManageBirthdates: true,
      canModerate: true,
      avatar: null,
    })
  })
})

describe('an admin assigning roles', () => {
  it('makes a member a chat admin, and then an admin', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [] })

    const toChatAdmin = await setRole(churchId, 'ana', 'cy', 'chat-admin')
    expect(toChatAdmin.status).toBe(204)
    expect(await readMe(churchId, 'cy')).toMatchObject({
      role: 'chat-admin',
      canCreate: ['open'],
      canAssignRoles: false,
      canReadOversight: false,
      canModerate: true,
    })

    const toAdmin = await setRole(churchId, 'ana', 'cy', 'admin')
    expect(toAdmin.status).toBe(204)
    expect(await readMe(churchId, 'cy')).toMatchObject({
      role: 'admin',
      canCreate: ['open', 'private'],
      canAssignRoles: true,
      canReadOversight: true,
    })
  })

  it('makes a chat admin a member again', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [] })

    expect((await setRole(churchId, 'ana', 'ben', 'member')).status).toBe(204)

    expect(await readMe(churchId, 'ben')).toMatchObject({
      role: 'member',
      canCreate: [],
      canModerate: false,
    })
  })

  it.each([
    ['a member', 'cy'],
    ['a chat admin', 'ben'],
  ])('refuses %s with 403, and changes nobody', async (_label, caller) => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [] })

    const response = await setRole(churchId, caller, 'dee', 'chat-admin')

    expect(response.status).toBe(403)
    expect(await readMe(churchId, 'dee')).toMatchObject({ role: 'member' })
  })

  it('refuses a chat admin who tries to make themselves an admin', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [] })

    const response = await setRole(churchId, 'ben', 'ben', 'admin')

    expect(response.status).toBe(403)
    expect(await readMe(churchId, 'ben')).toMatchObject({ role: 'chat-admin' })
  })

  it('answers 404 for a person the church does not know', async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [] })

    expect((await setRole(churchId, 'ana', 'stranger', 'admin')).status).toBe(404)
  })

  it.each([
    ['an unknown role', { role: 'owner' }],
    ['no role', {}],
    ['a body that is not an object', 'admin'],
  ])('answers 400 for %s', async (_label, body) => {
    const { churchId } = await seedChurch({ people: [ana, cy], channels: [] })

    const response = await asMember(churchId, 'ana', '/people/cy/role', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(400)
    expect(await readMe(churchId, 'cy')).toMatchObject({ role: 'member' })
  })

  it("refuses to demote the church's last admin, so a church always keeps one", async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [] })

    const response = await setRole(churchId, 'ana', 'ana', 'chat-admin')

    expect(response.status).toBe(409)
    expect(await readMe(churchId, 'ana')).toMatchObject({ role: 'admin' })
  })

  it('lets an admin step down once the church has another admin', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [] })
    await setRole(churchId, 'ana', 'ben', 'admin')

    expect((await setRole(churchId, 'ana', 'ana', 'member')).status).toBe(204)

    expect(await readMe(churchId, 'ana')).toMatchObject({ role: 'member' })
  })

  it("never changes another church's person of the same ID", async () => {
    const a = await seedChurch({ people: [ana, cy], channels: [] })
    const b = await seedChurch({
      people: [{ personId: 'cy', name: 'Cy in church B' }],
      channels: [],
    })

    await setRole(a.churchId, 'ana', 'cy', 'admin')

    expect(await readMe(b.churchId, 'cy')).toMatchObject({ role: 'member' })
  })

  it('answers 405 for a method other than PUT', async () => {
    const { churchId } = await seedChurch({ people: [ana, cy], channels: [] })

    expect((await asMember(churchId, 'ana', '/people/cy/role')).status).toBe(405)
  })
})

describe('the people of the church, for an admin', () => {
  it('lists every person with their role, sorted by name', async () => {
    const { churchId } = await seedChurch({ people: [dee, cy, ben, ana], channels: [] })

    const response = await asMember(churchId, 'ana', '/people')

    expect(response.status).toBe(200)
    expect((await response.json()) as PeopleList).toEqual({
      people: [
        { personId: 'ana', name: 'Ana Ortiz', role: 'admin' },
        { personId: 'ben', name: 'Ben Okafor', role: 'chat-admin' },
        { personId: 'cy', name: 'Cy Park', role: 'member' },
        { personId: 'dee', name: 'Dee Mensah', role: 'member' },
      ],
    })
  })

  it("never lists another church's people", async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [] })
    await seedChurch({ people: [cy], channels: [] })

    const response = await asMember(churchId, 'ana', '/people')

    expect(((await response.json()) as PeopleList).people.map((p) => p.personId)).toEqual(['ana'])
  })

  it.each([
    ['a member', 'cy'],
    ['a chat admin', 'ben'],
  ])('refuses %s with 403', async (_label, caller) => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [] })

    expect((await asMember(churchId, caller, '/people')).status).toBe(403)
  })

  it('answers 404 for a person the church does not know', async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [] })

    expect((await asMember(churchId, 'stranger', '/people')).status).toBe(404)
  })
})

describe('a private channel', () => {
  const staff = {
    channelId: 'staff',
    name: 'Staff',
    kind: 'private' as const,
    members: ['ben', 'cy', 'dee'],
  }

  it('is listed and opened by its members only', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee, { personId: 'eli', name: 'Eli Brandt' }],
      channels: [staff],
    })

    for (const personId of ['ben', 'cy', 'dee']) {
      expect((await listChannels(churchId, personId)).channels, personId).toEqual([
        {
          id: 'staff',
          name: 'Staff',
          kind: 'private',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'every-message',
        },
      ])
      expect((await asMember(churchId, personId, '/channels/staff/messages')).status).toBe(200)
      const socket = await openSocket(churchId, personId, 'staff')
      socket.close()
    }
  })

  it.each<[string, string, Role]>([
    ['a member', 'eli', 'member'],
    ['a chat admin', 'fay', 'chat-admin'],
  ])(
    'is hidden from %s who is not in it, with 404 on its history and socket',
    async (_label, personId, role) => {
      const { churchId } = await seedChurch({
        people: [
          ana,
          ben,
          cy,
          dee,
          { personId: 'eli', name: 'Eli Brandt' },
          { personId: 'fay', name: 'Fay Okafor', role: 'chat-admin' },
        ],
        channels: [staff],
      })

      expect((await readMe(churchId, personId)).role).toBe(role)
      expect((await listChannels(churchId, personId)).channels).toEqual([])
      expect((await asMember(churchId, personId, '/channels/staff/messages')).status).toBe(404)
      const socket = await asMember(churchId, personId, '/channels/staff/socket', {
        headers: { upgrade: 'websocket' },
      })
      expect(socket.status).toBe(404)
      expect(socket.webSocket).toBeNull()
    },
  )
})
