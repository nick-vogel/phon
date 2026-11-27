import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type Channel, channelObjectName } from '../src/channel.ts'
import type { ExpoPushMessage } from '../src/expo-push.ts'
import { envWithFailingClaim, envWithHeldClaim, registerDeviceWith } from './support/bindings.ts'
import {
  asMember,
  deleteMessage,
  imageBytes,
  postImage,
  postMessage,
  registerDevice,
  removeMessage,
  seedChurch,
} from './support/church.ts'
import { EXPO_PUSH_ENDPOINT, fakeExpoPush, tokenOf } from './support/expo-push.ts'
import { network } from './support/network.ts'
import { ADULT_BIRTHDATE } from './support/people.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const gus = { personId: 'gus', name: 'Gus Lindqvist', role: 'admin' as const }

const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ana', 'ben', 'cy'],
}
const general = { channelId: 'general', name: 'general', kind: 'open' as const }

/** Registers each person's device, `tokenOf(personId)`, and fails unless each answers 204. */
async function registerAll(churchId: string, personIds: string[]) {
  for (const personId of personIds) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
}

/**
 * Resolves once a channel has sent the pushes of every message posted so far. A sync point that
 * needs no later push, for a church that lists no device and so pushes to no one.
 */
async function alertsSent(churchId: string, channelId: string) {
  await runInDurableObject(
    env.CHANNEL.getByName(channelObjectName(churchId, channelId)),
    (channel: Channel) => (channel as unknown as { alerting: Promise<void> }).alerting,
  )
}

