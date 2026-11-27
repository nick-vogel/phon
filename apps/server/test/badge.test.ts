import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type Channel, channelObjectName } from '../src/channel.ts'
import type { ChurchDirectory } from '../src/church-directory.ts'
import type { ExpoPushMessage } from '../src/expo-push.ts'
import {
  asMember,
  deleteMessage,
  enterBirthdate,
  listChannels,
  markRead,
  postFrame,
  postMessage,
  registerDevice,
  removeMessage,
  reportMessage,
  seedChurch,
  setAlertLevel,
} from './support/church.ts'
import { EXPO_PUSH_ENDPOINT, fakeExpoPush, tokenOf } from './support/expo-push.ts'
import { network } from './support/network.ts'
import { ADULT_BIRTHDATE } from './support/people.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ana', 'ben', 'cy', 'dee'],
}

/** A church of Ana, Ben, Cy and Dee, in `general` and `staff`, with every device registered. */
async function church() {
  const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [general, staff] })
  for (const personId of ['ana', 'ben', 'cy', 'dee']) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return churchId
}

/** The badge on one person's push for a message, once the push has arrived. */
async function badgeFor(
  expo: { pushesTo(token: string): ExpoPushMessage[] },
  personId: string,
  messageId: string,
): Promise<number | undefined> {
  const deadline = Date.now() + 2000
  for (;;) {
    const push = expo
      .pushesTo(tokenOf(personId))
      .find((candidate) => candidate.data.messageId === messageId)
    if (push !== undefined) return push.badge
    if (Date.now() >= deadline) throw new Error(`No push to ${personId} for ${messageId}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('a mention', () => {
  it("adds one to the mentioned member's badge, and every other recipient carries their own total", async () => {
    const expo = fakeExpoPush()
    const churchId = await church()

    const first = await postMessage(churchId, 'ana', 'staff', 'Cy, the budget?', ['cy'])
    expect(await badgeFor(expo, 'cy', first.id)).toBe(1)
    expect(await badgeFor(expo, 'ben', first.id)).toBe(0)

    const second = await postMessage(churchId, 'ana', 'general', 'Cy, the keys?', ['cy'])
    expect(await badgeFor(expo, 'cy', second.id)).toBe(2)
  })

  it('adds one even when no push goes, as with alerts off', async () => {
    const expo = fakeExpoPush()
    const churchId = await church()
    expect((await setAlertLevel(churchId, 'cy', 'general', 'off')).status).toBe(204)

    const silent = await postMessage(churchId, 'ana', 'general', 'Cy, the keys?', ['cy'])
    const next = await postMessage(churchId, 'ana', 'staff', 'Cy, the budget?', ['cy'])

    expect(await badgeFor(expo, 'cy', next.id)).toBe(2)
    expect(expo.pushesTo(tokenOf('cy')).map((push) => push.data.messageId)).not.toContain(silent.id)
  })
})

describe('a read marker', () => {
  it('takes away the mentions it passes, and one that moves back takes nothing', async () => {
    const expo = fakeExpoPush()
    const churchId = await church()
    const first = await postMessage(churchId, 'ana', 'staff', 'Cy, one', ['cy'])
    const second = await postMessage(churchId, 'ana', 'staff', 'Cy, two', ['cy'])
    expect(await badgeFor(expo, 'cy', second.id)).toBe(2)

    expect((await markRead(churchId, 'cy', 'staff', first.id)).status).toBe(204)
    const third = await postMessage(churchId, 'ana', 'staff', 'Cy, three', ['cy'])
    expect(await badgeFor(expo, 'cy', third.id)).toBe(2)

    expect((await markRead(churchId, 'cy', 'staff', third.id)).status).toBe(204)
    const fourth = await postMessage(churchId, 'ana', 'staff', 'Cy, four', ['cy'])
    expect(await badgeFor(expo, 'cy', fourth.id)).toBe(1)

    expect((await markRead(churchId, 'cy', 'staff', first.id)).status).toBe(204)
    const fifth = await postMessage(churchId, 'ana', 'staff', 'Cy, five', ['cy'])
    expect(await badgeFor(expo, 'cy', fifth.id)).toBe(2)
  })
})

describe('a deleted message', () => {
  it('takes its mention away, whether its author deletes it or a moderator removes it, and one already read takes nothing', async () => {
    const expo = fakeExpoPush()
    const churchId = await church()
    const first = await postMessage(churchId, 'ana', 'staff', 'Cy, one', ['cy'])
    const second = await postMessage(churchId, 'ana', 'staff', 'Cy, two', ['cy'])
    expect(await badgeFor(expo, 'cy', second.id)).toBe(2)

    expect((await deleteMessage(churchId, 'ana', 'staff', first.id)).status).toBe(204)
    const third = await postMessage(churchId, 'ana', 'staff', 'Cy, three', ['cy'])
    expect(await badgeFor(expo, 'cy', third.id)).toBe(2)

    expect((await removeMessage(churchId, 'ana', 'staff', second.id)).status).toBe(204)
    const fourth = await postMessage(churchId, 'ana', 'staff', 'Cy, four', ['cy'])
    expect(await badgeFor(expo, 'cy', fourth.id)).toBe(2)

    expect((await markRead(churchId, 'cy', 'staff', fourth.id)).status).toBe(204)
    expect((await deleteMessage(churchId, 'ana', 'staff', third.id)).status).toBe(204)
    const fifth = await postMessage(churchId, 'ana', 'staff', 'Cy, five', ['cy'])
    expect(await badgeFor(expo, 'cy', fifth.id)).toBe(1)
  })
})

describe('a message deleted while its alert waits in the queue', () => {
  it('takes away no mention, since its alert never counted one', async () => {
    const expo = heldExpoPush()
    const churchId = await church()
    const earlier = await postMessage(churchId, 'ana', 'general', 'Cy, the keys?', ['cy'])
    expect(await badgeFor(expo, 'cy', earlier.id)).toBe(1)

    // The first message's pushes wait at Expo, so the next message's alert waits behind them.
    expo.hold()
    await postMessage(churchId, 'ana', 'staff', 'First')
    await expo.waitUntilHeld()
    const mistake = await postMessage(churchId, 'ana', 'staff', 'Cy, sent by mistake', ['cy'])
    expect((await deleteMessage(churchId, 'ana', 'staff', mistake.id)).status).toBe(204)
    expo.release()

    const next = await postMessage(churchId, 'ana', 'general', 'Cy, the van?', ['cy'])
    expect(await badgeFor(expo, 'cy', next.id)).toBe(2)
  })
})

describe('a mention whose alert waits in the queue', () => {
  it("is taken away once by the mentioned member's removal from the channel", async () => {
    const expo = heldExpoPush()
    const churchId = await church()
    const earlier = await postMessage(churchId, 'ana', 'general', 'Cy, the keys?', ['cy'])
    expect(await badgeFor(expo, 'cy', earlier.id)).toBe(1)

    expo.hold()
    await postMessage(churchId, 'ana', 'staff', 'First')
    await expo.waitUntilHeld()
    await postMessage(churchId, 'ana', 'staff', 'Cy, the budget?', ['cy'])
    const response = await asMember(churchId, 'ana', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'ben', 'dee'] }),
    })
    expect(response.status).toBe(204)
    expo.release()

    const next = await postMessage(churchId, 'ana', 'general', 'Cy, the van?', ['cy'])
    expect(await badgeFor(expo, 'cy', next.id)).toBe(2)
  })

  it('is counted once when a channel list load comes before its alert', async () => {
    const expo = heldExpoPush()
    const churchId = await church()
    const earlier = await postMessage(churchId, 'ana', 'general', 'Cy, the keys?', ['cy'])
    expect(await badgeFor(expo, 'cy', earlier.id)).toBe(1)

    expo.hold()
    await postMessage(churchId, 'ana', 'staff', 'First')
    await expo.waitUntilHeld()
    const queued = await postMessage(churchId, 'ana', 'staff', 'Cy, the budget?', ['cy'])
    await listChannels(churchId, 'cy')
    expo.release()

    expect(await badgeFor(expo, 'cy', queued.id)).toBe(2)
    const next = await postMessage(churchId, 'ana', 'general', 'Cy, the van?', ['cy'])
    expect(await badgeFor(expo, 'cy', next.id)).toBe(3)
  })
})

describe("a member's removal from a channel", () => {
  it('takes away their unread mentions there', async () => {
    const expo = fakeExpoPush()
    const churchId = await church()
    await postMessage(churchId, 'ana', 'staff', 'Cy, the budget?', ['cy'])
    const kept = await postMessage(churchId, 'ana', 'general', 'Cy, the keys?', ['cy'])
    expect(await badgeFor(expo, 'cy', kept.id)).toBe(2)

    const response = await asMember(churchId, 'ana', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'ben', 'dee'] }),
    })
    expect(response.status).toBe(204)

    const next = await postMessage(churchId, 'ana', 'general', 'Cy, the van?', ['cy'])
    expect(await badgeFor(expo, 'cy', next.id)).toBe(2)
  })
})

describe('a channel list load', () => {
  it('sets the total to the sum of the mentions it lists, and with no drift changes nothing', async () => {
    const expo = fakeExpoPush()
    const churchId = await church()
    const first = await postMessage(churchId, 'ana', 'staff', 'Cy, the budget?', ['cy'])
    expect(await badgeFor(expo, 'cy', first.id)).toBe(1)
    // A total out of step with the channels, as a missed update would leave it. No route does this.
    await runInDurableObject(
      env.CHURCH_DIRECTORY.getByName(churchId),
      (directory: ChurchDirectory) => {
        ;(directory as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
          "UPDATE mention_totals SET total = 7 WHERE church_id = ? AND person_id = 'cy'",
          churchId,
        )
      },
    )

    const listed = await listChannels(churchId, 'cy')
    expect(listed.channels.map((channel) => [channel.id, channel.mentions])).toEqual([
      ['staff', 1],
      ['general', 0],
    ])
    const second = await postMessage(churchId, 'ana', 'general', 'Cy, the keys?', ['cy'])
    expect(await badgeFor(expo, 'cy', second.id)).toBe(2)

    await listChannels(churchId, 'cy')
    const third = await postMessage(churchId, 'ana', 'general', 'Cy, the van?', ['cy'])
    expect(await badgeFor(expo, 'cy', third.id)).toBe(3)
  })
})

describe('every push', () => {
  it("carries its recipient's total: a message, a team announcement, an urgent message, a birthdate request and a report", async () => {
    const expo = fakeExpoPush()
    const fay = { personId: 'fay', name: 'Fay Okafor' }
    const gil = { personId: 'gil', name: 'Gil Sato', birthdate: null }
    const worship = {
      channelId: 'worship',
      name: 'Worship',
      kind: 'team' as const,
      members: ['ben', 'cy', 'dee', 'fay'],
      leaders: ['fay'],
    }
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee, fay, gil],
      channels: [general, staff, worship],
    })
    for (const personId of ['ana', 'ben', 'cy', 'dee', 'fay', 'gil']) {
      expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
    }

    const mention = await postMessage(churchId, 'ben', 'staff', 'Ana, Cy: the budget?', [
      'ana',
      'cy',
    ])
    expect(await badgeFor(expo, 'cy', mention.id)).toBe(1)
    expect(await badgeFor(expo, 'ana', mention.id)).toBe(1)
    expect(await badgeFor(expo, 'dee', mention.id)).toBe(0)

    const announcement = await postFrame(churchId, 'fay', 'worship', {
      type: 'send',
      body: 'Rehearsal moves to 6:30',
      teamAnnouncement: true,
    })
    if (announcement.type !== 'message') throw new Error(JSON.stringify(announcement))
    expect(await badgeFor(expo, 'cy', announcement.message.id)).toBe(1)
    expect(await badgeFor(expo, 'dee', announcement.message.id)).toBe(0)

    const urgent = await postFrame(churchId, 'ana', 'general', {
      type: 'send',
      body: 'Parking lot flooded',
      urgent: true,
    })
    if (urgent.type !== 'message') throw new Error(JSON.stringify(urgent))
    expect(await badgeFor(expo, 'cy', urgent.message.id)).toBe(1)
    expect(await badgeFor(expo, 'dee', urgent.message.id)).toBe(0)

    expect((await enterBirthdate(churchId, 'gil', ADULT_BIRTHDATE)).status).toBe(200)
    expect(
      expo
        .pushesTo(tokenOf('ana'))
        .filter((push) => (push.data as { birthdateRequestFor?: string }).birthdateRequestFor)
        .map((push) => push.badge),
    ).toEqual([1])

    expect((await reportMessage(churchId, 'cy', 'staff', mention.id)).status).toBe(204)
    expect(
      expo
        .pushesTo(tokenOf('ana'))
        .filter((push) => (push.data as { type?: string }).type === 'report')
        .map((push) => push.badge),
    ).toEqual([1])
  })
})

describe('the badge', () => {
  it('comes back with the alert targets, with no other call to the directory per push', async () => {
    const expo = fakeExpoPush()
    const churchId = await church()
    const holder = { churchId, channelId: 'general', personId: 'ana' }
    // The church directory as the channel sees it: only the post check and the alert targets.
    // Any other call fails, and the push never leaves.
    const onlyAlertTargets = {
      postAccess: async () => ({
        access: 'granted',
        mentions: [],
        teamAnnouncement: false,
        urgent: false,
      }),
      alertTargets: async () => ({
        channelName: 'general',
        authorName: 'Ana Ortiz',
        pushes: [{ token: tokenOf('cy'), badge: 3, interruptionLevel: 'active' }],
      }),
    }
    const channelEnv = { ...env, CHURCH_DIRECTORY: { getByName: () => onlyAlertTargets } }
    const socket = { deserializeAttachment: () => holder, send: () => {} } as unknown as WebSocket

    await runInDurableObject(
      env.CHANNEL.getByName(channelObjectName(churchId, 'general')),
      async (channel: Channel) => {
        Object.defineProperty(channel, 'env', { value: channelEnv })
        await channel.webSocketMessage(socket, JSON.stringify({ type: 'send', body: 'Doors at 9' }))
        await (channel as unknown as { alerting: Promise<void> }).alerting
      },
    )

    expect(expo.pushesTo(tokenOf('cy')).map((push) => push.badge)).toEqual([3])
  })
})

/**
 * A fake Expo push service that, once `hold()` is called, holds every batch until `release()`, so
 * the alerts of the next messages wait in the channel's queue behind the held one.
 */
function heldExpoPush() {
  const received: ExpoPushMessage[] = []
  let held = false
  let waiting = 0
  network.stub('POST', EXPO_PUSH_ENDPOINT, async (request) => {
    const batch = (await request.json()) as ExpoPushMessage[]
    waiting += 1
    while (held) await new Promise((resolve) => setTimeout(resolve, 5))
    waiting -= 1
    received.push(...batch)
    return Response.json({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
  })
  return {
    hold() {
      held = true
    },
    release() {
      held = false
    },
    /** Resolves once a batch is held at Expo. */
    async waitUntilHeld(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (waiting === 0) {
        if (Date.now() >= deadline) throw new Error(`No batch held within ${timeoutMs}ms`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    pushesTo(token: string): ExpoPushMessage[] {
      return received.filter((push) => push.to === token)
    },
  }
}

describe('losing oversight after leaving a channel', () => {
  it('leaves a lost membership queued when an oversight-only eviction of the same channel clears', async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [general] })
    const queued = await runInDurableObject(
      env.CHURCH_DIRECTORY.getByName(churchId),
      (directory: ChurchDirectory) => {
        const sql = (directory as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        sql.exec(
          `CREATE TABLE IF NOT EXISTS pending_oversight_evictions (
             church_id TEXT NOT NULL, channel_id TEXT NOT NULL, person_id TEXT NOT NULL,
             PRIMARY KEY (church_id, channel_id, person_id))`,
        )
        sql.exec("INSERT INTO pending_oversight_evictions VALUES (?, 'staff', 'ana')", churchId)
        sql.exec("INSERT INTO pending_evictions VALUES (?, 'staff', 'ana')", churchId)
        directory.evicted(churchId, { personId: 'ana', channelId: 'staff', takeMentions: false })
        return {
          member: sql.exec('SELECT COUNT(*) AS n FROM pending_evictions').one().n,
          oversight: sql.exec('SELECT COUNT(*) AS n FROM pending_oversight_evictions').one().n,
        }
      },
    )
    expect(queued).toEqual({ member: 1, oversight: 0 })
  })

  it('keeps unread mentions in other channels when a demoted admin loses oversight of a channel they already left', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({
      people: [
        { personId: 'ana', name: 'Ana Ortiz', role: 'admin' },
        { personId: 'boss', name: 'Boss Admin', role: 'admin' },
        { personId: 'ben', name: 'Ben Okafor' },
        { personId: 'cy', name: 'Cy Park' },
        { personId: 'dee', name: 'Dee Mensah' },
      ],
      channels: [
        { channelId: 'general', name: 'general', kind: 'open' },
        {
          channelId: 'staff',
          name: 'Staff',
          kind: 'private',
          members: ['ana', 'ben', 'cy', 'dee'],
        },
      ],
    })
    for (const personId of ['ana', 'boss', 'ben', 'cy', 'dee']) {
      expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
    }
    expect((await setAlertLevel(churchId, 'ana', 'general', 'every-message')).status).toBe(204)

    await postMessage(churchId, 'ben', 'general', 'Ana, general ping', ['ana'])
    const staffMention = await postMessage(churchId, 'ben', 'staff', 'Ana, staff ping', ['ana'])
    expect(await badgeFor(expo, 'ana', staffMention.id)).toBe(2)

    const removed = await asMember(churchId, 'boss', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ben', 'cy', 'dee'] }),
    })
    expect(removed.status).toBe(204)

    const afterRemoval = await postMessage(churchId, 'ben', 'general', 'Hello everyone 1')
    expect(await badgeFor(expo, 'ana', afterRemoval.id)).toBe(1)

    const demoted = await asMember(churchId, 'boss', '/people/ana/role', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    })
    expect(demoted.status).toBe(204)

    const afterDemotion = await postMessage(churchId, 'ben', 'general', 'Hello everyone 2')
    expect(await badgeFor(expo, 'ana', afterDemotion.id)).toBe(1)
  })
})
