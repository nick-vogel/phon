import { env } from 'cloudflare:workers'
import type { ChannelSummary, ImagePosted } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
  deleteMessage,
  imageBytes,
  listChannels,
  postImage,
  postMessage,
  readAlerts,
  removeMessage,
  seedChurch,
  setAlertLevel,
} from './support/church.ts'
import { ADULT_BIRTHDATE } from './support/people.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const dee = { personId: 'dee', name: 'Dee Mensah' }

const general = { channelId: 'general', name: 'general', kind: 'open' as const }
const announcements = {
  channelId: 'announcements',
  name: 'announcements',
  kind: 'announcements' as const,
}
const worship = {
  channelId: 'worship',
  name: 'Worship',
  kind: 'team' as const,
  members: ['ben', 'cy', 'dee'],
}
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ben', 'cy', 'dee'],
}

/** A church with an open channel everyone serves in. */
function church() {
  return seedChurch({ people: [ana, ben, cy, dee], channels: [general] })
}

/** One channel's summary in a person's channel list. Fails when the list does not carry it. */
async function summaryOf(
  churchId: string,
  personId: string,
  channelId: string,
): Promise<ChannelSummary> {
  const summary = (await listChannels(churchId, personId)).channels.find(
    (channel) => channel.id === channelId,
  )
  if (summary === undefined) throw new Error(`${personId} does not list ${channelId}`)
  return summary
}

describe('the last message in the channel list', () => {
  it('is null for a channel with no messages', async () => {
    const { churchId } = await church()

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toBeNull()
  })

  it("carries a text message's author first name, its text, no image, and its sent time", async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'ben', 'general', 'Coffee after service?')

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toEqual({
      authorFirstName: 'Ben',
      body: 'Coffee after service?',
      image: null,
      sentAt: message.sentAt,
    })
  })

  it('is replaced by the next message', async () => {
    const { churchId } = await church()
    await postMessage(churchId, 'ben', 'general', 'Coffee after service?')
    const reply = await postMessage(churchId, 'dee', 'general', 'Count me in')

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toEqual({
      authorFirstName: 'Dee',
      body: 'Count me in',
      image: null,
      sentAt: reply.sentAt,
    })
  })

  it("can be the reader's own message", async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'cy', 'general', 'Running late')

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toMatchObject({
      authorFirstName: 'Cy',
      body: 'Running late',
      sentAt: message.sentAt,
    })
  })

  it('names no author once they leave the church, and keeps their text', async () => {
    const { churchId } = await church()
    const message = await postMessage(churchId, 'ben', 'general', 'Coffee after service?')
    // Ben leaves the church: the roster sync drops him.
    await env.CHURCH_DIRECTORY.getByName(churchId).applyRoster(churchId, {
      people: [ana, cy, dee].map(({ personId, name }) => ({
        personId,
        name,
        serves: true,
        birthdate: ADULT_BIRTHDATE,
        avatar: null,
      })),
      dropped: ['ben'],
      groupTypes: null,
      channels: [],
      memberships: [],
      leaders: [],
    })

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toEqual({
      authorFirstName: null,
      body: 'Coffee after service?',
      image: null,
      sentAt: message.sentAt,
    })
  })

  it('marks a photo, with its caption as the text, or empty text when it has none', async () => {
    const { churchId } = await church()
    const captioned = await posted(
      postImage(churchId, 'ben', 'general', {
        bytes: imageBytes('image/png'),
        type: 'image/png',
        caption: 'Stage plot for Sunday',
      }),
    )

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toEqual({
      authorFirstName: 'Ben',
      body: 'Stage plot for Sunday',
      image: 'photo',
      sentAt: captioned.sentAt,
    })

    const bare = await posted(
      postImage(churchId, 'dee', 'general', {
        bytes: imageBytes('image/jpeg'),
        type: 'image/jpeg',
      }),
    )
    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toEqual({
      authorFirstName: 'Dee',
      body: '',
      image: 'photo',
      sentAt: bare.sentAt,
    })
  })

  it('marks an image of type image/gif as a GIF', async () => {
    const { churchId } = await church()
    const gif = await posted(
      postImage(churchId, 'ben', 'general', {
        bytes: imageBytes('image/gif'),
        type: 'image/gif',
        caption: 'Us after VBS',
      }),
    )

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toEqual({
      authorFirstName: 'Ben',
      body: 'Us after VBS',
      image: 'gif',
      sentAt: gif.sentAt,
    })
  })

  it('is never a message its author deleted: the newest live message before it takes its place', async () => {
    const { churchId } = await church()
    const first = await postMessage(churchId, 'ben', 'general', 'Coffee after service?')
    const second = await postMessage(churchId, 'dee', 'general', 'Wrong channel, sorry')

    expect((await deleteMessage(churchId, 'dee', 'general', second.id)).status).toBe(204)

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toEqual({
      authorFirstName: 'Ben',
      body: 'Coffee after service?',
      image: null,
      sentAt: first.sentAt,
    })
  })

  it('is never a message a moderator removed', async () => {
    const { churchId } = await church()
    const first = await postMessage(churchId, 'ben', 'general', 'Coffee after service?')
    const second = await postMessage(churchId, 'dee', 'general', 'Something unkind')

    expect((await removeMessage(churchId, 'ana', 'general', second.id)).status).toBe(204)

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toMatchObject({
      authorFirstName: 'Ben',
      sentAt: first.sentAt,
    })
  })

  it('is null once every message in the channel is deleted', async () => {
    const { churchId } = await church()
    const first = await postMessage(churchId, 'ben', 'general', 'Coffee after service?')
    const second = await postMessage(churchId, 'ben', 'general', 'Never mind')

    await deleteMessage(churchId, 'ben', 'general', second.id)
    await deleteMessage(churchId, 'ben', 'general', first.id)

    expect((await summaryOf(churchId, 'cy', 'general')).lastMessage).toBeNull()
  })
})

