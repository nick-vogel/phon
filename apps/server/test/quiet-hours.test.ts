import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  asMember,
  postMessage,
  readQuietHours,
  registerDevice,
  seedChurch,
  setQuietHours,
} from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'
import {
  localHour,
  onTheHour,
  quietWindowAround,
  quietWindowAway,
  zoneAhead,
  zoneAtHour,
} from './support/time-zones.ts'

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
const staff = { channelId: 'staff', name: 'Staff', kind: 'private' as const, members: EVERYONE }
const CHANNELS = [announcements, general, staff]

/** A church with every device registered. */
async function churchWithDevices() {
  const expo = fakeExpoPush()
  const { churchId } = await seedChurch({ people: PEOPLE, channels: CHANNELS })
  for (const personId of EVERYONE) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return { expo, churchId }
}

/** Sets a person's quiet hours and fails unless the route answers 204. */
async function quietHours(
  churchId: string,
  personId: string,
  window: { start: string; end: string },
  timeZone: string,
) {
  const response = await setQuietHours(churchId, personId, {
    quietHours: { ...window, timeZone },
  })
  expect(response.status).toBe(204)
}

/**
 * Posts a message, then a marker that @mentions Ben (Ana when Ben is the author), and answers the
 * tokens the first message pushed to once the marker's push has arrived.
 */
async function pushedTo(
  churchId: string,
  expo: ReturnType<typeof fakeExpoPush>,
  channelId: string,
  body: string,
  mentions?: string[],
  author = 'ana',
): Promise<string[]> {
  const message = await postMessage(churchId, author, channelId, body, mentions)
  const markerFor = author === 'ben' ? 'ana' : 'ben'
  const marker = await postMessage(churchId, author, channelId, 'Marker', [markerFor])
  const pushes = await expo.pushesFor(message.id, { after: marker.id })
  return pushes.map((push) => push.to).sort()
}

describe('a message during quiet hours', () => {
  it('pushes to no one inside their quiet hours, whatever the channel, and to everyone else', async () => {
    const { expo, churchId } = await churchWithDevices()
    const zone = zoneAhead(0)
    await quietHours(churchId, 'cy', quietWindowAround(zone), zone)

    expect(await pushedTo(churchId, expo, 'staff', 'Budget draft is in')).toEqual([
      tokenOf('ben'),
      tokenOf('dee'),
    ])
    expect(
      await pushedTo(churchId, expo, 'announcements', 'Doors open at 8:30', undefined, 'ben'),
    ).toEqual([tokenOf('ana'), tokenOf('dee')])
    expect(await pushedTo(churchId, expo, 'general', 'Cy and Dee?', ['cy', 'dee'])).toEqual([
      tokenOf('dee'),
    ])
    expect(expo.pushesTo(tokenOf('cy'))).toEqual([])
  })

  it('pushes to them again once they turn quiet hours off', async () => {
    const { expo, churchId } = await churchWithDevices()
    const zone = zoneAhead(0)
    await quietHours(churchId, 'cy', quietWindowAround(zone), zone)
    expect(await pushedTo(churchId, expo, 'staff', 'Held')).not.toContain(tokenOf('cy'))

    expect((await setQuietHours(churchId, 'cy', { quietHours: null })).status).toBe(204)

    expect(await readQuietHours(churchId, 'cy')).toEqual({ quietHours: null })
    expect(await pushedTo(churchId, expo, 'staff', 'Through')).toEqual([
      tokenOf('ben'),
      tokenOf('cy'),
      tokenOf('dee'),
    ])
  })

  it('pushes as usual when their quiet hours do not hold now', async () => {
    const { expo, churchId } = await churchWithDevices()
    const zone = zoneAhead(0)
    await quietHours(churchId, 'cy', quietWindowAway(zone), zone)

    expect(await pushedTo(churchId, expo, 'staff', 'Through')).toEqual([
      tokenOf('ben'),
      tokenOf('cy'),
      tokenOf('dee'),
    ])
  })
})

