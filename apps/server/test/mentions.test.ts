import { describe, expect, it } from 'vitest'
import {
  asMember,
  openSocket,
  postMessage,
  readChannelPeople,
  readHistory,
  registerDevice,
  seedChurch,
} from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const eli = { personId: 'eli', name: 'Eli Brandt' }
const PEOPLE = [ana, ben, cy, dee, eli]

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const worship = {
  channelId: 'worship',
  name: 'Worship',
  kind: 'team' as const,
  members: ['ana', 'ben', 'cy'],
}
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ana', 'ben', 'cy'],
}

/** A church whose people all have a registered device. */
async function churchWithDevices(channels = [general, worship, staff]) {
  const expo = fakeExpoPush()
  const { churchId } = await seedChurch({ people: PEOPLE, channels })
  for (const { personId } of PEOPLE) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return { expo, churchId }
}

describe('an @mention', () => {
  it.each([
    ['an open channel, @mentions only by default', 'general'],
    ['a team channel, @mentions and team announcements by default', 'worship'],
  ])('in %s pushes to the person mentioned and no one else', async (_label, channelId) => {
    const { expo, churchId } = await churchWithDevices()
    const benSocket = await openSocket(churchId, 'ben', channelId)

    const message = await postMessage(churchId, 'ana', channelId, '@Cy Park can you lead?', ['cy'])
    const pushes = await expo.waitForPushes(1)

    expect(pushes.map((push) => [push.to, push.data.messageId])).toEqual([
      [tokenOf('cy'), message.id],
    ])
    expect(message.mentions).toEqual(['cy'])
    expect(await benSocket.nextFrame()).toMatchObject({
      type: 'message',
      message: { id: message.id, mentions: ['cy'] },
    })
    expect((await readHistory(churchId, 'ben', channelId)).messages).toMatchObject([
      { id: message.id, mentions: ['cy'] },
    ])
    benSocket.close()
  })

  it('pushes once to a person mentioned twice, and keeps them once', async () => {
    const { expo, churchId } = await churchWithDevices()

    const message = await postMessage(churchId, 'ana', 'general', 'Cy! Cy!', ['cy', 'cy', 'ben'])
    await postMessage(churchId, 'ana', 'general', 'Dee?', ['dee'])
    await expo.waitForPushes(3)

    expect(message.mentions).toEqual(['cy', 'ben'])
    expect(expo.pushesTo(tokenOf('cy'))).toHaveLength(1)
  })

  it.each([
    ['the author', ['ana']],
    ['a person who may not open the channel', ['dee']],
    ["a person of another church, or no one's ID", ['zed', 'nobody']],
  ])('of %s pushes nothing and is dropped', async (_label, mentions) => {
    const { expo, churchId } = await churchWithDevices()
    await seedChurch({ people: [{ personId: 'zed', name: 'Zed Other' }], channels: [general] })

    const message = await postMessage(churchId, 'ana', 'worship', 'Hello', mentions)
    const marker = await postMessage(churchId, 'ana', 'worship', 'Ben?', ['ben'])
    const pushes = await expo.waitForPushes(1)

    expect(message.mentions).toEqual([])
    expect(pushes.map((push) => push.data.messageId)).toEqual([marker.id])
  })

  it('keeps at most 50 people', async () => {
    const crowd = Array.from({ length: 51 }, (_, i) => ({
      personId: `p${String(i).padStart(2, '0')}`,
      name: `Person ${i}`,
    }))
    const { churchId } = await seedChurch({ people: [ana, ...crowd], channels: [general] })

    const message = await postMessage(
      churchId,
      'ana',
      'general',
      'Everyone!',
      crowd.map((p) => p.personId),
    )

    expect(message.mentions).toEqual(crowd.slice(0, 50).map((p) => p.personId))
  })

  it.each([
    ['not a list', 'cy'],
    ['a list with something other than IDs', ['cy', 42]],
    ['null', null],
  ])('that is %s keeps no mentions, and the message still posts', async (_label, mentions) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })

    const message = await postMessage(churchId, 'ana', 'general', 'Still here', mentions)

    expect(message).toMatchObject({ body: 'Still here', mentions: [] })
  })

  it('is empty on a message sent with none', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })

    const message = await postMessage(churchId, 'ana', 'general', 'No one in particular')

    expect(message.mentions).toEqual([])
    expect((await readHistory(churchId, 'ana', 'general')).messages[0]?.mentions).toEqual([])
  })
})

describe('the people of a channel, for @mention completion', () => {
  it('lists everyone current for an open channel, sorted by name', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })

    expect(await readChannelPeople(churchId, 'cy', 'general')).toEqual({
      people: [
        { personId: 'ana', name: 'Ana Ortiz' },
        { personId: 'ben', name: 'Ben Okafor' },
        { personId: 'cy', name: 'Cy Park' },
        { personId: 'dee', name: 'Dee Mensah' },
        { personId: 'eli', name: 'Eli Brandt' },
      ],
    })
  })

  it("lists only a private channel's members", async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [staff] })

    expect(await readChannelPeople(churchId, 'cy', 'staff')).toEqual({
      people: [
        { personId: 'ana', name: 'Ana Ortiz' },
        { personId: 'ben', name: 'Ben Okafor' },
        { personId: 'cy', name: 'Cy Park' },
      ],
    })
  })

  it('answers 404 for a channel the caller cannot open, the same as an unknown one', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [staff] })

    for (const channelId of ['staff', 'nowhere']) {
      expect((await asMember(churchId, 'dee', `/channels/${channelId}/people`)).status).toBe(404)
    }
  })

  it('answers 405 for any method but GET', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general] })

    const response = await asMember(churchId, 'cy', '/channels/general/people', { method: 'POST' })

    expect(response.status).toBe(405)
  })
})
