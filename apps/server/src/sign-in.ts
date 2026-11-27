import type {
  ChurchConnectRefusal,
  SignInRefusal,
  SignInRequest,
  SignInSession,
} from '@phon/api-types'
import {
  authorizeUrl,
  exchangeCode,
  exchangeCodeForTokens,
  isOrganizationAdministrator,
} from './planning-center.ts'
import { newSession } from './session.ts'

/**
 * The sign-in routes. The Worker keeps no state between them: the app makes the PKCE verifier,
 * the state and the nonce, and the code Planning Center returns is useless without both the
 * client secret and the app's verifier.
 *
 * - `GET /auth/start` sends the browser to Planning Center's authorize page.
 * - `GET /auth/callback` sends Planning Center's answer back to the app at `phon://sign-in`.
 * - `POST /auth/session` exchanges the code and answers a Phon session.
 *
 * Connecting a church, which names its first admin, is the same flow with the People scope added:
 * `GET /auth/connect/start`, the same callback, and `POST /auth/connect`.
 */

/** What connecting a church asks for: who the person is, and People for the administrator check. */
export const CHURCH_CONNECT_SCOPE = 'openid people'

/** Where the callback sends the browser: the app's own scheme, never a URL the caller names. */
export const APP_RETURN_URL = 'phon://sign-in'

/** An S256 PKCE challenge: the base64url SHA-256 of the verifier, 43 characters. */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
/** A state or a nonce: 16 to 128 unreserved URL characters. */
const OPAQUE_VALUE = /^[A-Za-z0-9._~-]{16,128}$/

/** Answers a sign-in route, or null when the request is for no sign-in route. */
export async function signInRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  switch (url.pathname) {
    case '/auth/start':
      return request.method === 'GET' ? start(url, env) : methodNotAllowed()
    case '/auth/callback':
      return request.method === 'GET' ? callback(url) : methodNotAllowed()
    case '/auth/session':
      return request.method === 'POST' ? session(request, url, env) : methodNotAllowed()
    case '/auth/connect/start':
      return request.method === 'GET' ? start(url, env, CHURCH_CONNECT_SCOPE) : methodNotAllowed()
    case '/auth/connect':
      return request.method === 'POST' ? connectChurch(request, url, env) : methodNotAllowed()
    default:
      return null
  }
}

function start(url: URL, env: Env, scope?: string): Response {
  const parameters = readStartParameters(url)
  if (parameters === null) {
    return new Response('A sign-in needs a code_challenge, a state and a nonce', { status: 400 })
  }
  return redirect(
    authorizeUrl({
      clientId: env.PCO_CLIENT_ID,
      redirectUri: callbackUrl(url),
      ...parameters,
      ...(scope === undefined ? {} : { scope }),
    }),
  )
}

/** What the app sends to a start route: its PKCE challenge, its state and its nonce. */
export interface StartParameters {
  codeChallenge: string
  state: string
  nonce: string
}

/** A start route's PKCE challenge, state and nonce, or null when any is missing or malformed. */
export function readStartParameters(url: URL): StartParameters | null {
  const codeChallenge = url.searchParams.get('code_challenge') ?? ''
  const state = url.searchParams.get('state') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''
  if (
    !CODE_CHALLENGE.test(codeChallenge) ||
    !OPAQUE_VALUE.test(state) ||
    !OPAQUE_VALUE.test(nonce)
  ) {
    return null
  }
  return { codeChallenge, state, nonce }
}

function callback(url: URL): Response {
  return returnToApp(APP_RETURN_URL, url)
}

/**
 * Sends Planning Center's answer to the app: the code and the state, or the error and the state.
 * Nothing else crosses, and the return URL is fixed, so a callback is no open redirect.
 */
export function returnToApp(appReturnUrl: string, url: URL): Response {
  const back = new URLSearchParams()
  const error = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  if (error !== null) back.set('error', error)
  else if (code !== null) back.set('code', code)
  const state = url.searchParams.get('state')
  if (state !== null) back.set('state', state)
  return redirect(`${appReturnUrl}?${back}`)
}

