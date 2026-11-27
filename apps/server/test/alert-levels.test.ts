import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  asMember,
  postMessage,
  readAlerts,
  registerDevice,
  seedChurch,
  setAlertLevel,
} from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor', role: 'chat-admin' as const }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const PEOPLE = [ana, ben, cy, dee]
const EVERYONE = PEOPLE.map((person) => person.personId)

const announcements = {
  channelId: 'announcements',
  name: 'announcements',
  kind: 'announcements' as const,
}
const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const worship = { channelId: 'worship', name: 'Worship', kind: 'team' as const, members: EVERYONE }
const worshipLeads = {
  channelId: 'worship-leads',
  name: 'Worship leads',
  kind: 'team-leads' as const,
  members: EVERYONE,
}
const staff = { channelId: 'staff', name: 'Staff', kind: 'private' as const, members: EVERYONE }
const tuesdayGroup = {
  channelId: 'group-7',
  name: 'Tuesday group',
  kind: 'small-group' as const,
  members: EVERYONE,
}
const CHANNELS = [announcements, general, worship, worshipLeads, staff, tuesdayGroup]

/** A church with one channel of each kind, everyone a member, and every device registered. */
async function churchWithDevices() {
  const expo = fakeExpoPush()
  const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })
  for (const personId of EVERYONE) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return { expo, churchId }
}

/**
 * Posts a plain message as Ana, then one in the same channel that @mentions Dee, and waits for
 * Dee's push for the second. Pushes leave a channel in message order, so once Dee's has arrived
 * every push for the plain message has too. Answers the tokens the plain message pushed to.
 */
async function plainMessagePushes(
  churchId: string,
  expo: ReturnType<typeof fakeExpoPush>,
  channelId: string,
  author = 'ana',
): Promise<string[]> {
  const plain = await postMessage(churchId, author, channelId, 'A plain message')
  const marker = await postMessage(churchId, author, channelId, 'Dee?', ['dee'])
  const arrived = (id: string) => expo.pushes().some((push) => push.data.messageId === id)
  const deadline = Date.now() + 2000
  while (!arrived(marker.id)) {
    if (Date.now() > deadline) throw new Error(`No push for the marker in ${channelId}`)
    await expo.waitForPushes(expo.pushes().length + 1, Math.max(1, deadline - Date.now()))
  }
  return expo
    .pushes()
    .filter((push) => push.data.messageId === plain.id)
    .map((push) => push.to)
}

describe('the default alert level of each channel kind', () => {
  it.each([
    ['announcements', 'announcements', [tokenOf('ben'), tokenOf('cy'), tokenOf('dee')]],
    ['a private channel', 'staff', [tokenOf('ben'), tokenOf('cy'), tokenOf('dee')]],
    ['an open channel', 'general', []],
    ['a team channel', 'worship', []],
    ['a team leads channel', 'worship-leads', []],
    ['a small group channel', 'group-7', []],
  ])(
    "pushes a plain message in %s to everyone else's device as the default says",
    async (_label, channelId, tokens) => {
      const { expo, churchId } = await churchWithDevices()

      expect(await plainMessagePushes(churchId, expo, channelId)).toEqual(tokens)
    },
  )

  it.each([
    ['announcements', 'every-message', []],
    ['general', 'mentions', ['every-message', 'mentions', 'off']],
    [
      'worship',
      'mentions-and-team-announcements',
      ['every-message', 'mentions-and-team-announcements', 'mentions', 'off'],
    ],
    ['worship-leads', 'mentions', ['every-message', 'mentions', 'off']],
    ['staff', 'every-message', ['every-message', 'mentions', 'off']],
    ['group-7', 'mentions', ['every-message', 'mentions', 'off']],
  ])('answers %s with its default level %s and its choices', async (channelId, level, choices) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    expect(await readAlerts(churchId, 'cy', channelId)).toEqual({ level, choices })
  })
})

