import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { asMember, openSocket, readHistory, seedChurch } from './support/church.ts'

/** Two churches that both have a channel called `sunday-team`, and one channel only B has. */
async function seedTwoChurches() {
  const a = await seedChurch({
    people: [{ personId: 'ana', name: 'Ana Ortiz' }],
    channels: [{ channelId: 'sunday-team', name: 'Sunday team', kind: 'open' }],
  })
  const b = await seedChurch({
    people: [{ personId: 'bo', name: 'Bo Lindqvist' }],
    channels: [
      { channelId: 'sunday-team', name: 'Sunday team', kind: 'open' },
      { channelId: 'youth-leaders', name: 'Youth leaders', kind: 'open' },
    ],
  })
  return { a: a.churchId, b: b.churchId }
}

async function post(churchId: string, personId: string, channelId: string, body: string) {
  const socket = await openSocket(churchId, personId, channelId)
  socket.send({ type: 'send', body })
  await socket.nextFrame()
  socket.close()
}

describe('a member of one church and a channel of another', () => {
  it("cannot read the other church's channel", async () => {
    const { a } = await seedTwoChurches()

    const response = await asMember(a, 'ana', '/channels/youth-leaders/messages')

    expect(response.status).toBe(404)
  })

  it("cannot open the other church's channel socket", async () => {
    const { a } = await seedTwoChurches()

    const response = await asMember(a, 'ana', '/channels/youth-leaders/socket', {
      headers: { upgrade: 'websocket' },
    })

    expect(response.status).toBe(404)
    expect(response.webSocket).toBeNull()
  })

  it('cannot claim the other church by putting its ID in their identity', async () => {
    const { b } = await seedTwoChurches()

    const history = await asMember(b, 'ana', '/channels/sunday-team/messages')
    const socket = await asMember(b, 'ana', '/channels/sunday-team/socket', {
      headers: { upgrade: 'websocket' },
    })

    expect(history.status).toBe(404)
    expect(socket.status).toBe(404)
  })

  it('answers the same as for a channel that does not exist anywhere', async () => {
    const { a } = await seedTwoChurches()

    const otherChurch = await asMember(a, 'ana', '/channels/youth-leaders/messages')
    const nowhere = await asMember(a, 'ana', '/channels/no-such-channel/messages')

    expect([otherChurch.status, await otherChurch.text()]).toEqual([
      nowhere.status,
      await nowhere.text(),
    ])
  })
})

describe('two churches with a channel of the same ID', () => {
  it("keep separate histories: a post in one never reaches the other's", async () => {
    const { a, b } = await seedTwoChurches()
    await post(b, 'bo', 'sunday-team', 'From church B')

    await post(a, 'ana', 'sunday-team', 'From church A')

    expect((await readHistory(a, 'ana', 'sunday-team')).messages).toMatchObject([
      { churchId: a, authorId: 'ana', body: 'From church A' },
    ])
    expect((await readHistory(b, 'bo', 'sunday-team')).messages).toMatchObject([
      { churchId: b, authorId: 'bo', body: 'From church B' },
    ])
  })

  it("never deliver one church's live message to the other church's sockets", async () => {
    const { a, b } = await seedTwoChurches()
    const boSocket = await openSocket(b, 'bo', 'sunday-team')

    await post(a, 'ana', 'sunday-team', 'Only for church A')
    // A message in B's own channel, so the socket has something to receive before the check.
    boSocket.send({ type: 'send', body: 'Only for church B' })

    expect(await boSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { churchId: b, body: 'Only for church B' },
    })
    expect(boSocket.received()).toHaveLength(1)
    boSocket.close()
  })
})

describe('a request with no identity', () => {
  it.each([
    ['history', '/channels/sunday-team/messages', {}],
    ['socket', '/channels/sunday-team/socket', { headers: { upgrade: 'websocket' } }],
  ])('is refused on the %s route', async (_label, path, init) => {
    await seedTwoChurches()

    const response = await exports.default.fetch(`https://phon.test${path}`, init)

    expect(response.status).toBe(401)
  })
})
