import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { Member, SignInRequest, SignInSession } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { asMember, seedChurch } from './support/church.ts'
import { fetchDeployed } from './support/deployed.ts'
import { asSession, pcoChurchId, seenByApp, signIn } from './support/flows.ts'
import { network } from './support/network.ts'
import {
  fakePlanningCenter,
  newOrganizationId,
  PLANNING_CENTER,
  pkce,
  randomPart,
  TEST_CLIENT,
} from './support/planning-center.ts'

/** A church Phon knows, keyed on a Planning Center organization no other test uses. */
async function seedPlanningCenterChurch(people: Array<{ personId: string; name: string }>) {
  const organizationId = newOrganizationId()
  const church = await seedChurch({
    churchId: pcoChurchId(organizationId),
    people,
    channels: [{ channelId: 'sunday-team', name: 'Sunday team', kind: 'open' }],
  })
  return { organizationId, churchId: church.churchId }
}

describe('starting a sign-in', () => {
  it("sends the browser to Planning Center's authorize page with the app's PKCE challenge", async () => {
    const { challenge } = await pkce()
    const state = randomPart()
    const nonce = randomPart()

    const response = await fetchDeployed(
      `/auth/start?code_challenge=${challenge}&state=${state}&nonce=${nonce}`,
    )

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(`${PLANNING_CENTER}/oauth/authorize`)
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: TEST_CLIENT.id,
      redirect_uri: 'https://phon.test/auth/callback',
      response_type: 'code',
      scope: 'openid',
      prompt: 'select_account',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    })
  })

  it.each([
    ['no challenge', (q: URLSearchParams) => q.delete('code_challenge')],
    ['a plain verifier as the challenge', (q: URLSearchParams) => q.set('code_challenge', 'short')],
    [
      'a challenge with characters outside base64url',
      (q: URLSearchParams) => q.set('code_challenge', `${'a'.repeat(42)}+`),
    ],
    ['no state', (q: URLSearchParams) => q.delete('state')],
    ['no nonce', (q: URLSearchParams) => q.delete('nonce')],
    ['a state with spaces', (q: URLSearchParams) => q.set('state', 'not a safe state value')],
  ])('refuses a start with %s', async (_label, spoil) => {
    const { challenge } = await pkce()
    const query = new URLSearchParams({
      code_challenge: challenge,
      state: randomPart(),
      nonce: randomPart(),
    })
    spoil(query)

    const response = await fetchDeployed(`/auth/start?${query}`)

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })
})

