import { env, exports } from 'cloudflare:workers'
import type { OversightView, Role } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { syncChurch } from '../src/roster-sync.ts'
import {
  asMember,
  listChannels,
  openSocket,
  readHistory,
  readOversightLog,
  seedChurch,
  setRole,
} from './support/church.ts'
import { ADULT_BIRTHDATE } from './support/people.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const fay = { personId: 'fay', name: 'Fay Okafor', role: 'chat-admin' as const }
const eli = { personId: 'eli', name: 'Eli Brandt' }
const gus = { personId: 'gus', name: 'Gus Lindqvist', role: 'admin' as const }

const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ben', 'cy', 'dee'],
}

describe('an admin reading a private channel they are not in', () => {
  it('lists it as oversight that they may not post in, and reads its history', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const benSocket = await openSocket(churchId, 'ben', 'staff')
    benSocket.send({ type: 'send', body: 'Budget draft is in the drive' })
    await benSocket.nextFrame()
    benSocket.close()

    expect((await listChannels(churchId, 'ana')).channels).toEqual([
      { id: 'staff', name: 'Staff', kind: 'private', canPost: false, oversight: true },
    ])
    const history = await readHistory(churchId, 'ana', 'staff')
    expect(history.messages.map((message) => [message.authorId, message.body])).toEqual([
      ['ben', 'Budget draft is in the drive'],
    ])
  })

  it("opens its socket and receives a member's live message, but cannot post", async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const anaSocket = await openSocket(churchId, 'ana', 'staff')
    const benSocket = await openSocket(churchId, 'ben', 'staff')

    benSocket.send({ type: 'send', body: 'Elder meeting moved to Thursday' })
    expect(await anaSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { authorId: 'ben', body: 'Elder meeting moved to Thursday' },
    })
    await benSocket.nextFrame()

    anaSocket.send({ type: 'send', body: 'Noted' })
    expect(await anaSocket.nextFrame()).toEqual({
      type: 'error',
      reason: 'You read this channel as an admin. Only its members post here.',
    })
    anaSocket.close()
    benSocket.close()
    expect((await readHistory(churchId, 'ben', 'staff')).messages.map((m) => m.body)).toEqual([
      'Elder meeting moved to Thursday',
    ])
  })
})

describe("the author names on a private channel's history", () => {
  it('names each current author to an admin once the channel falls below three, and no one who left the church', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const benSocket = await openSocket(churchId, 'ben', 'staff')
    benSocket.send({ type: 'send', body: 'Budget draft is in the drive' })
    await benSocket.nextFrame()
    benSocket.close()
    const deeSocket = await openSocket(churchId, 'dee', 'staff')
    deeSocket.send({ type: 'send', body: 'Thanks, reading it now' })
    await deeSocket.nextFrame()
    deeSocket.close()
    // Dee leaves the church, so Ben and Cy are the channel's last two members, still current.
    await env.CHURCH_DIRECTORY.getByName(churchId).applyRoster(churchId, {
      people: [ana, ben, cy].map(({ personId, name }) => ({
        personId,
        name,
        serves: true,
        birthdate: ADULT_BIRTHDATE,
        avatar: null,
      })),
      dropped: ['dee'],
      groupTypes: null,
      channels: [],
      memberships: [],
      leaders: [],
    })

    const history = await readHistory(churchId, 'ana', 'staff')

    expect(history.messages.map((message) => message.authorId)).toEqual(['ben', 'dee'])
    expect(history.authors).toEqual([{ personId: 'ben', name: 'Ben Okafor', avatar: null }])
  })
})

describe('a chat admin or a member who is not in a private channel', () => {
  it.each<[string, string, Role]>([
    ['a chat admin', 'fay', 'chat-admin'],
    ['a member', 'eli', 'member'],
  ])('finds nothing for %s: 404 on history and socket, and no listing', async (_l, who, role) => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee, eli, fay],
      channels: [staff],
    })

    expect(
      (await asMember(churchId, who, '/me').then((r) => r.json())) as { role: Role },
    ).toMatchObject({ role })
    expect((await listChannels(churchId, who)).channels).toEqual([])
    expect((await asMember(churchId, who, '/channels/staff/messages')).status).toBe(404)
    const socket = await asMember(churchId, who, '/channels/staff/socket', {
      headers: { upgrade: 'websocket' },
    })
    expect(socket.status).toBe(404)
    expect(socket.webSocket).toBeNull()
  })
})

