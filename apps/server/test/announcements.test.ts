import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type Channel, channelObjectName } from '../src/channel.ts'
import { listChannels, openSocket, readHistory, seedChurch, setRole } from './support/church.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor', role: 'chat-admin' as const }
const cy = { personId: 'cy', name: 'Cy Park' }
const PEOPLE = [ana, ben, cy]

const announcements = {
  channelId: 'announcements',
  name: 'announcements',
  kind: 'announcements' as const,
}
const general = { channelId: 'general', name: 'general', kind: 'open' as const }

describe('posting in announcements', () => {
  it("refuses a member's message with an error frame, and stores nothing", async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [announcements] })
    const cySocket = await openSocket(churchId, 'cy', 'announcements')
    const anaSocket = await openSocket(churchId, 'ana', 'announcements')

    cySocket.send({ type: 'send', body: 'Can I post here?' })

    expect(await cySocket.nextFrame()).toMatchObject({ type: 'error' })
    expect(await readHistory(churchId, 'ana', 'announcements')).toEqual({
      messages: [],
      authors: [],
    })
    expect(anaSocket.received()).toEqual([])
    cySocket.close()
    anaSocket.close()
  })

  it.each([
    ['an admin', 'ana'],
    ['a chat admin', 'ben'],
  ])(
    "stores %s's message and delivers it to every socket, a member's included",
    async (_label, author) => {
      const { churchId } = await seedChurch({ people: PEOPLE, channels: [announcements] })
      const sockets = {
        ana: await openSocket(churchId, 'ana', 'announcements'),
        ben: await openSocket(churchId, 'ben', 'announcements'),
        cy: await openSocket(churchId, 'cy', 'announcements'),
      }

      sockets[author as 'ana' | 'ben'].send({ type: 'send', body: 'Doors open at 8:30' })

      for (const socket of Object.values(sockets)) {
        expect(await socket.nextFrame()).toMatchObject({
          type: 'message',
          message: { authorId: author, body: 'Doors open at 8:30' },
        })
        socket.close()
      }
      const history = await readHistory(churchId, 'cy', 'announcements')
      expect(history.messages.map((m) => [m.authorId, m.body])).toEqual([
        [author, 'Doors open at 8:30'],
      ])
    },
  )

  it('refuses a chat admin made a member while their socket is open, on their next send', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [announcements] })
    const benSocket = await openSocket(churchId, 'ben', 'announcements')
    benSocket.send({ type: 'send', body: 'Before' })
    expect(await benSocket.nextFrame()).toMatchObject({ type: 'message' })

    expect((await setRole(churchId, 'ana', 'ben', 'member')).status).toBe(204)
    benSocket.send({ type: 'send', body: 'After' })

    expect(await benSocket.nextFrame()).toMatchObject({ type: 'error' })
    const history = await readHistory(churchId, 'ana', 'announcements')
    expect(history.messages.map((m) => m.body)).toEqual(['Before'])
    benSocket.close()
  })

  it('tells each person in the channel list whether they may post there', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [announcements, general] })

    const canPost = async (personId: string) =>
      (await listChannels(churchId, personId)).channels.map((c) => [c.id, c.canPost])

    expect(await canPost('cy')).toEqual([
      ['announcements', false],
      ['general', true],
    ])
    for (const personId of ['ana', 'ben']) {
      expect(await canPost(personId), personId).toEqual([
        ['announcements', true],
        ['general', true],
      ])
    }
  })
})

describe('posting in an open channel', () => {
  it("stores every member's message, as before", async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })
    const cySocket = await openSocket(churchId, 'cy', 'general')

    cySocket.send({ type: 'send', body: 'Anyone for coffee?' })

    expect(await cySocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { authorId: 'cy', body: 'Anyone for coffee?' },
    })
    cySocket.close()
  })

  it('keeps the order of messages sent in quick succession, even when the directory answers the first one last', async () => {
    const churchId = `church-${crypto.randomUUID()}`
    const holder = { churchId, channelId: 'general', personId: 'cy' }
    // The church directory as the channel sees it, answering the first post check last.
    let checks = 0
    const slowFirstAnswer = {
      postAccess: async () => {
        checks += 1
        if (checks === 1) await new Promise((resolve) => setTimeout(resolve, 50))
        return { access: 'granted', mentions: [], teamAnnouncement: false, urgent: false }
      },
      // No one to push to, so the alerts send nothing.
      alertTargets: async () => ({ channelName: 'general', authorName: 'Cy Park', pushes: [] }),
    }
    const channelEnv = {
      ...env,
      CHURCH_DIRECTORY: { getByName: () => slowFirstAnswer },
    }
    const socket = { deserializeAttachment: () => holder, send: () => {} } as unknown as WebSocket

    const bodies = await runInDurableObject(
      env.CHANNEL.getByName(channelObjectName(churchId, 'general')),
      async (channel: Channel) => {
        Object.defineProperty(channel, 'env', { value: channelEnv })
        await Promise.all(
          ['one', 'two', 'three'].map((body) =>
            channel.webSocketMessage(socket, JSON.stringify({ type: 'send', body })),
          ),
        )
        return channel.history(churchId, 'general').messages.map((m) => m.body)
      },
    )

    expect(checks).toBe(3)
    expect(bodies).toEqual(['one', 'two', 'three'])
  })
})
