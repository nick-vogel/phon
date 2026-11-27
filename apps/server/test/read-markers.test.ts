import { exports } from 'cloudflare:workers'
import type { ChannelList, ChannelSummary } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
  asMember,
  deleteMessage,
  listChannels,
  markRead,
  postMessage,
  readHistory,
  readOversightLog,
  removeMessage,
  seedChurch,
} from './support/church.ts'
import { runScheduled } from './support/deployed.ts'
import { asSession, connectSyncAccount, pcoChurchId, signInAs } from './support/flows.ts'
import { fakePlanningCenter, newOrganizationId } from './support/planning-center.ts'
import { fakeServices } from './support/services.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const fay = {
  personId: 'fay',
  name: 'Fay Okafor',
  role: 'chat-admin' as const,
}

const general = {
  channelId: 'general',
  name: 'general',
  kind: 'open' as const,
}
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ben', 'cy', 'dee'],
}

/** A church with an open channel everyone serves in, and a private one Ana reads by oversight. */
function church() {
  return seedChurch({
    people: [ana, ben, cy, dee, fay],
    channels: [general, staff],
  })
}

/** One channel's summary in a person's channel list. Fails when the list does not carry it. */
async function summaryOf(
  churchId: string,
  personId: string,
  channelId: string,
): Promise<ChannelSummary> {
  const summary = (await listChannels(churchId, personId)).channels.find(
    (channel) => channel.id === channelId,
  )
  if (summary === undefined) throw new Error(`${personId} does not list ${channelId}`)
  return summary
}

/** The unread state and mentions of one channel in a person's list. */
async function unreadOf(churchId: string, personId: string, channelId: string) {
  const { unread, mentions } = await summaryOf(churchId, personId, channelId)
  return { unread, mentions }
}

describe('the unread state in the channel list', () => {
  it('is read with no mentions before any message', async () => {
    const { churchId } = await church()

    expect(await listChannels(churchId, 'ben')).toEqual({
      channels: [
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
      ],
    })
  })

  it('is unread once someone else posts, and read once the marker reaches that message', async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'general', 'Coffee after service?')

    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: true,
      mentions: 0,
    })

    expect((await markRead(churchId, 'ben', 'general', message.id)).status).toBe(204)
    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: false,
      mentions: 0,
    })
  })

  it('is unread again when a message arrives after the marker', async () => {
    const { churchId } = await church()
    const first = await postMessage(churchId, 'cy', 'general', 'Coffee after service?')
    await markRead(churchId, 'ben', 'general', first.id)

    await postMessage(churchId, 'dee', 'general', 'Count me in')

    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: true,
      mentions: 0,
    })
  })

  it("never counts a person's own message as unread for them", async () => {
    const { churchId } = await church()
    await postMessage(churchId, 'ben', 'general', 'Running late')

    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: false,
      mentions: 0,
    })
    expect(await unreadOf(churchId, 'cy', 'general')).toEqual({
      unread: true,
      mentions: 0,
    })
  })

  it("is each person's own: one person's marker leaves another's channel unread", async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'general', 'Coffee after service?')

    await markRead(churchId, 'ben', 'general', message.id)

    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: false,
      mentions: 0,
    })
    expect(await unreadOf(churchId, 'dee', 'general')).toEqual({
      unread: true,
      mentions: 0,
    })
  })
})

describe('the mention count in the channel list', () => {
  it('counts the unread messages that @mention the member, and drops to 0 once the marker passes them', async () => {
    const { churchId } = await church()
    await postMessage(churchId, 'cy', 'staff', '@Ben Okafor can you lead?', ['ben'])
    await postMessage(churchId, 'dee', 'staff', 'Agenda is in the drive')
    const last = await postMessage(churchId, 'cy', 'staff', '@Ben Okafor and the budget?', ['ben'])

    expect(await unreadOf(churchId, 'ben', 'staff')).toEqual({
      unread: true,
      mentions: 2,
    })

    await markRead(churchId, 'ben', 'staff', last.id)
    expect(await unreadOf(churchId, 'ben', 'staff')).toEqual({
      unread: false,
      mentions: 0,
    })
  })

  it('counts only the mentions after the marker', async () => {
    const { churchId } = await church()
    const first = await postMessage(churchId, 'cy', 'staff', '@Ben Okafor can you lead?', ['ben'])
    await markRead(churchId, 'ben', 'staff', first.id)

    await postMessage(churchId, 'dee', 'staff', '@Ben Okafor one more thing', ['ben'])

    expect(await unreadOf(churchId, 'ben', 'staff')).toEqual({
      unread: true,
      mentions: 1,
    })
  })

  it('never counts a mention of someone else', async () => {
    const { churchId } = await church()
    await postMessage(churchId, 'cy', 'staff', '@Dee Mensah can you lead?', ['dee'])

    expect(await unreadOf(churchId, 'ben', 'staff')).toEqual({
      unread: true,
      mentions: 0,
    })
    expect(await unreadOf(churchId, 'dee', 'staff')).toEqual({
      unread: true,
      mentions: 1,
    })
  })
})

describe('a marker', () => {
  it('never moves back: marking an older message answers 204 and keeps the channel read', async () => {
    const { churchId } = await church()
    const older = await postMessage(churchId, 'cy', 'general', 'Coffee after service?')
    const newer = await postMessage(churchId, 'dee', 'general', 'Count me in')
    expect((await markRead(churchId, 'ben', 'general', newer.id)).status).toBe(204)

    expect((await markRead(churchId, 'ben', 'general', older.id)).status).toBe(204)

    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: false,
      mentions: 0,
    })
  })

  it('may be set on a message deleted since, and keeps its place', async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'general', 'Coffee after service?')
    expect((await deleteMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)

    expect((await markRead(churchId, 'ben', 'general', message.id)).status).toBe(204)

    await postMessage(churchId, 'dee', 'general', 'Count me in')
    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: true,
      mentions: 0,
    })
  })
})

