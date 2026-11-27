import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  acknowledgeOversightNotice,
  asMember,
  readOversightNotice,
  seedChurch,
} from './support/church.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }

describe('the oversight notice', () => {
  it('is unseen for a new person, and seen once they acknowledge it', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [] })

    expect(await readOversightNotice(churchId, 'ben')).toEqual({ seen: false })

    expect((await acknowledgeOversightNotice(churchId, 'ben')).status).toBe(204)
    expect(await readOversightNotice(churchId, 'ben')).toEqual({ seen: true })
  })

  it('stays seen after a second acknowledgement', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [] })
    await acknowledgeOversightNotice(churchId, 'ben')

    expect((await acknowledgeOversightNotice(churchId, 'ben')).status).toBe(204)

    expect(await readOversightNotice(churchId, 'ben')).toEqual({ seen: true })
  })

  it('stays unseen for another person, and for the same person ID in another church', async () => {
    const a = await seedChurch({ people: [ana, ben], channels: [] })
    const b = await seedChurch({ people: [ana, ben], channels: [] })

    await acknowledgeOversightNotice(a.churchId, 'ben')

    expect(await readOversightNotice(a.churchId, 'ana')).toEqual({ seen: false })
    expect(await readOversightNotice(b.churchId, 'ben')).toEqual({ seen: false })
  })

  it.each([['GET'], ['PUT']])(
    'answers %s with 404 for a person the church does not know',
    async (method) => {
      const { churchId } = await seedChurch({ people: [ana], channels: [] })

      const response = await asMember(churchId, 'stranger', '/me/oversight-notice', { method })

      expect(response.status).toBe(404)
    },
  )

  it.each([['GET'], ['PUT']])('answers %s with 401 without an identity', async (method) => {
    const response = await exports.default.fetch('https://phon.test/me/oversight-notice', {
      method,
    })

    expect(response.status).toBe(401)
  })

  it('answers 405 for another method, and stays unseen', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben], channels: [] })

    const response = await asMember(churchId, 'ben', '/me/oversight-notice', { method: 'POST' })

    expect(response.status).toBe(405)
    expect(await readOversightNotice(churchId, 'ben')).toEqual({ seen: false })
  })
})