describe('the oversight record', () => {
  it("records an admin's history read with the admin, the channel and the time", async () => {
    const { churchId } = await seedChurch({ people: [ana, gus, ben, cy, dee], channels: [staff] })

    const before = new Date().toISOString()
    expect((await asMember(churchId, 'ana', '/channels/staff/messages')).status).toBe(200)
    const after = new Date().toISOString()

    const log = await readOversightLog(churchId, 'gus')
    expect(log.views).toHaveLength(1)
    const view = log.views[0] as OversightView
    expect(view).toMatchObject({
      adminId: 'ana',
      adminName: 'Ana Ortiz',
      channelId: 'staff',
      channelName: 'Staff',
    })
    expect(view.openedAt >= before).toBe(true)
    expect(view.openedAt <= after).toBe(true)
  })

  it('records a socket open too, and lists the views newest first', async () => {
    const { churchId } = await seedChurch({
      people: [ana, gus, ben, cy, dee],
      channels: [
        staff,
        { channelId: 'elders', name: 'Elders', kind: 'private', members: ['ben', 'cy', 'dee'] },
      ],
    })

    await readHistory(churchId, 'gus', 'elders')
    const socket = await openSocket(churchId, 'ana', 'staff')
    socket.close()

    expect(
      (await readOversightLog(churchId, 'ana')).views.map((v) => [v.adminName, v.channelName]),
    ).toEqual([
      ['Ana Ortiz', 'Staff'],
      ['Gus Lindqvist', 'Elders'],
    ])
    const [first, second] = (await readOversightLog(churchId, 'gus')).views
    expect(first?.viewId).not.toBe(second?.viewId)
  })

  it.each([
    ['a chat admin', 'fay'],
    ['a member', 'ben'],
  ])('refuses %s with 403', async (_label, who) => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee, fay], channels: [staff] })

    expect((await asMember(churchId, who, '/oversight')).status).toBe(403)
  })

  it('answers 404 for a person the church does not know, and 405 for another method', async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [] })

    expect((await asMember(churchId, 'stranger', '/oversight')).status).toBe(404)
    expect((await asMember(churchId, 'ana', '/oversight', { method: 'POST' })).status).toBe(405)
  })

  it('answers 401 without an identity', async () => {
    const response = await exports.default.fetch('https://phon.test/oversight')

    expect(response.status).toBe(401)
  })

  it("never shows one church's views to another church's admin", async () => {
    const a = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const b = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })

    await readHistory(a.churchId, 'ana', 'staff')

    expect(await readOversightLog(b.churchId, 'ana')).toEqual({ views: [] })
    expect((await readOversightLog(a.churchId, 'ana')).views).toHaveLength(1)
  })

  it('records nothing when the admin is a member of the private channel', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [{ ...staff, members: ['ana', 'ben', 'cy'] }],
    })

    await readHistory(churchId, 'ana', 'staff')
    const socket = await openSocket(churchId, 'ana', 'staff')
    socket.close()

    expect(await readOversightLog(churchId, 'ana')).toEqual({ views: [] })
  })

  it('records a history read and a socket open by an admin who is one of its last two members', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [{ ...staff, members: ['ana', 'ben'] }],
    })

    expect((await asMember(churchId, 'ana', '/channels/staff/messages')).status).toBe(200)
    const socket = await openSocket(churchId, 'ana', 'staff')
    socket.close()

    expect(
      (await readOversightLog(churchId, 'ana')).views.map((v) => [v.adminId, v.channelId]),
    ).toEqual([
      ['ana', 'staff'],
      ['ana', 'staff'],
    ])
  })

  it.each([
    ['an open channel', { channelId: 'general', name: 'general', kind: 'open' as const }],
    [
      'announcements',
      { channelId: 'announcements', name: 'announcements', kind: 'announcements' as const },
    ],
    [
      'a team channel they are not on',
      { channelId: 'team-1', name: 'Band', kind: 'team' as const, members: ['ben'] },
    ],
  ])('records nothing when the admin reads %s', async (_label, channel) => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [channel] })

    expect(
      (await asMember(churchId, 'ana', `/channels/${channel.channelId}/messages`)).status,
    ).toBe(200)

    expect(await readOversightLog(churchId, 'ana')).toEqual({ views: [] })
  })

  it('records nothing for a member of the private channel', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })

    await readHistory(churchId, 'ben', 'staff')

    expect(await readOversightLog(churchId, 'ana')).toEqual({ views: [] })
  })
})

