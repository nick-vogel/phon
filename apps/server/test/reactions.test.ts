import type { Message, ServerFrame } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
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

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const announcements = {
  channelId: 'announcements',
  name: 'announcements',
  kind: 'announcements' as const,
}
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

describe('reacting to a message', () => {
  it('shows the reaction live to every member with the channel open, the reactor included', async () => {
    const { churchId } = await seedChurch({ people: [ben, cy, dee], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const cySocket = await openSocket(churchId, 'cy', 'general')
    const deeSocket = await openSocket(churchId, 'dee', 'general')
    const message = await post(benSocket, 'Rehearsal at 6')
    await cySocket.nextFrame()
    await deeSocket.nextFrame()

    cySocket.send({ type: 'react', messageId: message.id, emoji: '👍' })

    const expected: ServerFrame = {
      type: 'reactions',
      messageId: message.id,
      reactions: [{ emoji: '👍', personIds: ['cy'] }],
    }
    expect(await benSocket.nextFrame()).toEqual(expected)
    expect(await cySocket.nextFrame()).toEqual(expected)
    expect(await deeSocket.nextFrame()).toEqual(expected)
  })

  it("adds a second person's same emoji to the same entry, in the order they reacted", async () => {
    const { churchId } = await seedChurch({ people: [ben, cy, dee], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const cySocket = await openSocket(churchId, 'cy', 'general')
    const message = await post(benSocket, 'Rehearsal at 6')
    await cySocket.nextFrame()

    cySocket.send({ type: 'react', messageId: message.id, emoji: '🙏' })
    await benSocket.nextFrame()
    benSocket.send({ type: 'react', messageId: message.id, emoji: '👍' })
    await benSocket.nextFrame()
    benSocket.send({ type: 'react', messageId: message.id, emoji: '🙏' })

    expect(await benSocket.nextFrame()).toEqual({
      type: 'reactions',
      messageId: message.id,
      reactions: [
        { emoji: '🙏', personIds: ['cy', 'ben'] },
        { emoji: '👍', personIds: ['ben'] },
      ],
    })
  })

  it('takes a reaction off with unreact, and sends the empty set once none is left', async () => {
    const { churchId } = await seedChurch({ people: [ben, cy], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const cySocket = await openSocket(churchId, 'cy', 'general')
    const message = await post(benSocket, 'Rehearsal at 6')
    await cySocket.nextFrame()
    cySocket.send({ type: 'react', messageId: message.id, emoji: '👍' })
    await benSocket.nextFrame()
    await cySocket.nextFrame()

    cySocket.send({ type: 'unreact', messageId: message.id, emoji: '👍' })

    const expected = { type: 'reactions', messageId: message.id, reactions: [] }
    expect(await benSocket.nextFrame()).toEqual(expected)
    expect(await cySocket.nextFrame()).toEqual(expected)
    expect((await readHistory(churchId, 'ben', 'general')).messages[0]?.reactions).toEqual([])
  })

  it('changes nothing when a person reacts twice with the same emoji, or unreacts one they lack', async () => {
    const { churchId } = await seedChurch({ people: [ben, cy], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Rehearsal at 6')

    benSocket.send({ type: 'react', messageId: message.id, emoji: '👍' })
    await benSocket.nextFrame()
    benSocket.send({ type: 'react', messageId: message.id, emoji: '👍' })
    benSocket.send({ type: 'unreact', messageId: message.id, emoji: '🎉' })

    const once = {
      type: 'reactions',
      messageId: message.id,
      reactions: [{ emoji: '👍', personIds: ['ben'] }],
    }
    expect(await benSocket.nextFrame()).toEqual(once)
    expect(await benSocket.nextFrame()).toEqual(once)
    expect((await readHistory(churchId, 'cy', 'general')).messages[0]?.reactions).toEqual(
      once.reactions,
    )
  })

  it('returns each message with its reactions in the history, and a new message with none', async () => {
    const { churchId } = await seedChurch({ people: [ben, cy], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const first = await post(benSocket, 'Rehearsal at 6')
    const second = await post(benSocket, 'Bring the capo')
    expect(first.reactions).toEqual([])
    expect(first.image).toBeNull()

    benSocket.send({ type: 'react', messageId: second.id, emoji: '🎸' })
    await benSocket.nextFrame()

    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([
      first,
      { ...second, reactions: [{ emoji: '🎸', personIds: ['ben'] }] },
    ])
  })
})

describe('a reaction the server refuses', () => {
  it.each([
    ['a word', 'ok'],
    ['two emoji', '👍👍'],
    ['an emoji and text', '👍 yes'],
    ['an empty string', ''],
  ])('refuses %s as the emoji, and stores nothing', async (_name, emoji) => {
    const { churchId } = await seedChurch({ people: [ben, cy], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Rehearsal at 6')

    benSocket.send({ type: 'react', messageId: message.id, emoji })

    expect(await benSocket.nextFrame()).toMatchObject({ type: 'error' })
    expect((await readHistory(churchId, 'cy', 'general')).messages[0]?.reactions).toEqual([])
  })

  it('takes a single emoji built of several code points, such as a flag or a family', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Rehearsal at 6')

    benSocket.send({ type: 'react', messageId: message.id, emoji: '🇬🇭' })
    benSocket.send({ type: 'react', messageId: message.id, emoji: '👨‍👩‍👧' })
    benSocket.send({ type: 'react', messageId: message.id, emoji: '👍🏽' })
    await benSocket.nextFrame()
    await benSocket.nextFrame()

    expect(await benSocket.nextFrame()).toMatchObject({
      type: 'reactions',
      reactions: [{ emoji: '🇬🇭' }, { emoji: '👨‍👩‍👧' }, { emoji: '👍🏽' }],
    })
  })

  it('refuses a message ID that is not a message of this channel, and stores nothing', async () => {
    const { churchId } = await seedChurch({
      people: [ben, cy],
      channels: [general, { channelId: 'worship', name: 'worship', kind: 'open' as const }],
    })
    const worshipSocket = await openSocket(churchId, 'ben', 'worship')
    const elsewhere = await post(worshipSocket, 'Setlist is up')
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Rehearsal at 6')

    benSocket.send({ type: 'react', messageId: elsewhere.id, emoji: '👍' })
    expect(await benSocket.nextFrame()).toMatchObject({ type: 'error' })
    benSocket.send({ type: 'react', messageId: 'no-such-message', emoji: '👍' })
    expect(await benSocket.nextFrame()).toMatchObject({ type: 'error' })
    benSocket.send({ type: 'unreact', messageId: 'no-such-message', emoji: '👍' })
    expect(await benSocket.nextFrame()).toMatchObject({ type: 'error' })

    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([message])
    expect((await readHistory(churchId, 'cy', 'worship')).messages).toEqual([elsewhere])
    expect(worshipSocket.received()).toHaveLength(1)
  })

  it('refuses a reaction to a deleted message', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [general] })
    const benSocket = await openSocket(churchId, 'ben', 'general')
    const message = await post(benSocket, 'Wrong channel')
    expect((await deleteMessage(churchId, 'ben', 'general', message.id)).status).toBe(204)
    await benSocket.nextFrame()

    benSocket.send({ type: 'react', messageId: message.id, emoji: '👍' })

    expect(await benSocket.nextFrame()).toMatchObject({ type: 'error' })
    const forAdmin = (await readHistory(churchId, 'ana', 'general')).messages
    expect(forAdmin[0]?.reactions).toEqual([])
  })

  it("never reaches another church's channel with the same ID", async () => {
    const first = await seedChurch({ people: [ben, cy], channels: [general] })
    const second = await seedChurch({ people: [ben, cy], channels: [general] })
    const firstSocket = await openSocket(first.churchId, 'ben', 'general')
    const secondSocket = await openSocket(second.churchId, 'cy', 'general')
    const message = await post(firstSocket, 'Rehearsal at 6')

    secondSocket.send({ type: 'react', messageId: message.id, emoji: '👍' })

    expect(await secondSocket.nextFrame()).toMatchObject({ type: 'error' })
    expect(firstSocket.received()).toHaveLength(1)
    expect((await readHistory(first.churchId, 'cy', 'general')).messages).toEqual([message])
  })
})

describe('who may react', () => {
  it('lets a member react in announcements, where they cannot post', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [announcements] })
    const anaSocket = await openSocket(churchId, 'ana', 'announcements')
    const benSocket = await openSocket(churchId, 'ben', 'announcements')
    const message = await post(anaSocket, 'Potluck after service')
    await benSocket.nextFrame()

    benSocket.send({ type: 'react', messageId: message.id, emoji: '🙌' })

    expect(await anaSocket.nextFrame()).toEqual({
      type: 'reactions',
      messageId: message.id,
      reactions: [{ emoji: '🙌', personIds: ['ben'] }],
    })
  })

  it('refuses an admin who reads a private channel only by oversight, so oversight stays read only', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    const anaSocket = await openSocket(churchId, 'ana', 'staff')
    const benSocket = await openSocket(churchId, 'ben', 'staff')
    const message = await post(benSocket, 'Budget draft is in the drive')
    await anaSocket.nextFrame()

    anaSocket.send({ type: 'react', messageId: message.id, emoji: '👍' })
    expect(await anaSocket.nextFrame()).toMatchObject({ type: 'error' })
    anaSocket.send({ type: 'unreact', messageId: message.id, emoji: '👍' })
    expect(await anaSocket.nextFrame()).toMatchObject({ type: 'error' })

    expect(benSocket.received()).toHaveLength(1)
    expect((await readHistory(churchId, 'ben', 'staff')).messages[0]?.reactions).toEqual([])
  })

  it('lets an admin who is a member of a private channel react there', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy],
      channels: [{ ...staff, members: ['ana', 'ben', 'cy'] }],
    })
    const anaSocket = await openSocket(churchId, 'ana', 'staff')
    const message = await post(anaSocket, 'Budget draft is in the drive')

    anaSocket.send({ type: 'react', messageId: message.id, emoji: '✅' })

    expect(await anaSocket.nextFrame()).toMatchObject({
      type: 'reactions',
      reactions: [{ emoji: '✅', personIds: ['ana'] }],
    })
  })
})