describe('a registered device', () => {
  it("gets a push for a private channel's message, sent to Expo with the whole payload", async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    await registerAll(churchId, ['ana', 'ben', 'cy'])

    const message = await postMessage(churchId, 'ana', 'staff', 'Budget draft is in the drive')
    await expo.waitForPushes(2)

    const calls = network.calls().filter((call) => call.url === EXPO_PUSH_ENDPOINT)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    })
    const payload = (to: string) => ({
      to,
      title: '#Staff',
      body: 'Ana Ortiz: Budget draft is in the drive',
      data: { channelId: 'staff', messageId: message.id },
      sound: 'default',
      priority: 'high',
      interruptionLevel: 'active',
      channelId: 'messages',
      badge: 0,
    })
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual([
      payload(tokenOf('ben')),
      payload(tokenOf('cy')),
    ])
    expect(expo.pushesTo(tokenOf('ana'))).toEqual([])
  })

  it('gets a long message cut to 180 characters with an ellipsis', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    await registerAll(churchId, ['ben'])

    await postMessage(churchId, 'ana', 'staff', 'x'.repeat(181))
    const [push] = await expo.waitForPushes(1)

    expect(push?.body).toBe(`Ana Ortiz: ${'x'.repeat(180)}…`)
  })

  it('gets an image with its caption, and one with none named as an image', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    await registerAll(churchId, ['ben'])
    const bytes = imageBytes('image/png')

    expect((await postImage(churchId, 'ana', 'staff', { bytes, type: 'image/png' })).status).toBe(
      201,
    )
    expect(
      (
        await postImage(churchId, 'ana', 'staff', {
          bytes,
          type: 'image/png',
          caption: 'Floor plan',
        })
      ).status,
    ).toBe(201)
    const pushes = await expo.waitForPushes(2)

    expect(pushes.map((push) => push.body)).toEqual([
      'Ana Ortiz posted an image',
      'Ana Ortiz: Floor plan',
    ])
  })

  it('gets every one of more than 100 pushes, in requests of at most 100', async () => {
    const expo = fakeExpoPush()
    const crowd = Array.from({ length: 101 }, (_, i) => ({
      personId: `p${String(i).padStart(3, '0')}`,
      name: `Person ${i}`,
    }))
    const everyone = { channelId: 'everyone', name: 'everyone', kind: 'private' as const }
    const { churchId } = await seedChurch({
      people: [ana, ...crowd],
      channels: [{ ...everyone, members: ['ana', ...crowd.map((p) => p.personId)] }],
    })
    await registerAll(
      churchId,
      crowd.map((p) => p.personId),
    )

    await postMessage(churchId, 'ana', 'everyone', 'Picnic Sunday')
    await expo.waitForPushes(101)

    const sizes = network
      .calls()
      .filter((call) => call.url === EXPO_PUSH_ENDPOINT)
      .map((call) => (JSON.parse(call.body ?? '[]') as unknown[]).length)
    expect(sizes).toEqual([100, 1])
  })

  it('belongs to the last person who registered it', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const shared = 'ExpoPushToken[shared-phone]'
    expect((await registerDevice(churchId, 'cy', shared)).status).toBe(204)
    expect((await registerDevice(churchId, 'ben', shared)).status).toBe(204)

    await postMessage(churchId, 'ben', 'staff', 'From Ben')
    await postMessage(churchId, 'cy', 'staff', 'From Cy')
    const pushes = await expo.waitForPushes(1)

    // Ana's device is not registered, so the only pushes go to the shared phone, now Ben's: none
    // for Ben's own message, one for Cy's, and the ordered later push proves the first sent none.
    expect(pushes.map((push) => [push.to, push.body])).toEqual([[shared, 'Cy Park: From Cy']])
  })

  it("never gets another church's messages", async () => {
    const expo = fakeExpoPush()
    const a = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const b = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    expect((await registerDevice(a.churchId, 'cy', tokenOf('cy'))).status).toBe(204)
    expect((await registerDevice(b.churchId, 'ben', tokenOf('ben'))).status).toBe(204)

    await postMessage(b.churchId, 'ana', 'staff', 'Church B only')
    await postMessage(a.churchId, 'ana', 'staff', 'Church A only')
    const pushes = await expo.waitForPushes(2)

    expect(pushes.map((push) => [push.to, push.body])).toEqual([
      [tokenOf('ben'), 'Ana Ortiz: Church B only'],
      [tokenOf('cy'), 'Ana Ortiz: Church A only'],
    ])
  })

  it("stops getting church A's pushes once someone of church B registers it, and gets church B's", async () => {
    const expo = fakeExpoPush()
    const a = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const b = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)
    expect((await registerDevice(a.churchId, 'ben', tokenOf('ben-a'))).status).toBe(204)

    expect((await registerDevice(b.churchId, 'cy', shared)).status).toBe(204)
    const secret = await postMessage(a.churchId, 'ana', 'staff', 'Church A staff only')
    const marker = await postMessage(a.churchId, 'ana', 'staff', 'Marker')
    const inB = await postMessage(b.churchId, 'ana', 'staff', 'Church B staff only')

    expect(await expo.pushesFor(secret.id, { after: marker.id })).toEqual([
      expect.objectContaining({ to: tokenOf('ben-a') }),
    ])
    const pushesInB = await expo.waitForPushes(3)
    expect(
      pushesInB.filter((push) => push.data.messageId === inB.id).map((push) => push.to),
    ).toEqual([shared])
  })

  it("stops church A's pushes at once when the phone moves to church B, and church A keeps its row", async () => {
    const expo = fakeExpoPush()
    const a = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const b = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)
    expect((await registerDevice(a.churchId, 'ben', tokenOf('ben-a'))).status).toBe(204)
    expect((await registerDevice(b.churchId, 'ben', tokenOf('ben-b'))).status).toBe(204)

    expect((await registerDevice(b.churchId, 'cy', shared)).status).toBe(204)

    const rows = await runInDurableObject(
      env.CHURCH_DIRECTORY.getByName(a.churchId),
      (_directory, state) =>
        state.storage.sql
          .exec('SELECT token FROM devices WHERE church_id = ? AND token = ?', a.churchId, shared)
          .toArray().length,
    )
    expect(rows).toBe(1)
    const inA = await postMessage(a.churchId, 'ana', 'staff', 'Church A staff only')
    const markerA = await postMessage(a.churchId, 'ana', 'staff', 'Marker A')
    expect((await expo.pushesFor(inA.id, { after: markerA.id })).map((push) => push.to)).toEqual([
      tokenOf('ben-a'),
    ])
    const inB = await postMessage(b.churchId, 'ana', 'staff', 'Church B staff only')
    const markerB = await postMessage(b.churchId, 'ana', 'staff', 'Marker B')
    expect(
      (await expo.pushesFor(inB.id, { after: markerB.id })).map((push) => push.to).sort(),
    ).toEqual([tokenOf('ben-b'), shared].sort())
  })

  it('ends up in one church only when two churches register it at once', async () => {
    const expo = fakeExpoPush()
    const a = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const b = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const c = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)
    for (const [church, token] of [
      [a, 'ben-a'],
      [b, 'ben-b'],
      [c, 'ben-c'],
    ] as const) {
      expect((await registerDevice(church.churchId, 'ben', tokenOf(token))).status).toBe(204)
    }

    // Church B's claim waits while church C's registration runs, so B's claim lands last and wins.
    const held = envWithHeldClaim()
    const inB = registerDeviceWith(held.bindings, b.churchId, 'cy', shared)
    await held.reached
    expect((await registerDevice(c.churchId, 'cy', shared)).status).toBe(204)
    held.open()
    expect((await inB).status).toBe(204)

    const pushedTo = async (churchId: string) => {
      const message = await postMessage(churchId, 'ana', 'staff', 'Staff only')
      const marker = await postMessage(churchId, 'ana', 'staff', 'Marker')
      return (await expo.pushesFor(message.id, { after: marker.id })).map((p) => p.to).sort()
    }
    expect(await pushedTo(a.churchId)).toEqual([tokenOf('ben-a')])
    expect(await pushedTo(b.churchId)).toEqual([tokenOf('ben-b'), shared].sort())
    expect(await pushedTo(c.churchId)).toEqual([tokenOf('ben-c')])
  })
})

