import { env, exports } from 'cloudflare:workers'
import type { Message } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
  asMember,
  deleteMessage,
  type MemberSocket,
  openSocket,
  pinMessage,
  readHistory,
  readOversightLog,
  removeMessage,
  seedChurch,
  setRole,
  unpinMessage,
} from './support/church.ts'
import { ADULT_BIRTHDATE } from './support/people.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const fay = { personId: 'fay', name: 'Fay Okafor', role: 'chat-admin' as const }

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ben', 'cy', 'dee'],
}

/** Sends a message on a socket and returns the stored copy the server echoes back. */
async function post(socket: MemberSocket, body: string): Promise<Message> {
  socket.send({ type: 'send', body })
  const frame = await socket.nextFrame()
  if (frame.type !== 'message') throw new Error(`Expected a message frame, got ${frame.type}`)
  return frame.message
}

/** Posts one message as a person on a fresh socket. */
async function postAs(churchId: string, personId: string, channelId: string, body: string) {
  const socket = await openSocket(churchId, personId, channelId)
  try {
    return await post(socket, body)
  } finally {
    socket.close()
  }
}

describe('removing a message', () => {
  it.each([
    ['a chat admin', 'fay'],
    ['an admin', 'ana'],
  ])("lets %s remove someone else's message", async (_label, moderatorId) => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const kept = await postAs(churchId, 'ben', 'general', 'See you Sunday')
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')

    const response = await removeMessage(churchId, moderatorId, 'general', message.id)

    expect(response.status).toBe(204)
    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([kept])
    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([kept])
    expect((await readHistory(churchId, 'fay', 'general')).messages).toEqual([kept])
  })

  it("refuses a member removing someone else's message, or their own, with 403", async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Mine')

    expect((await removeMessage(churchId, 'cy', 'general', message.id)).status).toBe(403)
    expect((await removeMessage(churchId, 'ben', 'general', message.id)).status).toBe(403)

    expect((await readHistory(churchId, 'dee', 'general')).messages).toEqual([message])
    expect((await readHistory(churchId, 'ana', 'general')).messages).toEqual([message])
  })
})

describe('a moderator whose role changes', () => {
  it('may no longer remove or pin once made a member, from the next request', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Still here')
    expect((await pinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    expect((await setRole(churchId, 'ana', 'fay', 'member')).status).toBe(204)

    expect((await unpinMessage(churchId, 'fay', 'general', message.id)).status).toBe(403)
    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(403)
    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([
      { ...message, pinned: { at: expect.any(String), by: 'fay' } },
    ])
  })
})

describe('a removed message', () => {
  it("stays in admins' history, marked as removed by the chat admin who removed it", async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const kept = await postAs(churchId, 'ben', 'general', 'See you Sunday')
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')

    const before = new Date().toISOString()
    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)
    const after = new Date().toISOString()

    const forAdmin = (await readHistory(churchId, 'ana', 'general')).messages
    expect(forAdmin).toHaveLength(2)
    expect(forAdmin[0]).toEqual(kept)
    const marked = forAdmin[1] as Message
    expect(marked).toEqual({ ...message, deleted: { at: expect.any(String), by: 'fay' } })
    expect(marked.deleted !== undefined && marked.deleted.at >= before).toBe(true)
    expect(marked.deleted !== undefined && marked.deleted.at <= after).toBe(true)
  })

  it('leaves members and chat admins live, and reaches admins marked', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const cySocket = await openSocket(churchId, 'cy', 'general')
    const faySocket = await openSocket(churchId, 'fay', 'general')
    const anaSocket = await openSocket(churchId, 'ana', 'general')
    const message = await post(benSocket, 'Something unkind')
    await cySocket.nextFrame()
    await faySocket.nextFrame()
    await anaSocket.nextFrame()

    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    expect(await benSocket.nextFrame()).toEqual({ type: 'removed', messageId: message.id })
    expect(await cySocket.nextFrame()).toEqual({ type: 'removed', messageId: message.id })
    expect(await faySocket.nextFrame()).toEqual({ type: 'removed', messageId: message.id })
    expect(await anaSocket.nextFrame()).toEqual({
      type: 'updated',
      message: { ...message, deleted: { at: expect.any(String), by: 'fay' } },
    })
    for (const socket of [benSocket, cySocket, faySocket, anaSocket]) socket.close()
  })
})

