import { env } from 'cloudflare:workers'
import type { ChurchList, Member, SignInSession } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { REGISTRY_NAME } from '../src/church-registry.ts'
import { seedChurch } from './support/church.ts'
import { fetchDeployed, runScheduled } from './support/deployed.ts'
import {
  asSession,
  connectChurch,
  connectSyncAccount,
  pcoChurchId,
  seenByApp,
  signIn,
} from './support/flows.ts'
import { network } from './support/network.ts'
import {
  fakePlanningCenter,
  newOrganizationId,
  PLANNING_CENTER,
  pkce,
  randomPart,
  TEST_CLIENT,
} from './support/planning-center.ts'
import { fakeServices } from './support/services.ts'

describe('starting to connect the sync account', () => {
  it("sends the browser to Planning Center's authorize page for the sync account's scopes", async () => {
    const { challenge } = await pkce()
    const state = randomPart()
    const nonce = randomPart()

    const response = await fetchDeployed(
      `/connect/start?code_challenge=${challenge}&state=${state}&nonce=${nonce}`,
    )

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(`${PLANNING_CENTER}/oauth/authorize`)
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: TEST_CLIENT.id,
      redirect_uri: 'https://phon.test/connect/callback',
      response_type: 'code',
      scope: 'openid people services groups',
      prompt: 'select_account',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    })
  })

  it('refuses a start with no PKCE challenge', async () => {
    const response = await fetchDeployed(
      `/connect/start?state=${randomPart()}&nonce=${randomPart()}`,
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it('sends the code and the state back to the app at phon://connect, and nothing else', async () => {
    const response = await fetchDeployed(
      '/connect/callback?code=the-code&state=the-state&scope=openid&extra=dropped',
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('phon://connect?code=the-code&state=the-state')
  })
})

/** One Services team, so a sync that reads Services has something to read. */
const ONE_TEAM = [
  {
    id: '11',
    name: 'Worship',
    members: [{ id: 'ana', name: 'Ana Ortiz' }],
    leaders: [{ id: 'ana', name: 'Ana Ortiz' }],
  },
]

/** The Services calls the sync made, with the bearer token each carried. */
function servicesCalls(): Array<{ url: string; authorization: string | undefined }> {
  return network
    .calls()
    .filter((call) => call.url.startsWith(`${PLANNING_CENTER}/services/`))
    .map((call) => ({ url: call.url, authorization: call.headers.authorization }))
}

describe('connecting the sync account', () => {
  it('stores the connection for an organization administrator, and the next sync reads with it', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    fakeServices(planningCenter, { syncPersonId: 'sync', teams: ONE_TEAM })

    const run = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })
    await runScheduled()

    expect(run.session.status).toBe(204)
    expect(run.session.headers.get('cache-control')).toBe('no-store')
    expect(run.sessionBody).toBe('')
    const calls = servicesCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${planningCenter.accessTokenOf('sync')}`)
    }
  })

  it('never shows the app a Planning Center token', async () => {
    const planningCenter = fakePlanningCenter()

    const run = await connectSyncAccount(planningCenter, {
      organizationId: newOrganizationId(),
      personId: 'sync',
      administrator: true,
    })

    expect(run.session.status).toBe(204)
    expect(planningCenter.issuedTokens()).toHaveLength(3)
    const seen = seenByApp(run)
    for (const issued of planningCenter.issuedTokens()) expect(seen).not.toContain(issued)
  })

  it('refuses a person who is not an organization administrator, and stores nothing', async () => {
    const planningCenter = fakePlanningCenter()
    fakeServices(planningCenter, { syncPersonId: 'volunteer', teams: ONE_TEAM })

    const run = await connectSyncAccount(planningCenter, {
      organizationId: newOrganizationId(),
      personId: 'volunteer',
      administrator: false,
    })
    await runScheduled()

    expect(run.session.status).toBe(403)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'not-administrator' })
    const seen = seenByApp(run)
    for (const issued of planningCenter.issuedTokens()) expect(seen).not.toContain(issued)
    expect(servicesCalls()).toEqual([])
  })

  it('refuses a refused exchange, and stores nothing', async () => {
    const planningCenter = fakePlanningCenter()
    fakeServices(planningCenter, { syncPersonId: 'sync', teams: ONE_TEAM })

    const run = await connectSyncAccount(
      planningCenter,
      { organizationId: newOrganizationId(), personId: 'sync', administrator: true },
      (request) => ({ ...request, codeVerifier: 'x'.repeat(43) }),
    )
    await runScheduled()

    expect(run.session.status).toBe(400)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'connect-failed' })
    expect(servicesCalls()).toEqual([])
  })

  it('refuses an ID token for another application', async () => {
    const planningCenter = fakePlanningCenter()

    const run = await connectSyncAccount(planningCenter, {
      organizationId: newOrganizationId(),
      personId: 'sync',
      administrator: true,
      claims: { aud: 'someone-elses-client' },
    })

    expect(run.session.status).toBe(400)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'connect-failed' })
  })

  it('keeps the earlier connection when someone who is not an administrator tries to replace it', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    fakeServices(planningCenter, { syncPersonId: 'sync', teams: ONE_TEAM })
    await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })

    const replace = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'volunteer',
      administrator: false,
    })
    await runScheduled()

    expect(replace.session.status).toBe(403)
    const calls = servicesCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${planningCenter.accessTokenOf('sync')}`)
    }
  })

  it('replaces the connection when another administrator connects', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'first',
      administrator: true,
    })
    fakeServices(planningCenter, { syncPersonId: 'second', teams: ONE_TEAM })

    const replace = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'second',
      administrator: true,
    })
    await runScheduled()

    expect(replace.session.status).toBe(204)
    const calls = servicesCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${planningCenter.accessTokenOf('second')}`)
    }
  })
})

/** The connected-church list, as anyone sees it before they sign in. */
async function listChurches(): Promise<ChurchList> {
  const response = await fetchDeployed('/churches')
  expect(response.status).toBe(200)
  return (await response.json()) as ChurchList
}

describe("connecting the sync account, and the church's name", () => {
  it("stores the church's Planning Center name, read with the sync account's token and the User-Agent", async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    planningCenter.renameOrganization(organizationId, 'Riverside Chapel')

    const run = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })

    expect(run.session.status).toBe(204)
    expect((await listChurches()).churches).toEqual([
      { churchId: pcoChurchId(organizationId), name: 'Riverside Chapel' },
    ])
    const reads = network
      .calls()
      .filter((call) => new URL(call.url).pathname === '/people/v2')
      .map((call) => ({
        authorization: call.headers.authorization,
        userAgent: call.headers['user-agent'],
      }))
    expect(reads).toEqual([
      {
        authorization: `Bearer ${planningCenter.accessTokenOf('sync')}`,
        userAgent: 'Phon (https://phon.chat)',
      },
    ])
  })

  it('still connects when the name read fails, and leaves the church out of the list', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    planningCenter.failOrganizationReads(1)

    const run = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })

    expect(run.session.status).toBe(204)
    expect((await listChurches()).churches).toEqual([])
  })

  it('lists the church in the registry before it reads the name, so a connect dropped during the read leaves it listed', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    const churchId = pcoChurchId(organizationId)
    const listedWhenRead: boolean[] = []
    network.stubPath('GET', `${PLANNING_CENTER}/people/v2`, async () => {
      listedWhenRead.push((await registered(churchId)) !== undefined)
      return Response.json({
        data: {
          type: 'Organization',
          id: String(organizationId),
          attributes: { name: 'Riverside Chapel' },
        },
      })
    })

    const run = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })

    expect(run.session.status).toBe(204)
    expect(listedWhenRead).toEqual([true])
    expect(await registered(churchId)).toEqual({ churchId, name: 'Riverside Chapel' })
  })

  it('answers at once when the name read is rate limited, with the church listed and its name left to the next tick', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    const churchId = pcoChurchId(organizationId)
    planningCenter.throttleOrganizationReads(['20'])
    const before = Date.now()

    const run = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })

    expect(run.session.status).toBe(204)
    expect(Date.now() - before).toBeLessThan(5000)
    expect(organizationReads()).toBe(1)
    expect(await registered(churchId)).toEqual({ churchId, name: null })
  })

  it('answers at once when the name read reports the rate limit reached, rather than waiting out the period', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    const churchId = pcoChurchId(organizationId)
    planningCenter.renameOrganization(organizationId, 'Riverside Chapel')
    planningCenter.reachRateLimitOnOrganizationReads(1)
    const before = Date.now()

    const run = await connectSyncAccount(planningCenter, {
      organizationId,
      personId: 'sync',
      administrator: true,
    })

    expect(run.session.status).toBe(204)
    expect(Date.now() - before).toBeLessThan(5000)
    expect(await registered(churchId)).toEqual({ churchId, name: 'Riverside Chapel' })
  })
})

/** A church's entry in the church registry, read straight from it, or undefined when it is not listed. */
async function registered(
  churchId: string,
): Promise<{ churchId: string; name: string | null } | undefined> {
  const churches = await env.CHURCH_REGISTRY.getByName(REGISTRY_NAME).churches()
  return churches.find((church) => church.churchId === churchId)
}

/** How many organization reads (`GET /people/v2`) went out. */
function organizationReads(): number {
  return network.calls().filter((call) => new URL(call.url).pathname === '/people/v2').length
}

describe('starting to connect a church', () => {
  it("sends the browser to Planning Center's authorize page for the person's own account and People", async () => {
    const { challenge } = await pkce()
    const state = randomPart()
    const nonce = randomPart()

    const response = await fetchDeployed(
      `/auth/connect/start?code_challenge=${challenge}&state=${state}&nonce=${nonce}`,
    )

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(`${PLANNING_CENTER}/oauth/authorize`)
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: TEST_CLIENT.id,
      redirect_uri: 'https://phon.test/auth/callback',
      response_type: 'code',
      scope: 'openid people',
      prompt: 'select_account',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    })
  })

  it('refuses a start with no PKCE challenge', async () => {
    const response = await fetchDeployed(
      `/auth/connect/start?state=${randomPart()}&nonce=${randomPart()}`,
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })
})

/** The church's view of a person through a Phon session: who `/me` says they are. */
async function meWith(token: string): Promise<Member> {
  const response = await asSession(token, '/me')
  expect(response.status).toBe(200)
  return (await response.json()) as Member
}

describe('connecting a church, which names its first admin', () => {
  it('makes a Planning Center administrator the first admin of a church Phon has never seen', async () => {
    const planningCenter = fakePlanningCenter()

    const run = await connectChurch(planningCenter, {
      organizationId: newOrganizationId(),
      personId: 'ana',
      administrator: true,
      claims: { name: 'Ana Ortiz' },
    })

    expect(run.session.status).toBe(200)
    expect(run.session.headers.get('cache-control')).toBe('no-store')
    const { token } = JSON.parse(run.sessionBody) as SignInSession
    expect(await meWith(token)).toEqual({
      personId: 'ana',
      name: 'Ana Ortiz',
      role: 'admin',
      // Phon has no birthdate on file for her yet, so the youth rule (phon#18) treats her as a
      // minor, who creates no channel, until one is.
      canCreate: [],
      canAssignRoles: true,
      canReadOversight: true,
      canMarkUrgent: true,
      canManageBirthdates: true,
      canModerate: true,
      avatar: null,
    })
  })

  it('makes a person the sync already knows the first admin, keeping their name', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    await seedChurch({
      churchId: pcoChurchId(organizationId),
      people: [{ personId: 'ana', name: 'Ana Ortiz' }],
      channels: [],
    })

    const run = await connectChurch(planningCenter, {
      organizationId,
      personId: 'ana',
      administrator: true,
      claims: { name: 'A. Ortiz' },
    })

    expect(run.session.status).toBe(200)
    const { token } = JSON.parse(run.sessionBody) as SignInSession
    expect(await meWith(token)).toMatchObject({ name: 'Ana Ortiz', role: 'admin' })
  })

  it('lets the first admin make another person a chat admin and then an admin', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    await seedChurch({
      churchId: pcoChurchId(organizationId),
      people: [{ personId: 'ben', name: 'Ben Okafor' }],
      channels: [],
    })
    const run = await connectChurch(planningCenter, {
      organizationId,
      personId: 'ana',
      administrator: true,
    })
    const { token } = JSON.parse(run.sessionBody) as SignInSession
    const benSession = JSON.parse(
      (await signIn(planningCenter, { organizationId, personId: 'ben' })).sessionBody,
    ) as SignInSession

    for (const role of ['chat-admin', 'admin'] as const) {
      const set = await asSession(token, '/people/ben/role', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      expect(set.status).toBe(204)
      expect((await meWith(benSession.token)).role).toBe(role)
    }
  })

  it('refuses a person who is not a Planning Center administrator, and grants nothing', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    await seedChurch({
      churchId: pcoChurchId(organizationId),
      people: [{ personId: 'cy', name: 'Cy Park' }],
      channels: [],
    })

    const run = await connectChurch(planningCenter, {
      organizationId,
      personId: 'cy',
      administrator: false,
    })

    expect(run.session.status).toBe(403)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'not-administrator' })
    const later = await signIn(planningCenter, { organizationId, personId: 'cy' })
    const { token } = JSON.parse(later.sessionBody) as SignInSession
    expect(await meWith(token)).toMatchObject({ role: 'member', canAssignRoles: false })
  })

  it('leaves a stranger refused by a non-administrator connect still unknown', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()

    const run = await connectChurch(planningCenter, {
      organizationId,
      personId: 'cy',
      administrator: false,
    })
    const later = await signIn(planningCenter, { organizationId, personId: 'cy' })

    expect(run.session.status).toBe(403)
    expect(later.session.status).toBe(403)
    expect(JSON.parse(later.sessionBody)).toEqual({ problem: 'not-known' })
  })

  it('refuses a second administrator once the church has an admin, and changes no role', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()
    await seedChurch({
      churchId: pcoChurchId(organizationId),
      people: [{ personId: 'ben', name: 'Ben Okafor' }],
      channels: [],
    })
    await connectChurch(planningCenter, { organizationId, personId: 'ana', administrator: true })

    const second = await connectChurch(planningCenter, {
      organizationId,
      personId: 'ben',
      administrator: true,
    })
    const stranger = await connectChurch(planningCenter, {
      organizationId,
      personId: 'eve',
      administrator: true,
    })

    expect(second.session.status).toBe(409)
    expect(JSON.parse(second.sessionBody)).toEqual({ problem: 'already-connected' })
    expect(stranger.session.status).toBe(409)
    const benSignIn = await signIn(planningCenter, { organizationId, personId: 'ben' })
    const { token } = JSON.parse(benSignIn.sessionBody) as SignInSession
    expect((await meWith(token)).role).toBe('member')
    const eveSignIn = await signIn(planningCenter, { organizationId, personId: 'eve' })
    expect(eveSignIn.session.status).toBe(403)
  })

  it('never makes anyone an admin of another church', async () => {
    const planningCenter = fakePlanningCenter()
    const a = newOrganizationId()
    const b = newOrganizationId()
    await seedChurch({
      churchId: pcoChurchId(b),
      people: [{ personId: 'ana', name: 'Ana in church B' }],
      channels: [],
    })

    await connectChurch(planningCenter, { organizationId: a, personId: 'ana', administrator: true })

    const inB = await signIn(planningCenter, { organizationId: b, personId: 'ana' })
    const { token } = JSON.parse(inB.sessionBody) as SignInSession
    expect(await meWith(token)).toMatchObject({ name: 'Ana in church B', role: 'member' })
    const bAdmin = await connectChurch(planningCenter, {
      organizationId: b,
      personId: 'bea',
      administrator: true,
    })
    expect(bAdmin.session.status).toBe(200)
  })

  it('never shows the app a Planning Center token, and sends the User-Agent on every call', async () => {
    const planningCenter = fakePlanningCenter()

    const run = await connectChurch(planningCenter, {
      organizationId: newOrganizationId(),
      personId: 'ana',
      administrator: true,
    })

    expect(run.session.status).toBe(200)
    expect(planningCenter.issuedTokens()).toHaveLength(3)
    const seen = seenByApp(run)
    for (const issued of planningCenter.issuedTokens()) expect(seen).not.toContain(issued)
    const calls = network.calls().filter((call) => call.url.startsWith(PLANNING_CENTER))
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/oauth/token',
      '/people/v2/me',
    ])
    for (const call of calls) expect(call.headers['user-agent']).toBe('Phon (https://phon.chat)')
  })

  it('refuses a refused exchange with sign-in-failed, and grants nothing', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()

    const run = await connectChurch(
      planningCenter,
      { organizationId, personId: 'ana', administrator: true },
      (request) => ({ ...request, codeVerifier: 'x'.repeat(43) }),
    )
    const later = await connectChurch(planningCenter, {
      organizationId,
      personId: 'bea',
      administrator: true,
    })

    expect(run.session.status).toBe(400)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'sign-in-failed' })
    expect(later.session.status).toBe(200)
  })

  it('answers 405 for a method other than POST', async () => {
    expect((await fetchDeployed('/auth/connect')).status).toBe(405)
  })
})
