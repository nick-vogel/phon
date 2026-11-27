import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { asMember, listChannels, readMe, seedChurch } from './support/church.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz' }
const ben = { personId: 'ben', name: 'Ben Okafor' }

describe('who the signed-in member is', () => {
  it("answers with the member's own person ID and name", async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [] })

    expect(await readMe(churchId, 'ben')).toEqual({
      personId: 'ben',
      name: 'Ben Okafor',
      role: 'member',
      canCreate: [],
      canAssignRoles: false,
      canReadOversight: false,
      canMarkUrgent: false,
      canManageBirthdates: false,
      canModerate: false,
      avatar: null,
    })
  })

  it("answers 404 for a person the church's directory does not know", async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [] })

    const response = await asMember(churchId, 'stranger', '/me')

    expect(response.status).toBe(404)
  })

  it("never answers with another church's person of the same ID", async () => {
    const a = await seedChurch({ people: [ana], channels: [] })
    const b = await seedChurch({
      people: [{ personId: 'ana', name: 'Ana from church B' }],
      channels: [],
    })

    expect(await readMe(a.churchId, 'ana')).toMatchObject({ personId: 'ana', name: 'Ana Ortiz' })
    expect(await readMe(b.churchId, 'ana')).toMatchObject({
      personId: 'ana',
      name: 'Ana from church B',
    })
  })
})

describe('the channels a member may open', () => {
  it('lists every open channel of their church, sorted by name', async () => {
    const { churchId } = await seedChurch({
      people: [ana],
      channels: [
        // The IDs sort in a different order from the names, so only a sort by name passes.
        { channelId: 'team-301', name: 'Worship team', kind: 'open' },
        { channelId: 'team-302', name: 'Announcements', kind: 'open' },
        { channelId: 'team-303', name: 'Kids ministry', kind: 'open' },
      ],
    })

    expect(await listChannels(churchId, 'ana')).toEqual({
      channels: [
        {
          id: 'team-302',
          name: 'Announcements',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
        {
          id: 'team-303',
          name: 'Kids ministry',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
        {
          id: 'team-301',
          name: 'Worship team',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
      ],
    })
  })

  it('is empty for a church with no channels', async () => {
    const { churchId } = await seedChurch({ people: [ana], channels: [] })

    expect(await listChannels(churchId, 'ana')).toEqual({ channels: [] })
  })

  it("never lists another church's channel, nor its name for a channel of the same ID", async () => {
    const a = await seedChurch({
      people: [ana],
      channels: [{ channelId: 'sunday-team', name: 'Sunday team', kind: 'open' }],
    })
    await seedChurch({
      people: [{ personId: 'ana', name: 'Ana from church B' }],
      channels: [
        { channelId: 'sunday-team', name: 'Church B Sunday crew', kind: 'open' },
        { channelId: 'youth-leaders', name: 'Youth leaders', kind: 'open' },
      ],
    })

    expect(await listChannels(a.churchId, 'ana')).toEqual({
      channels: [
        {
          id: 'sunday-team',
          name: 'Sunday team',
          kind: 'open',
          canPost: true,
          unread: false,
          mentions: 0,
          lastMessage: null,
          alertLevel: 'mentions',
        },
      ],
    })
  })

  it("answers 404 for a person the church's directory does not know", async () => {
    const { churchId } = await seedChurch({
      people: [ana],
      channels: [{ channelId: 'sunday-team', name: 'Sunday team', kind: 'open' }],
    })

    const response = await asMember(churchId, 'stranger', '/channels')

    expect(response.status).toBe(404)
  })
})

describe('a method other than GET', () => {
  it.each([
    ['POST', '/me'],
    ['DELETE', '/me'],
    ['PUT', '/channels'],
  ])('answers 405 for %s %s', async (method, path) => {
    const { churchId } = await seedChurch({ people: [ana], channels: [] })

    const response = await asMember(churchId, 'ana', path, { method })

    expect(response.status).toBe(405)
  })
})

describe('a request with no identity', () => {
  it.each([['/me'], ['/channels']])('is refused on %s', async (path) => {
    const response = await exports.default.fetch(`https://phon.test${path}`)

    expect(response.status).toBe(401)
  })
})