describe('registering a device', () => {
  it('refuses a request with no session', async () => {
    const response = await exports.default.fetch('https://phon.test/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenOf('cy') }),
    })

    expect(response.status).toBe(401)
  })

  it.each([
    ['no body', undefined],
    ['a body that is not JSON', 'not json'],
    ['no token', JSON.stringify({})],
    ['a token that is not a string', JSON.stringify({ token: 42 })],
    ['a token Expo did not issue', JSON.stringify({ token: 'apns-device-token' })],
    ['an empty Expo token', JSON.stringify({ token: 'ExponentPushToken[]' })],
  ])('refuses %s with 400', async (_label, body) => {
    const { churchId } = await seedChurch({ people: [cy], channels: [] })

    const response = await asMember(churchId, 'cy', '/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })

    expect(response.status).toBe(400)
  })

  it("answers 404 for a person the church's directory does not know", async () => {
    const { churchId } = await seedChurch({ people: [cy], channels: [] })

    expect((await registerDevice(churchId, 'stranger', tokenOf('stranger'))).status).toBe(404)
  })

  it('leaves the token with its church when the church registering it does not know the caller', async () => {
    const expo = fakeExpoPush()
    const a = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const b = await seedChurch({ people: [ana, ben], channels: [] })
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)
    expect((await registerDevice(a.churchId, 'ben', tokenOf('ben-a'))).status).toBe(204)

    expect((await registerDevice(b.churchId, 'cy', shared)).status).toBe(404)

    const stillA = await postMessage(a.churchId, 'ana', 'staff', 'Still church A')
    const marker = await postMessage(a.churchId, 'ana', 'staff', 'Marker')
    expect(
      (await expo.pushesFor(stillA.id, { after: marker.id })).map((push) => push.to).sort(),
    ).toEqual([tokenOf('ben-a'), shared].sort())
  })

  it('still registers a token that a refused registration of a church with no directory named first', async () => {
    const { churchId } = await seedChurch({ people: [cy], channels: [] })
    const nowhere = `church-${crypto.randomUUID()}`

    expect((await registerDevice(nowhere, 'stranger', tokenOf('stray'))).status).toBe(404)
    expect((await registerDevice(churchId, 'cy', tokenOf('stray'))).status).toBe(204)
  })

  it.each([['GET'], ['PUT'], ['DELETE']])('answers 405 for %s', async (method) => {
    const { churchId } = await seedChurch({ people: [cy], channels: [] })

    expect((await asMember(churchId, 'cy', '/devices', { method })).status).toBe(405)
  })
})