describe("quiet hours in the member's own time zone", () => {
  it('hold the push for the member whose local time is inside the window, and no one else', async () => {
    const { expo, churchId } = await churchWithDevices()
    // Twelve hours apart: the same clock window holds now for Cy and not for Dee. A server that
    // read the window in UTC would push to Cy, and one that used one zone for both would hold Dee.
    const cyZone = zoneAhead(6)
    const window = quietWindowAround(cyZone)
    await quietHours(churchId, 'cy', window, cyZone)
    await quietHours(churchId, 'dee', window, zoneAhead(-6))

    expect(await pushedTo(churchId, expo, 'staff', 'Who is up?')).toEqual([
      tokenOf('ben'),
      tokenOf('dee'),
    ])
  })

  it('reads named IANA zones, daylight time included, through their own rules', async () => {
    const { expo, churchId } = await churchWithDevices()
    // New York and Tokyo are 13 or 14 hours apart, so a window around New York's hour holds now
    // there and not in Tokyo.
    const window = quietWindowAround('America/New_York')
    await quietHours(churchId, 'cy', window, 'America/New_York')
    await quietHours(churchId, 'dee', window, 'Asia/Tokyo')

    expect(await pushedTo(churchId, expo, 'staff', 'Who is up?')).toEqual([
      tokenOf('ben'),
      tokenOf('dee'),
    ])
  })

  it('hold a push inside a window that runs past midnight', async () => {
    const { expo, churchId } = await churchWithDevices()
    const zone = zoneAtHour(23)
    expect(localHour(zone)).toBe(23)
    await quietHours(churchId, 'cy', { start: '22:00', end: '02:00' }, zone)

    expect(await pushedTo(churchId, expo, 'staff', 'Late')).toEqual([
      tokenOf('ben'),
      tokenOf('dee'),
    ])
  })

  it('hold a push after midnight inside a window that runs past it', async () => {
    const { expo, churchId } = await churchWithDevices()
    // Hour 0, not 1, so a run that crosses the hour is still inside the window.
    const zone = zoneAtHour(0)
    expect(localHour(zone)).toBe(0)
    await quietHours(churchId, 'cy', { start: '22:00', end: '02:00' }, zone)

    expect(await pushedTo(churchId, expo, 'staff', 'Very late')).toEqual([
      tokenOf('ben'),
      tokenOf('dee'),
    ])
  })

  it('let a push through once the window has ended, its end not included', async () => {
    const { expo, churchId } = await churchWithDevices()
    const zone = zoneAhead(0)
    const hour = localHour(zone)
    await quietHours(churchId, 'cy', { start: onTheHour(hour - 2), end: onTheHour(hour) }, zone)

    expect(await pushedTo(churchId, expo, 'staff', 'Morning')).toContain(tokenOf('cy'))
  })

  it('let a push through just past the end of a window that runs past midnight', async () => {
    const { expo, churchId } = await churchWithDevices()
    const zone = zoneAtHour(3)
    await quietHours(churchId, 'cy', { start: '22:00', end: onTheHour(3) }, zone)

    expect(await pushedTo(churchId, expo, 'staff', 'Morning')).toContain(tokenOf('cy'))
  })
})

describe('the quiet hours route', () => {
  it('answers no quiet hours for someone who never set them', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    expect(await readQuietHours(churchId, 'cy')).toEqual({ quietHours: null })
  })

  it('answers back the quiet hours a person set', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })
    const quiet = { start: '22:00', end: '07:00', timeZone: 'America/Los_Angeles' }

    expect((await setQuietHours(churchId, 'cy', { quietHours: quiet })).status).toBe(204)

    expect(await readQuietHours(churchId, 'cy')).toEqual({ quietHours: quiet })
  })

  it.each([
    ['an hour past 23', { start: '25:00', end: '07:00', timeZone: 'Etc/GMT' }],
    ['an hour with one digit', { start: '7:00', end: '09:00', timeZone: 'Etc/GMT' }],
    ['a minute past 59', { start: '07:60', end: '09:00', timeZone: 'Etc/GMT' }],
    ['a start equal to its end', { start: '07:00', end: '07:00', timeZone: 'Etc/GMT' }],
    ['an unknown time zone', { start: '22:00', end: '07:00', timeZone: 'Mars/Olympus' }],
    ['a missing time zone', { start: '22:00', end: '07:00' }],
    ['a missing end', { start: '22:00', timeZone: 'Etc/GMT' }],
    ['a string', '22:00-07:00'],
  ])('refuses %s with 400 and keeps what was set', async (_label, quietHoursValue) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })
    const kept = { start: '22:00', end: '07:00', timeZone: 'Etc/GMT' }
    expect((await setQuietHours(churchId, 'cy', { quietHours: kept })).status).toBe(204)

    expect((await setQuietHours(churchId, 'cy', { quietHours: quietHoursValue })).status).toBe(400)

    expect(await readQuietHours(churchId, 'cy')).toEqual({ quietHours: kept })
  })

  it.each([
    ['a body without quietHours', {}],
    ['a body that is not an object', ['22:00', '07:00']],
  ])('refuses %s with 400', async (_label, body) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    expect((await setQuietHours(churchId, 'cy', body)).status).toBe(400)
  })

  it('answers 401 without a session', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    for (const method of ['GET', 'PUT']) {
      const response = await exports.default.fetch('https://phon.test/me/quiet-hours', { method })
      expect(response.status, method).toBe(401)
    }
    expect(await readQuietHours(churchId, 'cy')).toEqual({ quietHours: null })
  })

  it('answers 404 for a person the directory does not know', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    expect((await asMember(churchId, 'zed', '/me/quiet-hours')).status).toBe(404)
    const set = await setQuietHours(churchId, 'zed', {
      quietHours: { start: '22:00', end: '07:00', timeZone: 'Etc/GMT' },
    })
    expect(set.status).toBe(404)
  })

  it.each([['POST'], ['DELETE']])('answers 405 for %s', async (method) => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })

    expect((await asMember(churchId, 'cy', '/me/quiet-hours', { method })).status).toBe(405)
  })

  it('changes nothing for anyone else, nor for a person with the same ID in another church', async () => {
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [] })
    const other = await seedChurch({ people: PEOPLE, channels: [] })

    const quiet = { start: '22:00', end: '07:00', timeZone: 'Etc/GMT' }
    expect((await setQuietHours(churchId, 'cy', { quietHours: quiet })).status).toBe(204)

    expect(await readQuietHours(churchId, 'ben')).toEqual({ quietHours: null })
    expect(await readQuietHours(other.churchId, 'cy')).toEqual({ quietHours: null })
  })
})