describe('a removal the server refuses', () => {
  it('lets an admin remove in a private channel they read by oversight', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const message = await postAs(churchId, 'ben', 'staff', 'Staff only')

    expect((await removeMessage(churchId, 'ana', 'staff', message.id)).status).toBe(204)

    expect((await readHistory(churchId, 'cy', 'staff')).messages).toEqual([])
  })

  it.each([
    ['removes', (churchId: string, id: string) => removeMessage(churchId, 'ana', 'staff', id)],
    ['pins', (churchId: string, id: string) => pinMessage(churchId, 'ana', 'staff', id)],
    ['unpins', (churchId: string, id: string) => unpinMessage(churchId, 'ana', 'staff', id)],
  ])('records an admin who %s in a private channel they read by oversight', async (_l, act) => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const message = await postAs(churchId, 'ben', 'staff', 'Staff only')
    expect((await readOversightLog(churchId, 'ana')).views).toEqual([])

    expect((await act(churchId, message.id)).status).toBe(204)

    expect(
      (await readOversightLog(churchId, 'ana')).views.map((v) => [v.adminId, v.channelId]),
    ).toEqual([['ana', 'staff']])
  })

  it('records an admin who removes in a private channel they are one of the last two members of', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [{ ...staff, members: ['ana', 'ben', 'cy'] }],
    })
    const message = await postAs(churchId, 'ben', 'staff', 'Staff only')
    // Cy leaves the church, so Ana and Ben are the channel's last two members.
    await env.CHURCH_DIRECTORY.getByName(churchId).applyRoster(churchId, {
      people: [ana, ben, dee].map(({ personId, name }) => ({
        personId,
        name,
        serves: true,
        birthdate: ADULT_BIRTHDATE,
        avatar: null,
      })),
      dropped: ['cy'],
      groupTypes: null,
      channels: [],
      memberships: [],
      leaders: [],
    })
    expect((await asMember(churchId, 'ben', '/channels/staff/messages')).status).toBe(404)
    expect((await readOversightLog(churchId, 'ana')).views).toEqual([])

    expect((await removeMessage(churchId, 'ana', 'staff', message.id)).status).toBe(204)

    expect(
      (await readOversightLog(churchId, 'ana')).views.map((v) => [v.adminId, v.channelId]),
    ).toEqual([['ana', 'staff']])
  })

  it('records nothing when a moderator removes or pins in a channel they are a member of', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee, fay],
      channels: [{ ...staff, members: [...staff.members, 'ana', 'fay'] }],
    })
    const first = await postAs(churchId, 'ben', 'staff', 'Staff only')
    const second = await postAs(churchId, 'ben', 'staff', 'Staff only, again')

    expect((await removeMessage(churchId, 'ana', 'staff', first.id)).status).toBe(204)
    expect((await pinMessage(churchId, 'fay', 'staff', second.id)).status).toBe(204)

    expect((await readOversightLog(churchId, 'ana')).views).toEqual([])
  })

  it('answers 404 to a chat admin outside a private channel, and keeps the message', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee, fay], channels: [staff] })
    const message = await postAs(churchId, 'ben', 'staff', 'Staff only')

    expect((await removeMessage(churchId, 'fay', 'staff', message.id)).status).toBe(404)

    expect((await readHistory(churchId, 'cy', 'staff')).messages).toEqual([message])
  })

  it('answers 404 for an unknown message, and for one already removed', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Once')

    expect((await removeMessage(churchId, 'fay', 'general', 'no-such-message')).status).toBe(404)
    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)
    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(404)
  })

  it("never touches another church's channel and message of the same IDs", async () => {
    const a = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const b = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const message = await postAs(a.churchId, 'ben', 'general', 'Church A')

    expect((await removeMessage(b.churchId, 'fay', 'general', message.id)).status).toBe(404)

    expect((await readHistory(a.churchId, 'ben', 'general')).messages).toEqual([message])
  })

  it('answers 401 without an identity, and 405 for a method other than POST', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Still here')
    const path = `/channels/general/messages/${message.id}/remove`

    expect(
      (await exports.default.fetch(`https://phon.test${path}`, { method: 'POST' })).status,
    ).toBe(401)
    expect((await asMember(churchId, 'fay', path, { method: 'DELETE' })).status).toBe(405)

    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([message])
  })
})

