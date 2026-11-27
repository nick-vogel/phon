import { exports } from 'cloudflare:workers'
import type { Message } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
  asMember,
  deleteMessage,
  type MemberSocket,
  openSocket,
  readHistory,
  seedChurch,
} from './support/church.ts'

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

describe('a member deleting their own message', () => {
  it('hides it from members and chat admins, and leaves it to admins, marked as deleted', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const kept = await post(benSocket, 'See you Sunday')
    const message = await post(benSocket, 'Wrong channel, sorry')
    benSocket.close()

    const before = new Date().toISOString()
    const response = await deleteMessage(churchId, 'ben', 'general', message.id)
    const after = new Date().toISOString()

    expect(response.status).toBe(204)
    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([kept])
    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([kept])
    expect((await readHistory(churchId, 'fay', 'general')).messages).toEqual([kept])
    const forAdmin = (await readHistory(churchId, 'ana', 'general')).messages
    expect(forAdmin).toHaveLength(2)
    expect(forAdmin[0]).toEqual(kept)
    const marked = forAdmin[1] as Message
    expect(marked).toMatchObject({ ...message, deleted: { by: 'ben' } })
    expect(marked.deleted !== undefined && marked.deleted.at >= before).toBe(true)
    expect(marked.deleted !== undefined && marked.deleted.at <= after).toBe(true)
  })

  it('takes it out of view live for members and chat admins, and marks it for admins', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const cySocket = await openSocket(churchId, 'cy', 'general')
    const faySocket = await openSocket(churchId, 'fay', 'general')
    const anaSocket = await openSocket(churchId, 'ana', 'general')
    const message = await post(benSocket, 'Typo city')
    await cySocket.nextFrame()
    await faySocket.nextFrame()
    await anaSocket.nextFrame()

    expect((await deleteMessage(churchId, 'ben', 'general', message.id)).status).toBe(204)

    expect(await cySocket.nextFrame()).toEqual({ type: 'removed', messageId: message.id })
    expect(await benSocket.nextFrame()).toEqual({ type: 'removed', messageId: message.id })
    expect(await faySocket.nextFrame()).toEqual({ type: 'removed', messageId: message.id })
    const forAdmin = await anaSocket.nextFrame()
    expect(forAdmin).toMatchObject({
      type: 'updated',
      message: { ...message, deleted: { by: 'ben' } },
    })
    for (const socket of [benSocket, cySocket, faySocket, anaSocket]) socket.close()
  })

  it('keeps it from an admin reading a private channel by oversight, marked', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const benSocket = await openSocket(churchId, 'ben', 'staff')
    const message = await post(benSocket, 'Never mind')
    benSocket.close()

    expect((await deleteMessage(churchId, 'ben', 'staff', message.id)).status).toBe(204)

    expect((await readHistory(churchId, 'cy', 'staff')).messages).toEqual([])
    expect((await readHistory(churchId, 'ana', 'staff')).messages).toMatchObject([
      { id: message.id, body: 'Never mind', deleted: { by: 'ben' } },
    ])
  })
})

describe('a delete the channel refuses', () => {
  it("refuses a member deleting someone else's message with 403, and keeps it", async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Mine')
    benSocket.close()

    expect((await deleteMessage(churchId, 'cy', 'general', message.id)).status).toBe(403)

    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([message])
    expect((await readHistory(churchId, 'ana', 'general')).messages).toEqual([message])
  })

  it("refuses a chat admin deleting someone else's message with 403", async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, fay], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Mine')
    benSocket.close()

    expect((await deleteMessage(churchId, 'fay', 'general', message.id)).status).toBe(403)

    expect((await readHistory(churchId, 'fay', 'general')).messages).toEqual([message])
  })

  it('answers 404 for an unknown message, and for one already deleted', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Once')
    benSocket.close()

    expect((await deleteMessage(churchId, 'ben', 'general', 'no-such-message')).status).toBe(404)
    expect((await deleteMessage(churchId, 'ben', 'general', message.id)).status).toBe(204)
    expect((await deleteMessage(churchId, 'ben', 'general', message.id)).status).toBe(404)
  })

  it('answers 404 to a person outside a private channel, and keeps the message', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee, fay],
      channels: [staff],
    })
    const benSocket = await openSocket(churchId, 'ben', 'staff')
    const message = await post(benSocket, 'Staff only')
    benSocket.close()

    expect((await deleteMessage(churchId, 'fay', 'staff', message.id)).status).toBe(404)

    expect((await readHistory(churchId, 'cy', 'staff')).messages).toEqual([message])
  })

  it("never touches another church's channel and message of the same IDs", async () => {
    const a = await seedChurch({ people: [ana, ben], channels: [general] })
    const b = await seedChurch({ people: [ana, ben], channels: [general] })
    const aSocket = await openSocket(a.churchId, 'ben', 'general')
    const message = await post(aSocket, 'Church A')
    aSocket.close()

    expect((await deleteMessage(b.churchId, 'ben', 'general', message.id)).status).toBe(404)

    expect((await readHistory(a.churchId, 'ben', 'general')).messages).toEqual([message])
  })

  it('answers 401 without an identity, and keeps the message', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Still here')
    benSocket.close()

    const response = await exports.default.fetch(
      `https://phon.test/channels/general/messages/${message.id}`,
      { method: 'DELETE' },
    )

    expect(response.status).toBe(401)
    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([message])
  })

  it('answers 405 for a method other than DELETE', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Edit me')
    benSocket.close()

    const response = await asMember(churchId, 'ben', `/channels/general/messages/${message.id}`, {
      method: 'PUT',
      body: '{}',
    })

    expect(response.status).toBe(405)
  })
})
