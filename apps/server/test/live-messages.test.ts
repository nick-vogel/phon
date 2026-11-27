import { describe, expect, it } from 'vitest'
import { openSocket, readHistory, seedChurch } from './support/church.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz' }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const sundayTeam = { channelId: 'sunday-team', name: 'Sunday team', kind: 'open' as const }

describe('live messages in an open channel', () => {
  it('delivers a message one member sends to another member live', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [sundayTeam] })
    const anaSocket = await openSocket(churchId, 'ana', 'sunday-team')
    const benSocket = await openSocket(churchId, 'ben', 'sunday-team')

    anaSocket.send({ type: 'send', body: 'Doors open at 8:30 this week' })

    const frame = await benSocket.nextFrame()
    expect(frame).toMatchObject({
      type: 'message',
      message: {
        churchId,
        channelId: 'sunday-team',
        authorId: 'ana',
        body: 'Doors open at 8:30 this week',
      },
    })
    anaSocket.close()
    benSocket.close()
  })

  it('echoes the message to its sender, so every device shows the stored copy', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [sundayTeam] })
    const anaSocket = await openSocket(churchId, 'ana', 'sunday-team')

    anaSocket.send({ type: 'send', body: 'Running five minutes late' })

    expect(await anaSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { authorId: 'ana', body: 'Running five minutes late' },
    })
    anaSocket.close()
  })
})

describe('channel history', () => {
  it('returns the messages in send order, including one sent before the member connected', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [sundayTeam] })
    const anaSocket = await openSocket(churchId, 'ana', 'sunday-team')
    for (const body of ['First', 'Second', 'Third']) {
      anaSocket.send({ type: 'send', body })
      await anaSocket.nextFrame()
    }
    anaSocket.close()

    const history = await readHistory(churchId, 'ben', 'sunday-team')

    expect(history.messages.map((message) => [message.authorId, message.body])).toEqual([
      ['ana', 'First'],
      ['ana', 'Second'],
      ['ana', 'Third'],
    ])
  })

  it('returns the same message the live frame carried', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [sundayTeam] })
    const anaSocket = await openSocket(churchId, 'ana', 'sunday-team')
    anaSocket.send({ type: 'send', body: 'Soundcheck at 9' })
    const frame = await anaSocket.nextFrame()
    anaSocket.close()

    const history = await readHistory(churchId, 'ben', 'sunday-team')

    expect(frame.type).toBe('message')
    expect(history.messages).toEqual([frame.type === 'message' ? frame.message : undefined])
  })

  it('is empty for a channel nobody has posted in', async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [sundayTeam] })

    expect(await readHistory(churchId, 'ana', 'sunday-team')).toEqual({ messages: [], authors: [] })
  })
})

describe('a send frame the channel refuses', () => {
  it.each([
    ['an empty body', { type: 'send', body: '' }],
    ['a body of only spaces', { type: 'send', body: '   ' }],
    ['a body that is not a string', { type: 'send', body: 42 }],
    ['an unknown frame type', { type: 'shout', body: 'hi' }],
  ])('answers %s with an error frame and stores nothing', async (_label, frame) => {
    const { churchId } = await seedChurch({ people: [ana], channels: [sundayTeam] })
    const anaSocket = await openSocket(churchId, 'ana', 'sunday-team')

    anaSocket.sendRaw(JSON.stringify(frame))

    expect(await anaSocket.nextFrame()).toMatchObject({ type: 'error' })
    anaSocket.close()
    expect(await readHistory(churchId, 'ana', 'sunday-team')).toEqual({ messages: [], authors: [] })
  })

  it('answers a frame that is not JSON with an error frame', async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [sundayTeam] })
    const anaSocket = await openSocket(churchId, 'ana', 'sunday-team')

    anaSocket.sendRaw('not json')

    expect(await anaSocket.nextFrame()).toMatchObject({ type: 'error' })
    anaSocket.close()
  })
})