describe('a member changing a channel alert level', () => {
  it('turns every message on for an open channel, and the next message pushes to them', async () => {
    const { expo, churchId } = await churchWithDevices()

    expect((await setAlertLevel(churchId, 'cy', 'general', 'every-message')).status).toBe(204)

    expect(await readAlerts(churchId, 'cy', 'general')).toEqual({
      level: 'every-message',
      choices: ['every-message', 'mentions', 'off'],
    })
    expect(await plainMessagePushes(churchId, expo, 'general')).toEqual([tokenOf('cy')])
  })

  it('turns a private channel off, and gets nothing, not even an @mention', async () => {
    const { expo, churchId } = await churchWithDevices()
    expect((await setAlertLevel(churchId, 'cy', 'staff', 'off')).status).toBe(204)

    const mention = await postMessage(churchId, 'ana', 'staff', 'Cy, are you there?', ['cy'])
    const after = await postMessage(churchId, 'ana', 'staff', 'Anyone?')
    await expo.waitForPushes(4)

    const pushedTo = (id: string) =>
      expo
        .pushes()
        .filter((push) => push.data.messageId === id)
        .map((push) => push.to)
    expect(pushedTo(mention.id)).toEqual([tokenOf('ben'), tokenOf('dee')])
    expect(pushedTo(after.id)).toEqual([tokenOf('ben'), tokenOf('dee')])
  })

  it('sets a private channel to @mentions only, and gets only the @mentions', async () => {
    const { expo, churchId } = await churchWithDevices()
    expect((await setAlertLevel(churchId, 'cy', 'staff', 'mentions')).status).toBe(204)

    const plain = await postMessage(churchId, 'ana', 'staff', 'Plain')
    const mention = await postMessage(churchId, 'ana', 'staff', 'Cy, are you there?', ['cy'])
    await expo.waitForPushes(5)

    expect(expo.pushesTo(tokenOf('cy')).map((push) => push.data.messageId)).toEqual([mention.id])
    expect(expo.pushes().filter((push) => push.data.messageId === plain.id)).toHaveLength(2)
  })

  it("changes nothing for anyone else's alerts", async () => {
    const { expo, churchId } = await churchWithDevices()
    expect((await setAlertLevel(churchId, 'cy', 'staff', 'off')).status).toBe(204)

    expect(await readAlerts(churchId, 'ben', 'staff')).toMatchObject({ level: 'every-message' })
    expect(await plainMessagePushes(churchId, expo, 'staff')).toEqual([
      tokenOf('ben'),
      tokenOf('dee'),
    ])
  })

  it.each([
    ['a level an open channel does not offer', 'general', 'mentions-and-team-announcements'],
    ['a level no channel offers', 'general', 'loud'],
    ['no level at all', 'staff', undefined],
  ])('refuses %s with 400', async (_label, channelId, level) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    const response = await asMember(churchId, 'cy', `/channels/${channelId}/alerts`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(level === undefined ? {} : { level }),
    })

    expect(response.status).toBe(400)
    expect(await readAlerts(churchId, 'cy', channelId)).toMatchObject({
      level: channelId === 'staff' ? 'every-message' : 'mentions',
    })
  })

  it('answers 404 for a channel they cannot open, the same as an unknown one', async () => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [{ ...staff, members: ['ana', 'ben', 'dee'] }],
    })

    for (const channelId of ['staff', 'nowhere']) {
      expect((await setAlertLevel(churchId, 'cy', channelId, 'off')).status, channelId).toBe(404)
      expect((await asMember(churchId, 'cy', `/channels/${channelId}/alerts`)).status).toBe(404)
    }
  })

  it('answers 403 to an admin who reads a private channel only by oversight', async () => {
    const { churchId } = await seedChurch({
      people: PEOPLE,
      channels: [{ ...staff, members: ['ben', 'cy', 'dee'] }],
    })

    expect((await asMember(churchId, 'ana', '/channels/staff/alerts')).status).toBe(403)
    expect((await setAlertLevel(churchId, 'ana', 'staff', 'every-message')).status).toBe(403)
  })

  it.each([['POST'], ['DELETE']])('answers 405 for %s', async (method) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    expect((await asMember(churchId, 'cy', '/channels/general/alerts', { method })).status).toBe(
      405,
    )
  })
})

describe('announcements', () => {
  it.each([
    ['a member', 'cy'],
    ['a chat admin', 'ben'],
    ['an admin', 'ana'],
  ])('cannot be turned off or down by %s', async (_label, personId) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    for (const level of ['off', 'mentions', 'every-message']) {
      const response = await setAlertLevel(churchId, personId, 'announcements', level)
      expect(response.status, level).toBe(403)
    }
    expect(await readAlerts(churchId, personId, 'announcements')).toEqual({
      level: 'every-message',
      choices: [],
    })
  })

  it('push even over a level stored for them, which no request can set', async () => {
    const { expo, churchId } = await churchWithDevices()
    await runInDurableObject(env.CHURCH_DIRECTORY.getByName(churchId), (_directory, state) => {
      state.storage.sql.exec(
        `INSERT INTO alert_levels (church_id, person_id, channel_id, level)
         VALUES (?, 'cy', 'announcements', 'off')`,
        churchId,
      )
    })

    const message = await postMessage(churchId, 'ben', 'announcements', 'Doors open at 8:30')
    await expo.waitForPushes(3)

    expect(expo.pushesTo(tokenOf('cy')).map((push) => push.data.messageId)).toEqual([message.id])
  })

  it('still push to a member who tried to turn them off', async () => {
    const { expo, churchId } = await churchWithDevices()
    expect((await setAlertLevel(churchId, 'cy', 'announcements', 'off')).status).toBe(403)

    const message = await postMessage(churchId, 'ben', 'announcements', 'Doors open at 8:30')
    await expo.waitForPushes(3)

    expect(expo.pushesTo(tokenOf('cy')).map((push) => push.data.messageId)).toEqual([message.id])
  })
})