/**
 * The one mapping from a Planning Center organization to a Phon church ID. A church Phon has no
 * directory for knows no one, so its people are refused like strangers.
 */
export function churchIdFor(organizationId: string): string {
  return `pco-${organizationId}`
}

/**
 * Exchanges the app's code for who signed in, and starts a Phon session when that person's
 * church knows them. No Planning Center token leaves this function.
 */
async function session(request: Request, url: URL, env: Env): Promise<Response> {
  const body = await readCodeRequest(request)
  if (body === null) return refuse('sign-in-failed', 400)

  const person = await exchangeCode({
    ...body,
    redirectUri: callbackUrl(url),
    clientId: env.PCO_CLIENT_ID,
    clientSecret: env.PCO_CLIENT_SECRET,
  })
  if (person === null) return refuse('sign-in-failed', 400)

  const churchId = churchIdFor(person.organizationId)
  const { token, tokenHash } = await newSession(churchId)
  const started = await env.CHURCH_DIRECTORY.getByName(churchId).startSession(
    { churchId, personId: person.personId },
    tokenHash,
  )
  // The person has just proved who they are to Planning Center, so saying Phon does not know them
  // leaks nothing, and the app can tell "ask your church" apart from "try again".
  if (started === 'not-known') return refuse('not-known', 403)
  return Response.json({ token } satisfies SignInSession, { headers: NO_STORE })
}

/**
 * Connects a church: a Planning Center organization administrator signs in with their own
 * account, and when their church has no admin yet they become its first admin and get a session.
 * Anyone else is refused and granted nothing. The Planning Center tokens are dropped here, once
 * the administrator check has read with the access token.
 */
async function connectChurch(request: Request, url: URL, env: Env): Promise<Response> {
  const body = await readCodeRequest(request)
  if (body === null) return refuseConnect('sign-in-failed', 400)

  const exchanged = await exchangeCodeForTokens({
    ...body,
    redirectUri: callbackUrl(url),
    clientId: env.PCO_CLIENT_ID,
    clientSecret: env.PCO_CLIENT_SECRET,
  })
  if (exchanged === null || exchanged.tokens === null) return refuseConnect('sign-in-failed', 400)
  const { person, tokens } = exchanged
  if (!(await isOrganizationAdministrator(tokens.accessToken))) {
    return refuseConnect('not-administrator', 403)
  }

  const churchId = churchIdFor(person.organizationId)
  const { token, tokenHash } = await newSession(churchId)
  const connected = await env.CHURCH_DIRECTORY.getByName(churchId).connectChurch(
    { churchId, personId: person.personId },
    person.name ?? person.personId,
    tokenHash,
  )
  if (connected === 'already-connected') return refuseConnect('already-connected', 409)
  return Response.json({ token } satisfies SignInSession, { headers: NO_STORE })
}

function refuseConnect(problem: ChurchConnectRefusal['problem'], status: 400 | 403 | 409) {
  return Response.json({ problem } satisfies ChurchConnectRefusal, { status, headers: NO_STORE })
}

/** The code, verifier and nonce the app posts once Planning Center sent it back, or null. */
export async function readCodeRequest(request: Request): Promise<SignInRequest | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { code, codeVerifier, nonce } = body as Record<string, unknown>
  if (typeof code !== 'string' || typeof codeVerifier !== 'string' || typeof nonce !== 'string') {
    return null
  }
  if (code === '' || codeVerifier === '' || nonce === '') return null
  return { code, codeVerifier, nonce }
}

export const NO_STORE = { 'cache-control': 'no-store' }

function refuse(problem: SignInRefusal['problem'], status: 400 | 403): Response {
  return Response.json({ problem } satisfies SignInRefusal, { status, headers: NO_STORE })
}

/** The Worker's own callback URL, which Planning Center redirects to and the exchange repeats. */
function callbackUrl(url: URL): string {
  return `${url.origin}/auth/callback`
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, ...NO_STORE } })
}

export function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}
