import type { SignInRequest, SignInSession } from '@phon/api-types'
import { expect } from 'vitest'
import { acceptSocket, type MemberSocket } from './church.ts'
import { fetchDeployed } from './deployed.ts'
import { type FakeSignIn, type fakePlanningCenter, pkce, randomPart } from './planning-center.ts'

type FakePlanningCenter = ReturnType<typeof fakePlanningCenter>

/** What the app sees across one sign-in or connect, played the way the app plays it. */
export interface AppRun {
  start: Response
  callback: Response
  /** The answer to the final `POST`. */
  session: Response
  /** The final answer's body as text, read once. */
  sessionBody: string
}

/**
 * Plays the app through a whole sign-in: start, Planning Center's authorize page (the fake), the
 * callback, and the session exchange. `spoil` changes what the app sends to `/auth/session`.
 */
export function signIn(
  planningCenter: FakePlanningCenter,
  person: FakeSignIn,
  spoil: (request: SignInRequest) => SignInRequest = (request) => request,
): Promise<AppRun> {
  return playAuthorization(planningCenter, person, spoil, {
    start: '/auth/start',
    final: '/auth/session',
    appReturnUrl: 'phon://sign-in',
  })
}

/**
 * Plays the app through connecting a church's sync account: `/connect/start`, the authorize page,
 * `/connect/callback` and `POST /connect`.
 */
export function connectSyncAccount(
  planningCenter: FakePlanningCenter,
  person: FakeSignIn,
  spoil: (request: SignInRequest) => SignInRequest = (request) => request,
): Promise<AppRun> {
  return playAuthorization(planningCenter, person, spoil, {
    start: '/connect/start',
    final: '/connect',
    appReturnUrl: 'phon://connect',
  })
}

/**
 * Plays the app through connecting a church, which names its first admin: `/auth/connect/start`,
 * the authorize page, the sign-in callback and `POST /auth/connect`.
 */
export function connectChurch(
  planningCenter: FakePlanningCenter,
  person: FakeSignIn,
  spoil: (request: SignInRequest) => SignInRequest = (request) => request,
): Promise<AppRun> {
  return playAuthorization(planningCenter, person, spoil, {
    start: '/auth/connect/start',
    final: '/auth/connect',
    appReturnUrl: 'phon://sign-in',
  })
}

async function playAuthorization(
  planningCenter: FakePlanningCenter,
  person: FakeSignIn,
  spoil: (request: SignInRequest) => SignInRequest,
  routes: { start: string; final: string; appReturnUrl: string },
): Promise<AppRun> {
  const { verifier, challenge } = await pkce()
  const state = randomPart()
  const nonce = randomPart()
  const start = await fetchDeployed(
    `${routes.start}?code_challenge=${challenge}&state=${state}&nonce=${nonce}`,
  )
  const returned = planningCenter.authorize(start.headers.get('location'), person)
  const callback = await fetchDeployed(`${returned.pathname}${returned.search}`)
  const back = new URL(callback.headers.get('location') ?? '')
  expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(routes.appReturnUrl)
  expect(back.searchParams.get('state')).toBe(state)

  const request: SignInRequest = {
    code: back.searchParams.get('code') ?? '',
    codeVerifier: verifier,
    nonce,
  }
  const session = await fetchDeployed(routes.final, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spoil(request)),
  })
  return { start, callback, session, sessionBody: await session.text() }
}

/** Sends a request to the deployed entry with a Phon session, on the Worker's bindings or others. */
export function asSession(token: string, path: string, init: RequestInit = {}, bindings?: Env) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return fetchDeployed(path, { ...init, headers }, bindings)
}

/** Signs a person in with Planning Center and answers their Phon session token. */
export async function signInAs(
  planningCenter: FakePlanningCenter,
  organizationId: number,
  personId: string,
): Promise<string> {
  const run = await signIn(planningCenter, { organizationId, personId })
  expect(run.session.status).toBe(200)
  return (JSON.parse(run.sessionBody) as SignInSession).token
}

/** Opens a channel's WebSocket through the deployed entry with a Phon session. */
export async function openSessionSocket(token: string, channelId: string): Promise<MemberSocket> {
  const response = await asSession(token, `/channels/${channelId}/socket`, {
    headers: { upgrade: 'websocket' },
  })
  return acceptSocket(response, channelId)
}

/** Everything the app saw: both redirects, and the final response's headers and body. */
export function seenByApp(run: AppRun): string {
  return [run.start, run.callback, run.session]
    .flatMap((response) => [...response.headers].map(([name, value]) => `${name}: ${value}`))
    .concat(run.sessionBody)
    .join('\n')
}

/**
 * The church ID Phon gives a Planning Center organization, written out here rather than taken from
 * the code under test, so a broken mapping cannot also make the expectation.
 */
export function pcoChurchId(organizationId: number | string): string {
  return `pco-${organizationId}`
}
