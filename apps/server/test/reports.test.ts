import { exports } from 'cloudflare:workers'
import type { Message } from '@phon/api-types'
import { describe, expect, it, vi } from 'vitest'
import { envWithRegistry, requestWith } from './support/bindings.ts'
import {
  asMember,
  closeReport,
  deleteMessage,
  openSocket,
  readOversightLog,
  readReports,
  registerDevice,
  removeMessage,
  reportMessage,
  seedChurch,
} from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const fay = { personId: 'fay', name: 'Fay Okafor', role: 'chat-admin' as const }
const gus = { personId: 'gus', name: 'Gus Lindqvist', role: 'chat-admin' as const }
const hal = { personId: 'hal', name: 'Hal Brook', role: 'admin' as const }

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ben', 'cy', 'dee', 'fay'],
}

const EVERYONE = [ana, ben, cy, dee, fay, gus, hal]

/** Seeds a church of everyone, with every person's device registered. */
async function churchWithDevices(channels: Parameters<typeof seedChurch>[0]['channels']) {
  const { churchId } = await seedChurch({ people: EVERYONE, channels })
  for (const { personId } of EVERYONE) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return churchId
}

/**
 * The report pushes among everything Expo received. A private channel's message alerts its members
 * on its own, so a test there reads only these.
 */
function reportPushes(expo: ReturnType<typeof fakeExpoPush>) {
  return expo.pushes().filter((push) => (push.data as { type?: string }).type === 'report')
}

/** Posts one message as a person on a fresh socket. */
async function postAs(
  churchId: string,
  personId: string,
  channelId: string,
  body: string,
): Promise<Message> {
  const socket = await openSocket(churchId, personId, channelId)
  try {
    socket.send({ type: 'send', body })
    const frame = await socket.nextFrame()
    if (frame.type !== 'message') throw new Error(`Expected a message frame, got ${frame.type}`)
    return frame.message
  } finally {
    socket.close()
  }
}

