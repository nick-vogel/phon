import { env, exports } from 'cloudflare:workers'
import type { ImagePosted, Message } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
  deleteMessage,
  fetchImage,
  imageBytes,
  openSocket,
  postFrame,
  postImage,
  readHistory,
  registerDevice,
  seedChurch,
  setAlertLevel,
} from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }
const eli = { personId: 'eli', name: 'Eli Brandt' }

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const worship = { channelId: 'worship', name: 'worship', kind: 'open' as const }
const announcements = {
  channelId: 'announcements',
  name: 'announcements',
  kind: 'announcements' as const,
}
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ben', 'cy', 'dee'],
}

describe('posting an image', () => {
  it('stores it, and serves the same bytes and type to another member of the channel', async () => {
    const { churchId } = await seedChurch({ people: [ben, cy], channels: [general] })
    const bytes = imageBytes('image/png')

    const response = await postImage(churchId, 'ben', 'general', {
      bytes,
      type: 'image/png',
      caption: 'Stage plot for Sunday',
    })

    expect(response.status).toBe(201)
    const { message } = (await response.json()) as ImagePosted
    expect(message).toMatchObject({
      authorId: 'ben',
      body: 'Stage plot for Sunday',
      image: { contentType: 'image/png' },
      reactions: [],
    })
    const imageId = message.image?.id as string
    const fetched = await fetchImage(churchId, 'cy', 'general', imageId)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes)
  })

  it("sends the posted message to another member's open socket, and keeps it in the history", async () => {
    const { churchId } = await seedChurch({ people: [ben, cy], channels: [general] })
    const cySocket = await openSocket(churchId, 'cy', 'general')

    const message = await posted(churchId, 'ben', 'general', 'image/jpeg')

    expect(await cySocket.nextFrame()).toEqual({ type: 'message', message })
    expect((await readHistory(churchId, 'cy', 'general')).messages).toEqual([message])
    expect(message).toMatchObject({ body: '', image: { contentType: 'image/jpeg' } })
  })

  it('refuses a person of the church outside a private channel, and stores no message', async () => {
    const { churchId } = await seedChurch({ people: [ben, cy, dee, eli], channels: [staff] })

    const response = await postImage(churchId, 'eli', 'staff', png())

    expect(response.status).toBe(404)
    expect((await readHistory(churchId, 'ben', 'staff')).messages).toEqual([])
  })

  it('refuses a member in announcements, where only admins and chat admins post', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [announcements] })

    const response = await postImage(churchId, 'ben', 'announcements', png())

    expect(response.status).toBe(403)
    expect((await readHistory(churchId, 'ben', 'announcements')).messages).toEqual([])
    expect((await postImage(churchId, 'ana', 'announcements', png())).status).toBe(201)
  })

  it('asks the post gate before it looks at the file, so a refused poster learns nothing of it', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [announcements] })
    const text = new TextEncoder().encode('not a picture at all')

    const response = await postImage(churchId, 'ben', 'announcements', {
      bytes: text,
      type: 'image/png',
    })

    expect(response.status).toBe(403)
  })

  it('refuses an admin who reads a private channel only by oversight', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })

    const response = await postImage(churchId, 'ana', 'staff', png())

    expect(response.status).toBe(403)
    expect((await readHistory(churchId, 'ben', 'staff')).messages).toEqual([])
  })

  it('refuses a file whose bytes are not the image type it declares', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general] })
    const text = new TextEncoder().encode('not a picture at all, just words')

    expect(
      (await postImage(churchId, 'ben', 'general', { bytes: text, type: 'image/png' })).status,
    ).toBe(415)
    expect(
      (
        await postImage(churchId, 'ben', 'general', {
          bytes: imageBytes('image/png'),
          type: 'image/jpeg',
        })
      ).status,
    ).toBe(415)
    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([])
  })

  it.each(['image/heic', 'image/svg+xml', 'text/plain', 'application/octet-stream'])(
    'refuses a part declared as %s',
    async (type) => {
      const { churchId } = await seedChurch({ people: [ben], channels: [general] })

      const response = await postImage(churchId, 'ben', 'general', {
        bytes: imageBytes('image/png'),
        type,
      })

      expect(response.status).toBe(415)
    },
  )

  it('refuses an image larger than 10 MiB, and takes one of exactly 10 MiB', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general] })

    const tooLarge = imageBytes('image/png', 11 * 1024 * 1024)
    expect(
      (await postImage(churchId, 'ben', 'general', { bytes: tooLarge, type: 'image/png' })).status,
    ).toBe(413)
    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([])

    const largest = imageBytes('image/png', 10 * 1024 * 1024)
    expect(
      (await postImage(churchId, 'ben', 'general', { bytes: largest, type: 'image/png' })).status,
    ).toBe(201)
  })

  it('refuses an image larger than 10 MiB that comes with no content length', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general] })
    const form = new FormData()
    const tooLarge = imageBytes('image/png', 11 * 1024 * 1024)
    form.set('image', new File([tooLarge], 'photo', { type: 'image/png' }))
    const encoded = new Response(form)
    const body = encoded.body as ReadableStream<Uint8Array>

    const response = await exports.default.fetch('https://phon.test/channels/general/images', {
      method: 'POST',
      headers: {
        authorization: `Bearer test:${churchId}:ben`,
        'content-type': encoded.headers.get('content-type') as string,
      },
      body: body.pipeThrough(new TransformStream()),
    })

    expect(response.status).toBe(413)
    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([])
  })

  it('refuses an upload with no image part, or an empty one', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general] })
    const captionOnly = new FormData()
    captionOnly.set('body', 'Where did the photo go?')

    const noPart = await exports.default.fetch('https://phon.test/channels/general/images', {
      method: 'POST',
      headers: { authorization: `Bearer test:${churchId}:ben` },
      body: captionOnly,
    })
    const empty = await postImage(churchId, 'ben', 'general', {
      bytes: new Uint8Array(),
      type: 'image/png',
    })

    expect(noPart.status).toBe(400)
    expect(empty.status).toBe(400)
    expect((await readHistory(churchId, 'ben', 'general')).messages).toEqual([])
  })

  it('asks for a sign-in before anything else', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general] })
    const message = await posted(churchId, 'ben', 'general')

    const upload = await exports.default.fetch('https://phon.test/channels/general/images', {
      method: 'POST',
    })
    const fetched = await exports.default.fetch(
      `https://phon.test/channels/general/images/${message.image?.id}`,
    )

    expect(upload.status).toBe(401)
    expect(fetched.status).toBe(401)
  })
})