describe('who stops getting pushes', () => {
  it('a person who left the church, on no team any more', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [general] })
    await registerAll(churchId, ['ben', 'cy'])

    await env.CHURCH_DIRECTORY.getByName(churchId).applyRoster(churchId, {
      people: [ana, ben].map(({ personId, name }) => ({
        personId,
        name,
        serves: true,
        birthdate: ADULT_BIRTHDATE,
        avatar: null,
      })),
      dropped: [],
      groupTypes: null,
      channels: [],
      memberships: [],
      leaders: [],
    })
    await postMessage(churchId, 'ana', 'general', 'Cy?', ['cy'])
    await postMessage(churchId, 'ana', 'general', 'Ben?', ['ben'])
    const pushes = await expo.waitForPushes(1)

    expect(pushes.map((push) => push.to)).toEqual([tokenOf('ben')])
  })

  it('a person taken out of a private channel', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [{ ...staff, members: ['ana', 'ben', 'cy', 'dee'] }],
    })
    await registerAll(churchId, ['ben', 'cy'])

    const setMembers = await asMember(churchId, 'ana', '/channels/staff/members', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personIds: ['ana', 'ben', 'dee'] }),
    })
    expect(setMembers.status).toBe(204)
    await postMessage(churchId, 'ana', 'staff', 'Without Cy')
    const pushes = await expo.waitForPushes(1)

    expect(pushes.map((push) => push.to)).toEqual([tokenOf('ben')])
  })

  it('an admin who reads a private channel only by oversight', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, gus],
      channels: [staff, general],
    })
    await registerAll(churchId, ['gus'])

    await postMessage(churchId, 'ben', 'staff', 'Members only')
    await postMessage(churchId, 'ben', 'general', 'Gus, look', ['gus'])
    const pushes = await expo.waitForPushes(1)

    expect(pushes.map((push) => push.body)).toEqual(['Ben Okafor: Gus, look'])
  })

  it('a device its church holds a row for, that the registry lists for no church', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    await registerAll(churchId, ['ben'])

    // The church writes Cy's row, then listing the token for the church fails, so no church lists it.
    await expect(
      registerDeviceWith(envWithFailingClaim('before'), churchId, 'cy', tokenOf('cy')),
    ).rejects.toThrow()
    const message = await postMessage(churchId, 'ana', 'staff', 'Ben and Cy?')
    const marker = await postMessage(churchId, 'ana', 'staff', 'Marker')

    expect((await expo.pushesFor(message.id, { after: marker.id })).map((push) => push.to)).toEqual(
      [tokenOf('ben')],
    )
  })

  it('a phone that signed in to another church, when it was the only one its first church listed', async () => {
    const expo = fakeExpoPush()
    const a = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    const b = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    await registerAll(a.churchId, ['ben'])
    await registerAll(b.churchId, ['ben'])

    // Church A keeps Ben's row, but the registry now lists his phone for church B and none for A.
    await postMessage(a.churchId, 'ana', 'staff', 'Church A staff only')
    await alertsSent(a.churchId, 'staff')

    expect(expo.pushes()).toEqual([])
  })
})

/**
 * A fake Expo push service that holds every batch until `release()`, so the pushes of the next
 * messages wait in the channel's queue behind the first one.
 */
function heldExpoPush() {
  const received: ExpoPushMessage[] = []
  let held = true
  network.stub('POST', EXPO_PUSH_ENDPOINT, async (request) => {
    const batch = (await request.json()) as ExpoPushMessage[]
    while (held) await new Promise((resolve) => setTimeout(resolve, 5))
    received.push(...batch)
    return Response.json({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
  })
  return {
    release() {
      held = false
    },
    /** The pushes for one message, once the marker message's push has arrived. */
    async pushesFor(messageId: string, { after }: { after: string }, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (!received.some((push) => push.data.messageId === after)) {
        if (Date.now() >= deadline) {
          throw new Error(`No push for the marker message ${after} within ${timeoutMs}ms`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return received.filter((push) => push.data.messageId === messageId)
    },
  }
}

describe('a message deleted before its push leaves', () => {
  it('is not pushed when its author deletes it while it waits in the queue', async () => {
    const expo = heldExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    await registerAll(churchId, ['ben', 'cy'])

    const first = await postMessage(churchId, 'ana', 'staff', 'First')
    const mistake = await postMessage(churchId, 'ana', 'staff', 'Sent by mistake')
    expect((await deleteMessage(churchId, 'ana', 'staff', mistake.id)).status).toBe(204)
    expo.release()
    const marker = await postMessage(churchId, 'ana', 'staff', 'Marker')

    expect(await expo.pushesFor(mistake.id, { after: marker.id })).toEqual([])
    expect(await expo.pushesFor(first.id, { after: marker.id })).toHaveLength(2)
  })

  it('is not pushed when a moderator removes it while it waits in the queue', async () => {
    const expo = heldExpoPush()
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
    await registerAll(churchId, ['ana', 'cy'])

    const first = await postMessage(churchId, 'ben', 'staff', 'First')
    const unkind = await postMessage(churchId, 'ben', 'staff', 'Something unkind')
    expect((await removeMessage(churchId, 'ana', 'staff', unkind.id)).status).toBe(204)
    expo.release()
    const marker = await postMessage(churchId, 'ben', 'staff', 'Marker')

    expect(await expo.pushesFor(unkind.id, { after: marker.id })).toEqual([])
    expect(await expo.pushesFor(first.id, { after: marker.id })).toHaveLength(2)
  })
})