describe('reporting a message', () => {
  it('pushes every admin and chat admin of the church, and no one else', async () => {
    const churchId = await churchWithDevices([general])
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')
    const expo = fakeExpoPush()

    const response = await reportMessage(churchId, 'cy', 'general', message.id)

    expect(response.status).toBe(204)
    const [report] = (await readReports(churchId, 'ana')).reports
    const payload = (to: string) => ({
      to,
      title: 'Message reported',
      body: 'A message in #general was reported.',
      data: {
        type: 'report',
        reportId: report?.reportId,
        channelId: 'general',
        messageId: message.id,
      },
      sound: 'default',
      priority: 'high',
      interruptionLevel: 'active',
      channelId: 'messages',
      badge: 0,
    })
    expect(expo.pushes()).toEqual([
      payload(tokenOf('ana')),
      payload(tokenOf('fay')),
      payload(tokenOf('gus')),
      payload(tokenOf('hal')),
    ])
  })
  it("pushes no device the registry now lists for another church, though this church's row of it is left", async () => {
    const churchId = await churchWithDevices([general])
    const other = await seedChurch({ people: [ana], channels: [general] })
    expect((await registerDevice(other.churchId, 'ana', tokenOf('ana'))).status).toBe(204)
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')
    const expo = fakeExpoPush()

    expect((await reportMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)

    expect(expo.pushes().map((push) => push.to)).toEqual([
      tokenOf('fay'),
      tokenOf('gus'),
      tokenOf('hal'),
    ])
  })

  it("pushes no one, and logs it, when the registry cannot say which devices are the church's, and still files the report", async () => {
    const churchId = await churchWithDevices([general])
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')
    const expo = fakeExpoPush()
    const unreachable = envWithRegistry({
      ownedBy: async () => {
        throw new Error('Durable Object reset')
      },
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = await requestWith(
        unreachable,
        churchId,
        'cy',
        `/channels/general/messages/${message.id}/reports`,
        { method: 'POST' },
      )

      expect(response.status).toBe(204)
      expect(expo.pushes()).toEqual([])
      expect(logged).toHaveBeenCalled()
      expect((await readReports(churchId, 'ana')).reports).toHaveLength(1)
    } finally {
      logged.mockRestore()
    }
  })
})

describe('who a report alerts', () => {
  it('pushes an admin or chat admin who wrote the message, and never the reporter', async () => {
    const churchId = await churchWithDevices([general])
    const message = await postAs(churchId, 'fay', 'general', 'A chat admin can slip too')
    const expo = fakeExpoPush()

    expect((await reportMessage(churchId, 'ana', 'general', message.id)).status).toBe(204)

    expect(expo.pushes().map((push) => push.to)).toEqual([
      tokenOf('fay'),
      tokenOf('gus'),
      tokenOf('hal'),
    ])
  })

  it("never pushes another church's admins of the same person IDs", async () => {
    const churchId = await churchWithDevices([general])
    const other = await seedChurch({ people: EVERYONE, channels: [general] })
    for (const { personId } of EVERYONE) {
      const token = `ExponentPushToken[other-${personId}]`
      expect((await registerDevice(other.churchId, personId, token)).status).toBe(204)
    }
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')
    const expo = fakeExpoPush()

    expect((await reportMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)

    expect(expo.pushes().map((push) => push.to)).toEqual([
      tokenOf('ana'),
      tokenOf('fay'),
      tokenOf('gus'),
      tokenOf('hal'),
    ])
    expect((await readReports(other.churchId, 'ana')).reports).toEqual([])
  })

  it('files a repeat by the same reporter as nothing, and pushes no one again', async () => {
    const churchId = await churchWithDevices([general])
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')
    const expo = fakeExpoPush()
    expect((await reportMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)
    const first = expo.pushes()

    expect((await reportMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)

    expect(expo.pushes()).toEqual(first)
    expect((await readReports(churchId, 'ana')).reports).toHaveLength(1)
  })

  it('pushes every admin, and only the chat admins in a private channel', async () => {
    const churchId = await churchWithDevices([staff])
    const expo = fakeExpoPush()
    const message = await postAs(churchId, 'ben', 'staff', 'Staff only, and unkind')
    // Its own alert, to Cy, Dee and Fay, the members but the author.
    await expo.waitForPushes(3)

    expect((await reportMessage(churchId, 'cy', 'staff', message.id)).status).toBe(204)

    expect(reportPushes(expo).map((push) => push.to)).toEqual([
      tokenOf('ana'),
      tokenOf('fay'),
      tokenOf('hal'),
    ])
    expect(reportPushes(expo)[0]?.body).toBe('A message in #Staff was reported.')
    expect((await readReports(churchId, 'fay')).reports).toHaveLength(1)
    expect((await readReports(churchId, 'ana')).reports).toHaveLength(1)
    expect((await readReports(churchId, 'gus')).reports).toEqual([])
  })
})

describe('a report the server refuses', () => {
  it('answers 404 for an unknown, deleted or removed message, and pushes no one', async () => {
    const churchId = await churchWithDevices([general])
    const deleted = await postAs(churchId, 'ben', 'general', 'Deleted by Ben')
    const removed = await postAs(churchId, 'ben', 'general', 'Removed by Fay')
    expect((await deleteMessage(churchId, 'ben', 'general', deleted.id)).status).toBe(204)
    expect((await removeMessage(churchId, 'fay', 'general', removed.id)).status).toBe(204)
    const expo = fakeExpoPush()

    expect((await reportMessage(churchId, 'cy', 'general', 'no-such-message')).status).toBe(404)
    expect((await reportMessage(churchId, 'cy', 'general', deleted.id)).status).toBe(404)
    expect((await reportMessage(churchId, 'cy', 'general', removed.id)).status).toBe(404)

    expect(expo.pushes()).toEqual([])
    expect((await readReports(churchId, 'ana')).reports).toEqual([])
  })

  it('answers 404 to a person outside a private channel, and pushes no one', async () => {
    const churchId = await churchWithDevices([staff])
    const expo = fakeExpoPush()
    const message = await postAs(churchId, 'ben', 'staff', 'Staff only')
    await expo.waitForPushes(3)

    expect((await reportMessage(churchId, 'gus', 'staff', message.id)).status).toBe(404)

    expect(reportPushes(expo)).toEqual([])
    expect((await readReports(churchId, 'ana')).reports).toEqual([])
  })

  it("answers 404 for another church's message of the same IDs", async () => {
    const churchId = await churchWithDevices([general])
    const other = await seedChurch({ people: EVERYONE, channels: [general] })
    const message = await postAs(churchId, 'ben', 'general', 'Church A')
    const expo = fakeExpoPush()

    expect((await reportMessage(other.churchId, 'cy', 'general', message.id)).status).toBe(404)

    expect(expo.pushes()).toEqual([])
  })

  it('answers 401 without an identity, and 405 for a method other than POST', async () => {
    const churchId = await churchWithDevices([general])
    const message = await postAs(churchId, 'ben', 'general', 'Still here')
    const path = `/channels/general/messages/${message.id}/reports`

    expect(
      (await exports.default.fetch(`https://phon.test${path}`, { method: 'POST' })).status,
    ).toBe(401)
    expect((await asMember(churchId, 'cy', path, { method: 'GET' })).status).toBe(405)
    expect((await asMember(churchId, 'ana', '/reports', { method: 'POST' })).status).toBe(405)
  })
})

describe('the open reports list', () => {
  it('lists open reports newest first, with names and the message', async () => {
    const churchId = await churchWithDevices([general])
    const first = await postAs(churchId, 'ben', 'general', 'First unkind thing')
    const second = await postAs(churchId, 'dee', 'general', 'Second unkind thing')
    fakeExpoPush()
    expect((await reportMessage(churchId, 'cy', 'general', first.id)).status).toBe(204)
    expect((await reportMessage(churchId, 'ben', 'general', second.id)).status).toBe(204)

    const { reports } = await readReports(churchId, 'fay')

    expect(reports).toEqual([
      {
        reportId: expect.any(String),
        channelId: 'general',
        channelName: 'general',
        reporterId: 'ben',
        reporterName: 'Ben Okafor',
        reportedAt: expect.any(String),
        authorId: 'dee',
        authorName: 'Dee Mensah',
        message: second,
      },
      {
        reportId: expect.any(String),
        channelId: 'general',
        channelName: 'general',
        reporterId: 'cy',
        reporterName: 'Cy Park',
        reportedAt: expect.any(String),
        authorId: 'ben',
        authorName: 'Ben Okafor',
        message: first,
      },
    ])
    expect(await readReports(churchId, 'ana')).toEqual({ reports })
  })

  it('shows an admin a message removed since, marked, and a chat admin none', async () => {
    const churchId = await churchWithDevices([general])
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')
    fakeExpoPush()
    expect((await reportMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)

    expect((await removeMessage(churchId, 'fay', 'general', message.id)).status).toBe(204)

    expect((await readReports(churchId, 'ana')).reports).toMatchObject([
      { authorId: 'ben', message: { ...message, deleted: { by: 'fay' } } },
    ])
    expect((await readReports(churchId, 'fay')).reports).toMatchObject([
      { authorId: 'ben', message: null },
    ])
  })

  it('records an admin reading a report from a private channel they are not in', async () => {
    const churchId = await churchWithDevices([staff, general])
    const expo = fakeExpoPush()
    const staffOnly = await postAs(churchId, 'ben', 'staff', 'Staff only, and unkind')
    await expo.waitForPushes(3)
    const open = await postAs(churchId, 'ben', 'general', 'Open, and unkind')
    expect((await reportMessage(churchId, 'cy', 'staff', staffOnly.id)).status).toBe(204)
    expect((await reportMessage(churchId, 'cy', 'general', open.id)).status).toBe(204)
    expect((await readOversightLog(churchId, 'hal')).views).toEqual([])

    const before = new Date().toISOString()
    const { reports } = await readReports(churchId, 'ana')
    const after = new Date().toISOString()

    expect(reports.map((report) => report.message?.body)).toEqual([
      'Open, and unkind',
      'Staff only, and unkind',
    ])
    const { views } = await readOversightLog(churchId, 'hal')
    expect(views).toEqual([
      {
        viewId: expect.any(String),
        adminId: 'ana',
        adminName: 'Ana Ortiz',
        channelId: 'staff',
        channelName: 'Staff',
        openedAt: expect.any(String),
      },
    ])
    const openedAt = views[0]?.openedAt ?? ''
    expect(openedAt >= before && openedAt <= after).toBe(true)
  })

  it('records nothing for a chat admin in the private channel, or a list with none from it', async () => {
    const churchId = await churchWithDevices([staff, general])
    const expo = fakeExpoPush()
    const staffOnly = await postAs(churchId, 'ben', 'staff', 'Staff only, and unkind')
    await expo.waitForPushes(3)
    const open = await postAs(churchId, 'ben', 'general', 'Open, and unkind')
    expect((await reportMessage(churchId, 'cy', 'general', open.id)).status).toBe(204)

    expect((await readReports(churchId, 'ana')).reports).toHaveLength(1)

    expect((await reportMessage(churchId, 'cy', 'staff', staffOnly.id)).status).toBe(204)
    expect((await readReports(churchId, 'fay')).reports).toHaveLength(2)

    expect((await readOversightLog(churchId, 'hal')).views).toEqual([])
  })

  it('answers 403 to a member', async () => {
    const churchId = await churchWithDevices([general])

    expect((await asMember(churchId, 'cy', '/reports')).status).toBe(403)
  })
})

describe('closing a report', () => {
  it('takes it off the list for every moderator', async () => {
    const churchId = await churchWithDevices([general])
    const first = await postAs(churchId, 'ben', 'general', 'First unkind thing')
    const second = await postAs(churchId, 'dee', 'general', 'Second unkind thing')
    fakeExpoPush()
    expect((await reportMessage(churchId, 'cy', 'general', first.id)).status).toBe(204)
    expect((await reportMessage(churchId, 'cy', 'general', second.id)).status).toBe(204)
    const [newest, oldest] = (await readReports(churchId, 'ana')).reports

    expect((await closeReport(churchId, 'fay', newest?.reportId ?? '')).status).toBe(204)

    expect(await readReports(churchId, 'ana')).toEqual({ reports: [oldest] })
    expect(await readReports(churchId, 'gus')).toEqual({ reports: [oldest] })
    expect((await closeReport(churchId, 'ana', newest?.reportId ?? '')).status).toBe(404)
  })

  it('lets the reporter report the message again once their report is closed', async () => {
    const churchId = await churchWithDevices([general])
    const message = await postAs(churchId, 'ben', 'general', 'Something unkind')
    const expo = fakeExpoPush()
    expect((await reportMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)
    const [report] = (await readReports(churchId, 'ana')).reports
    expect((await closeReport(churchId, 'ana', report?.reportId ?? '')).status).toBe(204)

    expect((await reportMessage(churchId, 'cy', 'general', message.id)).status).toBe(204)

    expect(expo.pushes()).toHaveLength(8)
    expect((await readReports(churchId, 'ana')).reports).toHaveLength(1)
  })

  it('answers 403 to a member, 404 for an unknown report or one a chat admin cannot see', async () => {
    const churchId = await churchWithDevices([staff])
    const expo = fakeExpoPush()
    const message = await postAs(churchId, 'ben', 'staff', 'Staff only')
    await expo.waitForPushes(3)
    expect((await reportMessage(churchId, 'cy', 'staff', message.id)).status).toBe(204)
    const [report] = (await readReports(churchId, 'ana')).reports
    const reportId = report?.reportId ?? ''

    expect((await closeReport(churchId, 'cy', reportId)).status).toBe(403)
    expect((await closeReport(churchId, 'gus', reportId)).status).toBe(404)
    expect((await closeReport(churchId, 'ana', 'no-such-report')).status).toBe(404)
    expect((await asMember(churchId, 'ana', `/reports/${reportId}/close`)).status).toBe(405)

    expect((await readReports(churchId, 'ana')).reports).toEqual([report])
  })
})
