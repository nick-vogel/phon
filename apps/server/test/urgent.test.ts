import { describe, expect, it } from 'vitest'
import {
  postFrame,
  postMessage,
  readHistory,
  readMe,
  registerDevice,
  seedChurch,
  setAlertLevel,
  setQuietHours,
  setRole,
} from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'
import { quietWindowAround, zoneAhead } from './support/time-zones.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor', role: 'chat-admin' as const }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const fay = { personId: 'fay', name: 'Fay Lindqvist' }
/** An admin on no private channel, who reads Staff only by oversight. */
const gus = { personId: 'gus', name: 'Gus Ferreira', role: 'admin' as const }
const PEOPLE = [ana, ben, cy, dee, fay, gus]
const EVERYONE = PEOPLE.map((person) => person.personId)

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ana', 'ben', 'cy', 'dee'],
}
/** Ben, a chat admin, and Fay, a member, lead Worship. */
const worship = {
  channelId: 'worship',
  name: 'Worship',
  kind: 'team' as const,
  members: ['ben', 'cy', 'fay'],
  leaders: ['ben', 'fay'],
}
const CHANNELS = [general, staff, worship]

const NOT_URGENT_SENDER = 'Only admins and chat admins mark a message urgent.'

async function churchWithDevices() {
  const expo = fakeExpoPush()
  const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })
  for (const personId of EVERYONE) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return { expo, churchId }
}

/** Posts a frame as a person and fails unless it comes back stored. */
async function posted(
  churchId: string,
  personId: string,
  channelId: string,
  frame: Record<string, unknown>,
) {
  const answer = await postFrame(churchId, personId, channelId, { type: 'send', ...frame })
  if (answer.type !== 'message') throw new Error(`Answered ${JSON.stringify(answer)}`)
  return answer.message
}

function urgent(
  churchId: string,
  personId: string,
  channelId: string,
  body = 'Parking lot flooded',
) {
  return posted(churchId, personId, channelId, { body, urgent: true })
}

describe('an urgent message from an admin or chat admin', () => {
  it.each([
    ['an admin', 'ana', 'Ana Ortiz'],
    ['a chat admin', 'ben', 'Ben Okafor'],
  ])(
    'from %s pushes Time Sensitive on the urgent channel to everyone, through quiet hours and off',
    async (_label, author, authorName) => {
      const { expo, churchId } = await churchWithDevices()
      const zone = zoneAhead(0)
      const quiet = { quietHours: { ...quietWindowAround(zone), timeZone: zone } }
      expect((await setQuietHours(churchId, 'cy', quiet)).status).toBe(204)
      expect((await setAlertLevel(churchId, 'dee', 'general', 'off')).status).toBe(204)

      const message = await urgent(churchId, author, 'general')
      const marker = await urgent(churchId, author, 'general', 'Marker')
      const pushes = await expo.pushesFor(message.id, { after: marker.id })

      expect(message.urgent).toBe(true)
      expect(pushes.map((push) => push.to)).toEqual(
        EVERYONE.filter((personId) => personId !== author).map((personId) => tokenOf(personId)),
      )
      for (const push of pushes) {
        expect(push).toEqual({
          to: push.to,
          title: 'Urgent in #general',
          body: `${authorName}: Parking lot flooded`,
          data: { channelId: 'general', messageId: message.id },
          sound: 'default',
          priority: 'high',
          interruptionLevel: 'time-sensitive',
          channelId: 'urgent',
          badge: 0,
        })
      }
    },
  )

  it('is stored and read back marked urgent, and a plain one is not', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    const plain = await postMessage(churchId, 'ana', 'general', 'Coffee is on')
    const marked = await urgent(churchId, 'ana', 'general')

    const history = await readHistory(churchId, 'cy', 'general')
    expect(history.messages).toEqual([plain, marked])
    expect(history.messages[0]).not.toHaveProperty('urgent')
    expect(history.messages[1]?.urgent).toBe(true)
  })

  it('in a private channel does not push to an admin who reads it only by oversight', async () => {
    const { expo, churchId } = await churchWithDevices()

    const message = await urgent(churchId, 'ana', 'staff')
    const marker = await urgent(churchId, 'ana', 'staff', 'Marker')
    const pushes = await expo.pushesFor(message.id, { after: marker.id })

    expect(pushes.map((push) => push.to)).toEqual(
      ['ben', 'cy', 'dee'].map((personId) => tokenOf(personId)),
    )
    expect(expo.pushesTo(tokenOf('gus'))).toEqual([])
  })

  it('that is also a team announcement, from a chat admin who leads the team, is Time Sensitive too', async () => {
    const { expo, churchId } = await churchWithDevices()

    const message = await posted(churchId, 'ben', 'worship', {
      body: 'Rehearsal is cancelled',
      teamAnnouncement: true,
      urgent: true,
    })
    const marker = await urgent(churchId, 'ben', 'worship', 'Marker')
    const pushes = await expo.pushesFor(message.id, { after: marker.id })

    expect(message).toMatchObject({ teamAnnouncement: true, urgent: true })
    expect(
      pushes.map((push) => [push.to, push.title, push.interruptionLevel, push.channelId]),
    ).toEqual(
      ['cy', 'fay'].map((personId) => [
        tokenOf(personId),
        'Urgent in #Worship',
        'time-sensitive',
        'urgent',
      ]),
    )
  })
})

describe('marking a message urgent without the role for it', () => {
  it.each([
    ['a member', 'cy', 'general'],
    ['a member who leads a team, in their own team channel', 'fay', 'worship'],
  ])(
    'is refused for %s, stored nowhere and pushed to no one',
    async (_label, personId, channelId) => {
      const { expo, churchId } = await churchWithDevices()

      const frame = await postFrame(churchId, personId, channelId, {
        type: 'send',
        body: 'Everyone, now',
        urgent: true,
      })

      expect(frame).toEqual({ type: 'error', reason: NOT_URGENT_SENDER })
      expect((await readHistory(churchId, 'ana', channelId)).messages).toEqual([])
      const marker = await urgent(churchId, 'ben', channelId, 'Marker')
      await expo.pushesFor(marker.id, { after: marker.id })
      expect(expo.pushes().every((push) => push.data.messageId === marker.id)).toBe(true)
    },
  )

  it('is refused for a chat admin made a member, on their next urgent send', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })
    expect(await urgent(churchId, 'ben', 'general', 'Before')).toMatchObject({ urgent: true })

    expect((await setRole(churchId, 'ana', 'ben', 'member')).status).toBe(204)

    expect(
      await postFrame(churchId, 'ben', 'general', { type: 'send', body: 'After', urgent: true }),
    ).toEqual({ type: 'error', reason: NOT_URGENT_SENDER })
    const history = await readHistory(churchId, 'ana', 'general')
    expect(history.messages.map((message) => message.body)).toEqual(['Before'])
  })

  it('treats any value but true as a plain send', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    const message = await posted(churchId, 'cy', 'general', { body: 'Hi', urgent: 'yes' })

    expect(message).not.toHaveProperty('urgent')
  })

  it.each([
    ['an admin', 'ana', true],
    ['a chat admin', 'ben', true],
    ['a member', 'cy', false],
  ])('is offered by /me to %s: %s', async (_label, personId, canMarkUrgent) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    expect(await readMe(churchId, personId)).toMatchObject({ canMarkUrgent })
  })
})