describe("Planning Center's callback", () => {
  it('sends the code and the state back to the app, and nothing else', async () => {
    const response = await fetchDeployed(
      '/auth/callback?code=the-code&state=the-state&scope=openid&extra=dropped',
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('phon://sign-in?code=the-code&state=the-state')
  })

  it('sends an error and the state back to the app, without a code', async () => {
    const response = await fetchDeployed(
      '/auth/callback?error=access_denied&state=the-state&error_description=no',
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'phon://sign-in?error=access_denied&state=the-state',
    )
  })
})

describe('signing in with Planning Center', () => {
  it('gives the app a Phon session and no Planning Center token', async () => {
    const planningCenter = fakePlanningCenter()
    const { organizationId } = await seedPlanningCenterChurch([
      { personId: 'ana', name: 'Ana Ortiz' },
    ])

    const run = await signIn(planningCenter, { organizationId, personId: 'ana' })

    expect(run.session.status).toBe(200)
    const { token } = JSON.parse(run.sessionBody) as SignInSession
    expect(token).toEqual(expect.any(String))
    expect(planningCenter.issuedTokens()).toHaveLength(3)
    const seen = seenByApp(run)
    for (const issued of planningCenter.issuedTokens()) {
      expect(seen).not.toContain(issued)
      expect(token).not.toContain(issued)
    }
  })

  it("lands on the person in the church that matches the ID token's organization_id", async () => {
    const planningCenter = fakePlanningCenter()
    // Both churches know a person `ana`, under different names.
    await seedPlanningCenterChurch([{ personId: 'ana', name: 'Ana in church A' }])
    const b = await seedPlanningCenterChurch([{ personId: 'ana', name: 'Ana in church B' }])

    const run = await signIn(planningCenter, { organizationId: b.organizationId, personId: 'ana' })
    const { token } = JSON.parse(run.sessionBody) as SignInSession
    const me = await asSession(token, '/me')

    expect(me.status).toBe(200)
    expect((await me.json()) as Member).toEqual({
      personId: 'ana',
      name: 'Ana in church B',
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
})

describe('a sign-in Phon refuses', () => {
  it('refuses a person the church does not know, with no session and no Planning Center token', async () => {
    const planningCenter = fakePlanningCenter()
    const { organizationId } = await seedPlanningCenterChurch([
      { personId: 'ana', name: 'Ana Ortiz' },
    ])

    const run = await signIn(planningCenter, { organizationId, personId: 'stranger' })

    expect(run.session.status).toBe(403)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'not-known' })
    const seen = seenByApp(run)
    expect(planningCenter.issuedTokens()).toHaveLength(3)
    for (const issued of planningCenter.issuedTokens()) expect(seen).not.toContain(issued)
  })

  it('refuses a person of an organization no Phon church has, and leaves no directory behind', async () => {
    const planningCenter = fakePlanningCenter()
    const organizationId = newOrganizationId()

    const run = await signIn(planningCenter, { organizationId, personId: 'ana' })

    expect(run.session.status).toBe(403)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'not-known' })
    expect(await directoryTables(pcoChurchId(organizationId))).toEqual([])
  })

  it('refuses the person of the same ID in another church', async () => {
    const planningCenter = fakePlanningCenter()
    await seedPlanningCenterChurch([{ personId: 'bo', name: 'Bo Lindqvist' }])
    const a = await seedPlanningCenterChurch([{ personId: 'ana', name: 'Ana Ortiz' }])

    const run = await signIn(planningCenter, { organizationId: a.organizationId, personId: 'bo' })

    expect(run.session.status).toBe(403)
  })

  it.each([
    ['a verifier that does not match the challenge', { codeVerifier: 'x'.repeat(43) }],
    ['a code Planning Center never issued', { code: 'pco-code-forged' }],
    ['a nonce that does not match the ID token', { nonce: 'another-nonce-value' }],
  ])('fails with %s', async (_label, change) => {
    const planningCenter = fakePlanningCenter()
    const { organizationId } = await seedPlanningCenterChurch([
      { personId: 'ana', name: 'Ana Ortiz' },
    ])

    const run = await signIn(planningCenter, { organizationId, personId: 'ana' }, (request) => ({
      ...request,
      ...change,
    }))

    expect(run.session.status).toBe(400)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'sign-in-failed' })
  })

  it.each([
    ['for another application', { aud: 'someone-elses-client' }],
    ['from another issuer', { iss: 'https://issuer.example' }],
    ['that has expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])('fails with an ID token %s', async (_label, claims) => {
    const planningCenter = fakePlanningCenter()
    const { organizationId } = await seedPlanningCenterChurch([
      { personId: 'ana', name: 'Ana Ortiz' },
    ])

    const run = await signIn(planningCenter, { organizationId, personId: 'ana', claims })

    expect(run.session.status).toBe(400)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'sign-in-failed' })
  })

  it('fails when the same code is used twice', async () => {
    const planningCenter = fakePlanningCenter()
    const { organizationId } = await seedPlanningCenterChurch([
      { personId: 'ana', name: 'Ana Ortiz' },
    ])
    let sent: SignInRequest | undefined
    await signIn(planningCenter, { organizationId, personId: 'ana' }, (request) => {
      sent = request
      return request
    })

    const again = await fetchDeployed('/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sent),
    })

    expect(again.status).toBe(400)
  })

  it('fails with a body that is not a sign-in request', async () => {
    const response = await fetchDeployed('/auth/session', { method: 'POST', body: 'not json' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ problem: 'sign-in-failed' })
  })
})