describe('a deleted message', () => {
  it('counts toward neither unread nor mentions once its author deletes it', async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'staff', '@Ben Okafor can you lead?', ['ben'])

    expect((await deleteMessage(churchId, 'cy', 'staff', message.id)).status).toBe(204)

    expect(await unreadOf(churchId, 'ben', 'staff')).toEqual({
      unread: false,
      mentions: 0,
    })
  })

  it('counts toward neither unread nor mentions once a moderator removes it', async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'general', '@Ben Okafor buy my car', ['ben'])

    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: false,
      mentions: 0,
    })
  })
})

describe('a channel read through oversight', () => {
  it('carries neither unread nor mentions in the list', async () => {
    const { churchId } = await church()
    await postMessage(churchId, 'cy', 'staff', '@Ben Okafor can you lead?', ['ben'])

    expect(await summaryOf(churchId, 'ana', 'staff')).toEqual({
      id: 'staff',
      name: 'Staff',
      kind: 'private',
      canPost: false,
      oversight: true,
    })
  })

  it('answers 204 to a marker and stores none, and leaves no oversight row', async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'staff', 'Budget draft is in the drive')
    const logBefore = await readOversightLog(churchId, 'ana')

    expect((await markRead(churchId, 'ana', 'staff', message.id)).status).toBe(204)

    expect(await readOversightLog(churchId, 'ana')).toEqual(logBefore)
    const members = await asMember(churchId, 'ana', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'ben', 'cy', 'dee'] }),
    })
    expect(members.status).toBe(204)
    expect(await unreadOf(churchId, 'ana', 'staff')).toEqual({
      unread: true,
      mentions: 0,
    })
  })
})

describe('a refused marker', () => {
  it.each([
    ['a message of another channel of the church', 'other-channel'],
    ['an unknown message', 'unknown'],
  ])('answers 404 for %s, and moves nothing', async (_label, which) => {
    const { churchId } = await church()
    await postMessage(churchId, 'cy', 'general', 'Coffee after service?')
    const inStaff = await postMessage(churchId, 'cy', 'staff', 'Budget draft is in the drive')
    const messageId = which === 'other-channel' ? inStaff.id : crypto.randomUUID()

    expect((await markRead(churchId, 'ben', 'general', messageId)).status).toBe(404)

    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: true,
      mentions: 0,
    })
    expect(await unreadOf(churchId, 'ben', 'staff')).toEqual({
      unread: true,
      mentions: 0,
    })
  })

  it.each([
    ['no body', undefined],
    ['a body that is not JSON', 'not json'],
    ['an array', '[]'],
    ['no messageId', '{}'],
    ['a messageId that is not a string', '{"messageId":7}'],
  ])('answers 400 for %s', async (_label, body) => {
    const { churchId } = await church()
    await postMessage(churchId, 'cy', 'general', 'Coffee after service?')

    const response = await asMember(churchId, 'ben', '/channels/general/read', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })

    expect(response.status).toBe(400)
    expect(await unreadOf(churchId, 'ben', 'general')).toEqual({
      unread: true,
      mentions: 0,
    })
  })

  it('answers 404 for a channel the person may not open', async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'staff', 'Budget draft is in the drive')

    expect((await markRead(churchId, 'fay', 'staff', message.id)).status).toBe(404)
    expect((await markRead(churchId, 'ben', 'no-such-channel', message.id)).status).toBe(404)
  })

  it("answers 404 for a person the church's directory does not know", async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'general', 'Coffee after service?')

    expect((await markRead(churchId, 'stranger', 'general', message.id)).status).toBe(404)
  })

  it.each([['GET'], ['POST'], ['DELETE']])('answers 405 for %s', async (method) => {
    const { churchId } = await church()

    const response = await asMember(churchId, 'ben', '/channels/general/read', { method })

    expect(response.status).toBe(405)
  })

  it('answers 401 with no identity', async () => {
    const response = await exports.default.fetch('https://phon.test/channels/general/read', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'any' }),
    })

    expect(response.status).toBe(401)
  })
})

describe('a marker across sessions', () => {
  it("is the person's, not the session's: a read through one session shows read through another", async () => {
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
    const connect = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })
    expect(connect.session.status).toBe(204)
    await runScheduled()
    const churchId = pcoChurchId(organizationId)
    const phone = await signInAs(planningCenter, organizationId, 'ada')
    const tablet = await signInAs(planningCenter, organizationId, 'ada')
    const message = await postMessage(churchId, 'ben', 'team-21', 'Set list is up')
    const worshipOn = async (token: string) => {
      const list = (await (await asSession(token, '/channels')).json()) as ChannelList
      const { unread, mentions } = list.channels.find((c) => c.id === 'team-21') ?? {}
      return { unread, mentions }
    }
    expect(await worshipOn(tablet)).toEqual({ unread: true, mentions: 0 })

    const marked = await asSession(phone, '/channels/team-21/read', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: message.id }),
    })

    expect(marked.status).toBe(204)
    expect(await worshipOn(tablet)).toEqual({ unread: false, mentions: 0 })
    expect((await readHistory(churchId, 'ada', 'team-21')).messages).toHaveLength(1)
  })
})
