import type { Authenticate } from './identity.ts'

/**
 * Phon sessions. A session token is `<churchId>.<32 random bytes, base64url>`. The church part
 * routes the lookup to that church's directory; only the token's SHA-256 is stored there, so a
 * leaked directory yields no live session.
 */

const SECRET = /^[A-Za-z0-9_-]{43}$/
/** An email name choice token: the same 32 random bytes as a session's secret, with no church. */
export const CHOICE_TOKEN = SECRET
/** A church ID, as a session token and an email sign-in name it. */
export const CHURCH_ID = /^[A-Za-z0-9-]{1,64}$/

/** A new session token for a church, and the hash its directory stores. */
export async function newSession(churchId: string): Promise<{ token: string; tokenHash: string }> {
  const token = `${churchId}.${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
  return { token, tokenHash: await hashToken(token) }
}

/**
 * A new email name choice token, and the hash the church directory stores. It names no church:
 * the choice request names it.
 */
export async function newChoiceToken(): Promise<{ token: string; tokenHash: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return { token, tokenHash: await hashToken(token) }
}

/** The SHA-256 of a session token, hex encoded. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The session token of `Authorization: Bearer <session token>`, as the church it names and the
 * hash its directory stores, or null when the header holds no well-formed session token.
 */
async function sessionToken(
  request: Request,
): Promise<{ churchId: string; tokenHash: string } | null> {
  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
  if (match === null) return null
  const token = match[1] as string
  const dot = token.lastIndexOf('.')
  const churchId = token.slice(0, dot)
  if (dot < 0 || !CHURCH_ID.test(churchId) || !SECRET.test(token.slice(dot + 1))) return null
  return { churchId, tokenHash: await hashToken(token) }
}

/**
 * The deployed authenticator: `Authorization: Bearer <session token>` names the person whose
 * session it is, while it is within its lifetime and their church's directory still knows them.
 * Anything else is no one.
 */
export const sessions: Authenticate = async (request, env) => {
  const session = await sessionToken(request)
  if (session === null) return null
  const { churchId, tokenHash } = session
  const personId = await env.CHURCH_DIRECTORY.getByName(churchId).sessionIdentity(
    churchId,
    tokenHash,
  )
  return personId === null ? null : { churchId, personId }
}

/**
 * `POST /me/sign-out`: ends the session it is sent with, and with a `SignOutRequest` device token
 * of the session's person, stops alerting that phone. Answers 204, or 401 when there is no such
 * session to end, so a test identity, which holds none, gets 401 too. Null for any other path.
 */
export async function signOutRoute(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/me/sign-out') return null
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const session = await sessionToken(request)
  if (session === null) return new Response('Sign in first', { status: 401 })

  const body = await request.text()
  let deviceToken: string | undefined
  if (body !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return new Response('Bad request', { status: 400 })
    }
    const named = (parsed as Record<string, unknown>).deviceToken
    if (named !== undefined && typeof named !== 'string') {
      return new Response('Bad request', { status: 400 })
    }
    deviceToken = named
  }

  const ended = await env.CHURCH_DIRECTORY.getByName(session.churchId).endSession(
    session.churchId,
    session.tokenHash,
    deviceToken,
  )
  return ended === 'ended'
    ? new Response(null, { status: 204 })
    : new Response('Sign in first', { status: 401 })
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
