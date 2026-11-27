import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { ChannelList, ChurchList } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { CHURCH_LIST_PERIOD_MS, ChurchListCache } from '../src/church-list.ts'
import { sessions } from '../src/session.ts'
import { createWorker } from '../src/worker.ts'
import { withCaller } from './support/callers.ts'
import { DEPLOYED_ORIGIN, fetchDeployed, runScheduled } from './support/deployed.ts'
import { asSession, connectSyncAccount, pcoChurchId, signIn } from './support/flows.ts'
import { refusingMailer } from './support/mailer.ts'
import { network } from './support/network.ts'
import { fakePlanningCenter, newOrganizationId } from './support/planning-center.ts'
import { fakeServices } from './support/services.ts'

/** The connected-church list, with no sign-in. */
async function listChurches(): Promise<ChurchList> {
  const response = await fetchDeployed('/churches')
  expect(response.status).toBe(200)
  return (await response.json()) as ChurchList
}

/**
 * The church list through a Worker like the deployed one, whose church list cache runs on a clock
 * the test moves, so a test can let the cache period pass without waiting it out.
 */
function clockedChurchList() {
  let now = 1_000_000
  const churchList = new ChurchListCache(CHURCH_LIST_PERIOD_MS, () => now)
  const worker = createWorker({ authenticate: sessions, mailer: refusingMailer, churchList })
  return {
    async list(): Promise<ChurchList> {
      const ctx = createExecutionContext()
      const request = new Request(`${DEPLOYED_ORIGIN}/churches`, {
        headers: withCaller(),
      }) as Request<unknown, IncomingRequestCfProperties>
      const response = await worker.fetch?.(request, env, ctx)
      await waitOnExecutionContext(ctx)
      if (response === undefined) throw new Error('The Worker has no fetch handler')
      expect(response.status).toBe(200)
      return (await response.json()) as ChurchList
    },
    /** Moves the cache's clock on by `ms`. */
    advance(ms: number): void {
      now += ms
    },
  }
}

/** How many organization reads (`GET /people/v2`) went to Planning Center since the last reset. */
function organizationReads(): number {
  return network.calls().filter((call) => new URL(call.url).pathname === '/people/v2').length
}

/** One Services team with Ana on it, so a tick has a roster to apply. */
const ONE_TEAM = [
  {
    id: '11',
    name: 'Worship',
    members: [{ id: 'ana', name: 'Ana Ortiz' }],
    leaders: [],
  },
]

describe('the connected-church list', () => {
  it('answers with no sign-in, each connected church by its ID and name, sorted by name', async () => {
    const planningCenter = fakePlanningCenter()
    const riverside = newOrganizationId()
    const bethel = newOrganizationId()
    planningCenter.renameOrganization(riverside, 'Riverside Chapel')
    planningCenter.renameOrganization(bethel, 'Bethel Chapel')
    for (const [organizationId, personId] of [
      [riverside, 'riverside-sync'],
      [bethel, 'bethel-sync'],
    ] as const) {
      const run = await connectSyncAccount(planningCenter, {
        organizationId,
        personId,
        administrator: true,
      })
      expect(run.session.status).toBe(204)
    }

    const response = await fetchDeployed('/churches')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()) as ChurchList).toEqual({
      churches: [
        { churchId: pcoChurchId(bethel), name: 'Bethel Chapel' },
        { churchId: pcoChurchId(riverside), name: 'Riverside Chapel' },
      ],
    })
  })

  it('sorts a lowercase or accented name among its letters, not after every capitalised one', async () => {
    const planningCenter = fakePlanningCenter()
    const zion = newOrganizationId()
    const grace = newOrganizationId()
    const eglise = newOrganizationId()
    planningCenter.renameOrganization(zion, 'Zion Church')
    planningCenter.renameOrganization(grace, 'grace Fellowship')
    planningCenter.renameOrganization(eglise, 'Église Saint-Paul')
    for (const [organizationId, personId] of [
      [zion, 'zion-sync'],
      [grace, 'grace-sync'],
      [eglise, 'eglise-sync'],
    ] as const) {
      await connectSyncAccount(planningCenter, { organizationId, personId, administrator: true })
    }

    expect((await listChurches()).churches).toEqual([
      { churchId: pcoChurchId(eglise), name: 'Église Saint-Paul' },
      { churchId: pcoChurchId(grace), name: 'grace Fellowship' },
      { churchId: pcoChurchId(zion), name: 'Zion Church' },
    ])
  })

  it('orders two churches of one name by church ID', async () => {
    const planningCenter = fakePlanningCenter()
    const first = newOrganizationId()
    const second = newOrganizationId()
    planningCenter.renameOrganization(first, 'Grace Chapel')
    planningCenter.renameOrganization(second, 'Grace Chapel')
    for (const [organizationId, personId] of [
      [first, 'first-sync'],
      [second, 'second-sync'],
    ] as const) {
      await connectSyncAccount(planningCenter, { organizationId, personId, administrator: true })
    }
    const [low, high] = [pcoChurchId(first), pcoChurchId(second)].sort()

    expect((await listChurches()).churches).toEqual([
      { churchId: low, name: 'Grace Chapel' },
      { churchId: high, name: 'Grace Chapel' },
    ])
  })

  it('leaves out a connected church whose name is not read yet', async () => {
    const planningCenter = fakePlanningCenter()
    const named = newOrganizationId()
    const nameless = newOrganizationId()
    await connectSyncAccount(planningCenter, {
      organizationId: named,
      personId: 'named-sync',
      administrator: true,
    })
    planningCenter.failOrganizationReads(1)
    const run = await connectSyncAccount(planningCenter, {
      organizationId: nameless,
      personId: 'nameless-sync',
      administrator: true,
    })

    expect(run.session.status).toBe(204)
    expect((await listChurches()).churches).toEqual([
      { churchId: pcoChurchId(named), name: `Church ${named}` },
    ])
  })

  it('answers 405 for a method other than GET', async () => {
    expect((await fetchDeployed('/churches', { method: 'POST' })).status).toBe(405)
  })
})