describe('an admin who loses oversight', () => {
  it('has their oversight socket closed when demoted, and finds the channel gone', async () => {
    const { churchId } = await seedChurch({ people: [ana, gus, ben, cy, dee], channels: [staff] })
    const socket = await openSocket(churchId, 'gus', 'staff')

    expect((await setRole(churchId, 'ana', 'gus', 'chat-admin')).status).toBe(204)

    expect((await socket.closed()).code).toBe(4403)
    expect((await asMember(churchId, 'gus', '/channels/staff/messages')).status).toBe(404)
    expect((await listChannels(churchId, 'gus')).channels).toEqual([])
  })

  it('has their oversight socket closed when they leave the church, and another admin keeps theirs', async () => {
    const { churchId } = await seedChurch({ people: [ana, gus, ben, cy, dee], channels: [staff] })
    const socket = await openSocket(churchId, 'ana', 'staff')
    const gusSocket = await openSocket(churchId, 'gus', 'staff')

    // Planning Center turns out to hold a birthdate under 13 for Ana, so the roster sync drops her
    // and marks her as left, whatever her role.
    const stayed = [gus, ben, cy, dee].map(({ personId, name }) => ({
      personId,
      name,
      serves: true,
      birthdate: ADULT_BIRTHDATE,
      avatar: null,
    }))
    await env.CHURCH_DIRECTORY.getByName(churchId).applyRoster(churchId, {
      people: stayed,
      dropped: ['ana'],
      groupTypes: null,
      channels: [],
      memberships: [],
      leaders: [],
    })
    await syncChurch(env, churchId)

    expect((await socket.closed()).code).toBe(4403)
    const bensSocket = await openSocket(churchId, 'ben', 'staff')
    bensSocket.send({ type: 'send', body: 'After Ana left' })
    await bensSocket.nextFrame()
    expect(await gusSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { body: 'After Ana left' },
    })
    for (const open of [gusSocket, bensSocket]) open.close()
  })

  it('has their member socket closed when the roster sync takes them off a team', async () => {
    const worship = { channelId: 'team-11', name: 'Worship', kind: 'team' as const }
    const { churchId } = await seedChurch({
      people: [ana, ben, cy],
      channels: [{ ...worship, members: ['ana', 'ben', 'cy'] }],
    })
    const socket = await openSocket(churchId, 'ana', 'team-11')

    await env.CHURCH_DIRECTORY.getByName(churchId).applyRoster(churchId, {
      people: [ana, ben, cy].map(({ personId, name }) => ({
        personId,
        name,
        serves: true,
        birthdate: ADULT_BIRTHDATE,
        avatar: null,
      })),
      dropped: [],
      groupTypes: null,
      channels: [{ ...worship, keepName: false }],
      memberships: ['ben', 'cy'].map((personId) => ({ channelId: 'team-11', personId })),
      leaders: [],
    })
    await syncChurch(env, churchId)

    // She may still read it by oversight, but that is a new look, not the socket she had.
    expect((await socket.closed()).code).toBe(4403)
  })

  it('keeps an open channel socket when demoted', async () => {
    const { churchId } = await seedChurch({
      people: [ana, gus, ben],
      channels: [{ channelId: 'general', name: 'general', kind: 'open' }],
    })
    const socket = await openSocket(churchId, 'gus', 'general')

    await setRole(churchId, 'ana', 'gus', 'member')
    socket.send({ type: 'send', body: 'Still here' })

    expect(await socket.nextFrame()).toMatchObject({ type: 'message' })
    socket.close()
  })

  it('has their socket closed when taken out of a private channel, and a reopen is recorded', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [{ ...staff, members: ['ana', 'ben', 'cy', 'dee'] }],
    })
    const socket = await openSocket(churchId, 'ana', 'staff')

    const set = await asMember(churchId, 'ana', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ben', 'cy', 'dee'] }),
    })
    expect(set.status).toBe(204)
    expect((await socket.closed()).code).toBe(4403)
    expect(await readOversightLog(churchId, 'ana')).toEqual({ views: [] })

    const reopened = await openSocket(churchId, 'ana', 'staff')
    reopened.close()

    expect((await readOversightLog(churchId, 'ana')).views.map((v) => v.channelId)).toEqual([
      'staff',
    ])
  })
})