describe('pinning a message', () => {
  it.each([
    ['a chat admin', 'fay'],
    ['an admin', 'ana'],
  ])('lets %s pin and unpin a message, and everyone sees it', async (_label, moderatorId) => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Rehearsal moves to 6pm')

    const before = new Date().toISOString()
    expect((await pinMessage(churchId, moderatorId, 'general', message.id)).status).toBe(204)
    const after = new Date().toISOString()

    const pinned = (await readHistory(churchId, 'cy', 'general')).messages
    expect(pinned).toEqual([{ ...message, pinned: { at: expect.any(String), by: moderatorId } }])
    const at = (pinned[0] as Message).pinned?.at ?? ''
    expect(at >= before && at <= after).toBe(true)
    expect((await readHistory(churchId, 'ana', 'general')).messages).toEqual(pinned)

    expect((await unpinMessage(churchId, moderatorId, 'general', message.id)).status).toBe(204)

    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([message])
  })

  it('refuses a member pinning or unpinning with 403, and leaves the pin as it was', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Mine')

    expect((await pinMessage(churchId, 'ben', 'general', message.id)).status).toBe(403)
    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([message])

    expect((await pinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)
    expect((await unpinMessage(churchId, 'cy', 'general', message.id)).status).toBe(403)
    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([
      { ...message, pinned: { at: expect.any(String), by: 'fay' } },
    ])
  })

  it('sends the pinned and unpinned message to every socket as an update', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const cySocket = await openSocket(churchId, 'cy', 'general')
    const anaSocket = await openSocket(churchId, 'ana', 'general')
    const message = await post(benSocket, 'Rehearsal moves to 6pm')
    await cySocket.nextFrame()
    await anaSocket.nextFrame()

    expect((await pinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    const pinned = {
      type: 'updated',
      message: { ...message, pinned: { at: expect.any(String), by: 'fay' } },
    }
    expect(await benSocket.nextFrame()).toEqual(pinned)
    expect(await cySocket.nextFrame()).toEqual(pinned)
    expect(await anaSocket.nextFrame()).toEqual(pinned)

    expect((await unpinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    for (const socket of [benSocket, cySocket, anaSocket]) {
      expect(await socket.nextFrame()).toEqual({ type: 'updated', message })
      socket.close()
    }
  })

  it('keeps the first pin when a message is pinned again, and unpins an unpinned one quietly', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Rehearsal moves to 6pm')

    expect((await unpinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)
    expect((await pinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)
    const first = (await readHistory(churchId, 'ben', 'general')).messages
    expect((await pinMessage(churchId, 'ana', 'general', message.id)).status).toBe(204)

    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual(first)
    expect(first[0]?.pinned?.by).toBe('fay')
  })

  it('clears the pin of a message that is removed', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Pinned, then removed')
    expect((await pinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    expect((await readHistory(churchId, 'ana', 'general')).messages).toEqual([
      { ...message, deleted: { at: expect.any(String), by: 'fay' } },
    ])
  })

  it('clears the pin of a message its author deletes', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Pinned, then deleted')
    expect((await pinMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    expect((await deleteMessage(churchId, 'ben', 'general', message.id)).status).toBe(204)

    expect((await readHistory(churchId, 'ana', 'general')).messages).toEqual([
      { ...message, deleted: { at: expect.any(String), by: 'ben' } },
    ])
  })

  it('answers 404 for an unknown or removed message, and outside a private channel', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee, fay],
      channels: [general, staff],
    })
    const removed = await postAs(churchId, 'ben', 'general', 'Gone')
    expect((await removeMessage(churchId, 'fay', 'general', removed.id)).status).toBe(204)
    const inStaff = await postAs(churchId, 'ben', 'staff', 'Staff only')

    expect((await pinMessage(churchId, 'fay', 'general', 'no-such-message')).status).toBe(404)
    expect((await pinMessage(churchId, 'fay', 'general', removed.id)).status).toBe(404)
    expect((await unpinMessage(churchId, 'fay', 'general', removed.id)).status).toBe(404)
    expect((await pinMessage(churchId, 'fay', 'staff', inStaff.id)).status).toBe(404)

    expect((await readHistory(churchId, 'cy', 'staff')).messages).toEqual([inStaff])
  })

  it('answers 405 for a method other than PUT or DELETE', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Pin me')

    const response = await asMember(
      churchId,
      'fay',
      `/channels/general/messages/${message.id}/pin`,
      {
        method: 'POST',
      },
    )

    expect(response.status).toBe(405)
  })
})