describe("the roster sync and a church's name", () => {
  it('fills the name of a connected church that has none on its next tick', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    fakeServices(planningCenter, { syncPersonId: 'sync', teams: ONE_TEAM })
    planningCenter.failOrganizationReads(1)
    await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })
    const churchList = clockedChurchList()
    expect((await churchList.list()).churches).toEqual([])

    await runScheduled()
    churchList.advance(CHURCH_LIST_PERIOD_MS)

    expect((await churchList.list()).churches).toEqual([
      { churchId: pcoChurchId(organizationId), name: `Church ${organizationId}` },
    ])
  })

  it('shows a church named after a list once the cache period has passed, and not before', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    fakeServices(planningCenter, { syncPersonId: 'sync', teams: ONE_TEAM })
    planningCenter.failOrganizationReads(1)
    await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })
    const churchList = clockedChurchList()
    expect((await churchList.list()).churches).toEqual([])

    await runScheduled()
    churchList.advance(CHURCH_LIST_PERIOD_MS - 1)
    expect((await churchList.list()).churches).toEqual([])
    churchList.advance(1)

    expect((await churchList.list()).churches).toEqual([
      { churchId: pcoChurchId(organizationId), name: `Church ${organizationId}` },
    ])
  })

  it('leaves a stored name alone, and reads no name for it', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    fakeServices(planningCenter, { syncPersonId: 'sync', teams: ONE_TEAM })
    planningCenter.renameOrganization(organizationId, 'Riverside Chapel')
    await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })
    planningCenter.renameOrganization(organizationId, 'Riverside Downtown')
    const before = organizationReads()

    await runScheduled()

    expect(organizationReads()).toBe(before)
    expect((await listChurches()).churches).toEqual([
      { churchId: pcoChurchId(organizationId), name: 'Riverside Chapel' },
    ])
  })

  it('still applies the roster when the name read fails, and fills the name on a later tick', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    fakeServices(planningCenter, { syncPersonId: 'sync', teams: ONE_TEAM })
    // The connect's read and the first tick's read both fail.
    planningCenter.failOrganizationReads(2)
    await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })

    await runScheduled()

    const ana = await signIn(planningCenter, { organizationId, personId: 'ana' })
    expect(ana.session.status).toBe(200)
    const { token } = JSON.parse(ana.sessionBody) as { token: string }
    const channels = (await (await asSession(token, '/channels')).json()) as ChannelList
    expect(channels.channels.map((channel) => channel.id)).toContain('team-11')
    const churchList = clockedChurchList()
    expect((await churchList.list()).churches).toEqual([])

    await runScheduled()
    churchList.advance(CHURCH_LIST_PERIOD_MS)

    expect((await churchList.list()).churches).toEqual([
      { churchId: pcoChurchId(organizationId), name: `Church ${organizationId}` },
    ])
  })
})