describe('posting an image marked urgent or as a team announcement', () => {
  /** Fay, a member, leads the Setup team; Ben and Cy are on it. */
  const setup = {
    channelId: 'setup',
    name: 'Setup',
    kind: 'team' as const,
    members: ['ben', 'cy', 'fay'],
    leaders: ['fay'],
  }
  const fay = { personId: 'fay', name: 'Fay Lindqvist' }
  const PEOPLE = [ana, ben, cy, dee, fay]

  async function churchWithDevices() {
    const expo = fakeExpoPush()
    const { churchId } = await seedChurch({ people: PEOPLE, channels: [general, setup] })
    for (const { personId } of PEOPLE) {
      expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
    }
    return { expo, churchId }
  }

  /** A text message after the image, whose push says every push for the image has arrived. */
  async function marker(churchId: string, personId: string, channelId: string, flag: string) {
    const frame = await postFrame(churchId, personId, channelId, {
      type: 'send',
      body: 'Marker',
      [flag]: true,
    })
    if (frame.type !== 'message') throw new Error(`Answered ${JSON.stringify(frame)}`)
    return frame.message.id
  }

  it('from an admin is stored urgent and pushes Time Sensitive to everyone, a person at off too', async () => {
    const { expo, churchId } = await churchWithDevices()
    expect((await setAlertLevel(churchId, 'dee', 'general', 'off')).status).toBe(204)

    const response = await postImage(churchId, 'ana', 'general', { ...png(), urgent: true })

    expect(response.status).toBe(201)
    const { message } = (await response.json()) as ImagePosted
    expect(message.urgent).toBe(true)
    expect((await readHistory(churchId, 'cy', 'general')).messages[0]?.urgent).toBe(true)
    const after = await marker(churchId, 'ana', 'general', 'urgent')
    const pushes = await expo.pushesFor(message.id, { after })
    expect(pushes.map((push) => [push.to, push.title, push.interruptionLevel])).toEqual(
      ['ben', 'cy', 'dee', 'fay'].map((personId) => [
        tokenOf(personId),
        'Urgent in #general',
        'time-sensitive',
      ]),
    )
  })

  it('from a team leader in their own team channel is stored and titled as a team announcement', async () => {
    const { expo, churchId } = await churchWithDevices()

    const response = await postImage(churchId, 'fay', 'setup', { ...png(), teamAnnouncement: true })

    expect(response.status).toBe(201)
    const { message } = (await response.json()) as ImagePosted
    expect(message.teamAnnouncement).toBe(true)
    const after = await marker(churchId, 'fay', 'setup', 'teamAnnouncement')
    const pushes = await expo.pushesFor(message.id, { after })
    expect(pushes.map((push) => [push.to, push.title])).toEqual(
      ['ben', 'cy'].map((personId) => [tokenOf(personId), 'Team announcement in #Setup']),
    )
  })

  it.each([
    ['urgent, from a member', 'ben', 'general', { urgent: true }],
    [
      'a team announcement, from a member who leads no team',
      'ben',
      'setup',
      { teamAnnouncement: true },
    ],
  ])(
    'is refused when %s, and stores neither the message nor the image',
    async (_label, personId, channelId, flags) => {
      const { churchId } = await seedChurch({ people: PEOPLE, channels: [general, setup] })

      const response = await postImage(churchId, personId, channelId, { ...png(), ...flags })

      expect(response.status).toBe(403)
      expect((await readHistory(churchId, 'ana', channelId)).messages).toEqual([])
      expect((await env.IMAGES.list({ prefix: `${churchId}/` })).objects).toEqual([])
    },
  )
})