describe("a session for one church and another church's channels", () => {
  /** Church A and church B both have `sunday-team`; only B has `youth-leaders`. */
  async function signedInToChurchA() {
    const planningCenter = fakePlanningCenter()
    const a = await seedPlanningCenterChurch([{ personId: 'ana', name: 'Ana Ortiz' }])
    const bOrganizationId = newOrganizationId()
    const b = await seedChurch({
      churchId: pcoChurchId(bOrganizationId),
      people: [{ personId: 'ana', name: 'Ana in church B' }],
      channels: [
        { channelId: 'sunday-team', name: 'Sunday team', kind: 'open' },
        { channelId: 'youth-leaders', name: 'Youth leaders', kind: 'open' },
      ],
    })
    const run = await signIn(planningCenter, { organizationId: a.organizationId, personId: 'ana' })
    const { token } = JSON.parse(run.sessionBody) as SignInSession
    return { token, a: a.churchId, b: b.churchId }
  }

  it("cannot read the other church's channel history", async () => {
    const { token } = await signedInToChurchA()

    const response = await asSession(token, '/channels/youth-leaders/messages')

    expect(response.status).toBe(404)
  })

  it("cannot open the other church's channel socket", async () => {
    const { token } = await signedInToChurchA()

    const response = await asSession(token, '/channels/youth-leaders/socket', {
      headers: { upgrade: 'websocket' },
    })

    expect(response.status).toBe(404)
    expect(response.webSocket).toBeNull()
  })

  it("lists only the session's own church's channels", async () => {
    const { token } = await signedInToChurchA()

    const response = await asSession(token, '/channels')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
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

  it("reads its own church's channel of a shared ID, not the other church's", async () => {
    const { token, b } = await signedInToChurchA()
    const bo = await asMember(b, 'ana', '/channels/sunday-team/socket', {
      headers: { upgrade: 'websocket' },
    })
    bo.webSocket?.accept()
    bo.webSocket?.send(JSON.stringify({ type: 'send', body: 'Only for church B' }))
    await new Promise<void>((resolve) => bo.webSocket?.addEventListener('message', () => resolve()))
    bo.webSocket?.close(1000, 'test done')

    const response = await asSession(token, '/channels/sunday-team/messages')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ messages: [], authors: [] })
  })

  it("cannot reach the other church by putting its ID in front of the session's secret", async () => {
    const { token, b } = await signedInToChurchA()
    const secret = token.slice(token.lastIndexOf('.') + 1)

    const response = await asSession(`${b}.${secret}`, '/me')

    expect(response.status).toBe(401)
  })
})

describe('a request with a session the Worker never issued', () => {
  it.each([
    ['no token', undefined],
    ['a malformed token', 'Bearer not-a-session'],
    ['a test identity', 'Bearer test:pco-1:ana'],
    ['a well-formed token never issued', `Bearer pco-1.${'a'.repeat(43)}`],
  ])('is refused with %s', async (_label, authorization) => {
    const response = await fetchDeployed(
      '/me',
      authorization === undefined ? {} : { headers: { authorization } },
    )

    expect(response.status).toBe(401)
  })

  it.each([
    ['/me', {}],
    ['/channels', {}],
    ['/channels/sunday-team/messages', {}],
    ['/channels/sunday-team/socket', { upgrade: 'websocket' }],
  ])('leaves no directory behind for the church a token makes up, on %s', async (path, headers) => {
    const churchId = `made-up-${crypto.randomUUID()}`

    const response = await fetchDeployed(path, {
      headers: { ...headers, authorization: `Bearer ${churchId}.${'a'.repeat(43)}` },
    })

    expect(response.status).toBe(401)
    expect(await directoryTables(churchId)).toEqual([])
  })
})

/**
 * The tables in a church's directory object. An object that never writes its storage ceases to
 * exist when it shuts down, so an empty list means a lookup left nothing behind.
 */
function directoryTables(churchId: string): Promise<string[]> {
  return runInDurableObject(env.CHURCH_DIRECTORY.getByName(churchId), (_directory, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray()
      .map((row) => row.name),
  )
}

describe('every request to Planning Center', () => {
  it.each([
    ['a sign-in that succeeds', 'ana', 200],
    ['a sign-in Phon refuses', 'stranger', 403],
  ])('carries the User-Agent, in %s', async (_label, personId, status) => {
    const planningCenter = fakePlanningCenter()
    const { organizationId } = await seedPlanningCenterChurch([
      { personId: 'ana', name: 'Ana Ortiz' },
    ])

    const run = await signIn(planningCenter, { organizationId, personId })

    expect(run.session.status).toBe(status)
    const calls = network.calls().filter((call) => call.url.startsWith(`${PLANNING_CENTER}/`))
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.headers['user-agent']).toBe('Phon (https://phon.chat)')
  })
})
