import { describe, expect, it } from 'vitest'
import {
  listChannels,
  openSocket,
  postFrame,
  postMessage,
  readHistory,
  registerDevice,
  seedChurch,
  setAlertLevel,
  setQuietHours,
} from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'
import { quietWindowAround, zoneAhead } from './support/time-zones.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const eli = { personId: 'eli', name: 'Eli Brandt' }
const fay = { personId: 'fay', name: 'Fay Okafor' }
const PEOPLE = [ana, cy, dee, eli, fay]
const EVERYONE = PEOPLE.map((person) => person.personId)

/** Fay leads Worship. She is on Kids too, which no one here leads. */
const worship = {
  channelId: 'worship',
  name: 'Worship',
  kind: 'team' as const,
  members: ['ana', 'cy', 'dee', 'eli', 'fay'],
  leaders: ['fay'],
}
const kids = { channelId: 'kids', name: 'Kids', kind: 'team' as const, members: ['cy', 'fay'] }
const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const teamLeads = {
  channelId: 'team-leads',
  name: 'team-leads',
  kind: 'team-leads' as const,
  members: ['cy', 'fay'],
}
const CHANNELS = [worship, kids, general, teamLeads]

const NOT_A_LEADER = "Only this team's leaders post team announcements here."

async function churchWithDevices() {
  const expo = fakeExpoPush()
  const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })
  for (const personId of EVERYONE) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return { expo, churchId }
}

/** Posts a team announcement as a person and fails unless it comes back stored. */
async function teamAnnouncement(churchId: string, personId: string, channelId: string) {
  const frame = await postFrame(churchId, personId, channelId, {
    type: 'send',
    body: 'Rehearsal moves to 6:30',
    teamAnnouncement: true,
  })
  if (frame.type !== 'message') throw new Error(`Answered ${JSON.stringify(frame)}`)
  return frame.message
}

describe("a team leader's team announcement", () => {
  it('alerts every other team member at the team default, titled as a team announcement', async () => {
    const { expo, churchId } = await churchWithDevices()

    const message = await teamAnnouncement(churchId, 'fay', 'worship')
    const marker = await teamAnnouncement(churchId, 'fay', 'worship')
    const pushes = await expo.pushesFor(message.id, { after: marker.id })

    expect(message.teamAnnouncement).toBe(true)
    expect(pushes.map((push) => push.to)).toEqual(
      ['ana', 'cy', 'dee', 'eli'].map((personId) => tokenOf(personId)),
    )
    for (const push of pushes) {
      expect(push).toMatchObject({
        title: 'Team announcement in #Worship',
        body: 'Fay Okafor: Rehearsal moves to 6:30',
        interruptionLevel: 'active',
        channelId: 'messages',
      })
    }
  })

  it('alerts nobody inside their quiet hours, and everyone else still', async () => {
    const { expo, churchId } = await churchWithDevices()
    const zone = zoneAhead(0)
    const quiet = { quietHours: { ...quietWindowAround(zone), timeZone: zone } }
    expect((await setQuietHours(churchId, 'dee', quiet)).status).toBe(204)

    const message = await teamAnnouncement(churchId, 'fay', 'worship')
    const marker = await teamAnnouncement(churchId, 'fay', 'worship')
    const pushes = await expo.pushesFor(message.id, { after: marker.id })

    expect(pushes.map((push) => push.to)).toEqual(
      ['ana', 'cy', 'eli'].map((personId) => tokenOf(personId)),
    )
    expect(expo.pushesTo(tokenOf('dee'))).toEqual([])
  })

  it('alerts a member at every message, and not one at @mentions only or off', async () => {
    const { expo, churchId } = await churchWithDevices()
    expect((await setAlertLevel(churchId, 'cy', 'worship', 'mentions')).status).toBe(204)
    expect((await setAlertLevel(churchId, 'dee', 'worship', 'off')).status).toBe(204)
    expect((await setAlertLevel(churchId, 'eli', 'worship', 'every-message')).status).toBe(204)

    const message = await teamAnnouncement(churchId, 'fay', 'worship')
    const marker = await teamAnnouncement(churchId, 'fay', 'worship')
    const pushes = await expo.pushesFor(message.id, { after: marker.id })

    expect(pushes.map((push) => push.to)).toEqual([tokenOf('ana'), tokenOf('eli')])
  })

  it("is told apart from the same leader's plain post, which alerts no one at the team default", async () => {
    const { expo, churchId } = await churchWithDevices()

    const plain = await postMessage(churchId, 'fay', 'worship', 'Rehearsal moves to 6:30')
    const marker = await teamAnnouncement(churchId, 'fay', 'worship')

    expect(await expo.pushesFor(plain.id, { after: marker.id })).toEqual([])
    expect(plain).not.toHaveProperty('teamAnnouncement')
    const history = await readHistory(churchId, 'cy', 'worship')
    expect(history.messages.map((m) => [m.id, m.teamAnnouncement])).toEqual([
      [plain.id, undefined],
      [marker.id, true],
    ])
    expect(history.messages[0]).not.toHaveProperty('teamAnnouncement')
  })

  it('is delivered live to every socket marked as a team announcement', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })
    const cySocket = await openSocket(churchId, 'cy', 'worship')

    const message = await teamAnnouncement(churchId, 'fay', 'worship')

    expect(await cySocket.nextFrame()).toEqual({ type: 'message', message })
    expect(message.teamAnnouncement).toBe(true)
    cySocket.close()
  })
})

describe('a team announcement its sender may not post', () => {
  it.each([
    ['a leader in a team they are on but do not lead', 'fay', 'kids'],
    ['a member who leads nothing', 'cy', 'worship'],
    ['an admin who leads nothing', 'ana', 'worship'],
    ['a leader in an open channel', 'fay', 'general'],
    ['a leader in the team leads channel', 'fay', 'team-leads'],
  ])(
    'is refused for %s, stored nowhere and pushed to no one',
    async (_label, personId, channelId) => {
      const { expo, churchId } = await churchWithDevices()

      const frame = await postFrame(churchId, personId, channelId, {
        type: 'send',
        body: 'Everyone, read this',
        teamAnnouncement: true,
      })

      expect(frame).toEqual({ type: 'error', reason: NOT_A_LEADER })
      expect((await readHistory(churchId, 'fay', channelId)).messages).toEqual([])
      // A later message's push in the same channel has left once the refused one would have.
      const marker = await postMessage(churchId, personId, channelId, 'Fay?', ['fay', 'cy'])
      await expo.pushesFor(marker.id, { after: marker.id })
      expect(expo.pushes().every((push) => push.data.messageId === marker.id)).toBe(true)
    },
  )

  it('marks only the channels a person leads in their channel list', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })

    const leads = async (personId: string) =>
      (await listChannels(churchId, personId)).channels
        .filter((channel) => channel.leads === true)
        .map((channel) => channel.id)

    expect(await leads('fay')).toEqual(['worship'])
    for (const personId of ['ana', 'cy', 'dee', 'eli']) {
      expect(await leads(personId), personId).toEqual([])
    }
    const fayChannels = (await listChannels(churchId, 'fay')).channels
    expect(fayChannels.find((channel) => channel.id === 'kids')).not.toHaveProperty('leads')
  })
})