describe('fetching an image', () => {
  it('serves it to an admin outside a private channel, and to no one else outside it', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee, eli], channels: [staff] })
    const message = await posted(churchId, 'ben', 'staff')
    const imageId = message.image?.id as string

    expect((await fetchImage(churchId, 'eli', 'staff', imageId)).status).toBe(404)
    const forAdmin = await fetchImage(churchId, 'ana', 'staff', imageId)
    expect(forAdmin.status).toBe(200)
    expect(new Uint8Array(await forAdmin.arrayBuffer())).toEqual(imageBytes('image/png'))
    expect((await fetchImage(churchId, 'dee', 'staff', imageId)).status).toBe(200)
  })

  it('answers with the checked type, nosniff, and a private, immutable cache', async () => {
    const { churchId } = await seedChurch({ people: [ben, cy], channels: [general] })
    const message = await posted(churchId, 'ben', 'general', 'image/jpeg')

    const response = await fetchImage(churchId, 'cy', 'general', message.image?.id as string)

    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('refuses a person of another church who names the same channel and image IDs', async () => {
    const first = await seedChurch({ people: [ben], channels: [general] })
    const second = await seedChurch({ people: [ben], channels: [general] })
    const message = await posted(first.churchId, 'ben', 'general')

    const response = await fetchImage(
      second.churchId,
      'ben',
      'general',
      message.image?.id as string,
    )

    expect(response.status).toBe(404)
  })

  it("refuses one channel's image asked for under another, by someone who reads both", async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general, worship] })
    const message = await posted(churchId, 'ben', 'general')

    const response = await fetchImage(churchId, 'ben', 'worship', message.image?.id as string)

    expect(response.status).toBe(404)
    expect((await fetchImage(churchId, 'ben', 'general', message.image?.id as string)).status).toBe(
      200,
    )
  })

  it('refuses an image ID no message has', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general] })

    expect((await fetchImage(churchId, 'ben', 'general', crypto.randomUUID())).status).toBe(404)
  })

  it('hides the image of a deleted message from members, and leaves it to admins', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy], channels: [general] })
    const message = await posted(churchId, 'ben', 'general')
    const imageId = message.image?.id as string
    expect((await deleteMessage(churchId, 'ben', 'general', message.id)).status).toBe(204)

    expect((await fetchImage(churchId, 'cy', 'general', imageId)).status).toBe(404)
    expect((await fetchImage(churchId, 'ben', 'general', imageId)).status).toBe(404)
    expect((await fetchImage(churchId, 'ana', 'general', imageId)).status).toBe(200)
  })
})

describe('where an image is kept', () => {
  it('stores it in R2 under its church, then its channel, then its own ID', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [general, worship] })
    const message = await posted(churchId, 'ben', 'worship')
    const imageId = message.image?.id as string

    const stored = await env.IMAGES.get(`${churchId}/worship/${imageId}`)

    expect(stored).not.toBeNull()
    expect(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer())).toEqual(
      imageBytes('image/png'),
    )
    expect(stored?.httpMetadata?.contentType).toBe('image/png')
    const listed = await env.IMAGES.list({ prefix: `${churchId}/` })
    expect(listed.objects.map((object) => object.key)).toEqual([`${churchId}/worship/${imageId}`])
  })

  it('URI-encodes each part of the key, so a slash in an ID cannot reach another prefix', async () => {
    const churchId = `church/${crypto.randomUUID()}`
    await seedChurch({ churchId, people: [ben], channels: [general] })
    const message = await posted(churchId, 'ben', 'general')
    const imageId = message.image?.id as string

    expect(
      await env.IMAGES.get(`${encodeURIComponent(churchId)}/general/${imageId}`),
    ).not.toBeNull()
    expect(await env.IMAGES.get(`${churchId}/general/${imageId}`)).toBeNull()
  })
})

/** A small PNG upload with no caption. */
function png() {
  return { bytes: imageBytes('image/png'), type: 'image/png' }
}

/** Posts an image as a person and returns the message, failing on anything but 201. */
async function posted(
  churchId: string,
  personId: string,
  channelId: string,
  type: 'image/png' | 'image/jpeg' = 'image/png',
): Promise<Message> {
  const response = await postImage(churchId, personId, channelId, { bytes: imageBytes(type), type })
  if (response.status !== 201) throw new Error(`Posting an image answered ${response.status}`)
  return ((await response.json()) as ImagePosted).message
}