describe('the alert level in the channel list', () => {
  // The directory sorts names as SQLite compares them, capitals first, as the channel list does.
  it("is each channel kind's default before the member picks one", async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [general, announcements, worship, staff],
    })

    const levels = (await listChannels(churchId, 'cy')).channels.map(({ id, alertLevel }) => ({
      id,
      alertLevel,
    }))

    expect(levels).toEqual([
      { id: 'staff', alertLevel: 'every-message' },
      { id: 'worship', alertLevel: 'mentions-and-team-announcements' },
      { id: 'announcements', alertLevel: 'every-message' },
      { id: 'general', alertLevel: 'mentions' },
    ])
  })

  it('is the level the member set, the same one their alert settings answer', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [general, worship],
    })

    expect((await setAlertLevel(churchId, 'cy', 'worship', 'off')).status).toBe(204)

    expect((await summaryOf(churchId, 'cy', 'worship')).alertLevel).toBe('off')
    expect((await readAlerts(churchId, 'cy', 'worship')).level).toBe('off')
    expect((await summaryOf(churchId, 'ben', 'worship')).alertLevel).toBe(
      'mentions-and-team-announcements',
    )
    expect((await summaryOf(churchId, 'cy', 'general')).alertLevel).toBe('mentions')
  })
})

describe('an oversight channel in the channel list', () => {
  it('carries neither the last message nor the alert level, though it has messages', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, dee], channels: [staff] })
    await postMessage(churchId, 'ben', 'staff', 'Budget draft is up')

    expect(await listChannels(churchId, 'ana')).toEqual({
      channels: [{ id: 'staff', name: 'Staff', kind: 'private', canPost: false, oversight: true }],
    })
  })
})

describe('the channel list with previews', () => {
  it('stays sorted by name, whichever channel has the newest message', async () => {
    const { churchId } = await seedChurch({
      people: [ana, ben, cy, dee],
      channels: [
        { channelId: 'c', name: 'choir', kind: 'open' as const },
        { channelId: 'b', name: 'bible study', kind: 'open' as const },
        { channelId: 'a', name: 'alpha', kind: 'open' as const },
      ],
    })
    await postMessage(churchId, 'ben', 'c', 'First')
    await postMessage(churchId, 'ben', 'b', 'Second')
    await postMessage(churchId, 'ben', 'a', 'Third')
    await postMessage(churchId, 'dee', 'c', 'Newest')

    const list = (await listChannels(churchId, 'cy')).channels

    expect(list.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
    expect(list.map(({ lastMessage }) => lastMessage?.body)).toEqual(['Third', 'Second', 'Newest'])
  })
})

/** The message an image upload stored. Fails when the upload does not answer 201. */
async function posted(upload: Promise<Response>) {
  const response = await upload
  if (response.status !== 201) throw new Error(`The upload answered ${response.status}`)
  return ((await response.json()) as ImagePosted).message
}
