import type {
  EmailCodeCheck,
  EmailCodeRequest,
  EmailNameChoice,
  EmailPersonChoice,
  EmailSignInRefusal,
  SignInSession,
} from '@phon/api-types'
import { type Mailer, signInCodeEmail } from './mailer.ts'
import { findEmailOwners } from './planning-center.ts'
import { CHOICE_TOKEN, CHURCH_ID, hashToken, newChoiceToken, newSession } from './session.ts'
import { methodNotAllowed, NO_STORE } from './sign-in.ts'

/**
 * Email code sign-in, for a person whose only Planning Center login is Church Center, which
 * Planning Center's OAuth page cannot sign in.
 *
 * - `POST /auth/email/code` looks the address up live in the church's Planning Center People
 *   with its sync account's token, and emails a 6-digit code when it belongs to a person the
 *   church directory knows. Every request gets the same 204, whatever the address, so the answer
 *   never tells who is on a church's profiles. The email is sent after the answer, so its send
 *   time never shows in the answer's. Only a Planning Center failure, or a church that has spent
 *   its lookups for now, answers 503.
 * - `POST /auth/email/session` checks the code and answers a Phon session, the same one the
 *   Planning Center sign-in starts. When several people the church knows share the address, the
 *   right code answers their names and a short-lived choice token instead. Every failure gets the
 *   same 400, except that a church past its limit on wrong codes answers every check 503 try-again
 *   for up to an hour, the right code included.
 * - `POST /auth/email/choice` takes that token and the person ID picked, and answers the session
 *   of that person. The same choice posted again within a minute, as a retry after a lost answer
 *   does, answers that person a new session; any other use of a token that signed someone in is
 *   refused. Every failure gets the same 400, and the person starts over with a new code.
 *
 * Each route has the limits for each caller of `src/caller-limits.ts`, which answer 429 before the
 * body is read, so a limited caller gets the same answer whatever address or code it sent.
 *
 * No address is stored: the directory keeps the HMAC-SHA-256 of `<churchId>:<lowercased address>`,
 * and of the code, under the Worker secret `EMAIL_HASH_KEY`. A plain hash of six digits, or of a
 * guessed address, is confirmed by hashing it again; a keyed one is not, so a leaked directory
 * confirms no guessed address and no code. A missing or empty key fails the code and session
 * routes with an error that names `EMAIL_HASH_KEY`.
 */

/** The longest email address there is (RFC 5321's path limit, less its angle brackets). */
const MAX_ADDRESS = 254
/** One `@`, text on both sides, and no whitespace or control character. */
const ADDRESS = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+$/u
const CODE = /^\d{6}$/
/** The longest person ID a name choice takes. */
const MAX_PERSON_ID = 64

/** Answers an email sign-in route, or null when the request is for neither. */
export async function emailSignInRoute(
  request: Request,
  env: Env,
  mailer: Mailer,
  ctx: ExecutionContext,
): Promise<Response | null> {
  switch (new URL(request.url).pathname) {
    case '/auth/email/code':
      return request.method === 'POST' ? requestCode(request, env, mailer, ctx) : methodNotAllowed()
    case '/auth/email/session':
      return request.method === 'POST' ? checkCode(request, env) : methodNotAllowed()
    case '/auth/email/choice':
      return request.method === 'POST' ? choosePerson(request, env) : methodNotAllowed()
    default:
      return null
  }
}

/**
 * Sends a sign-in code when the address belongs to one or more people the church knows. A
 * malformed request, a church with no sync account, an address Planning Center does not hold, one
 * held only by people the church does not know and one at its send limit all answer exactly what a
 * sent code answers. Every address of a connected church is looked up the same way, and the email
 * is sent through `ctx.waitUntil` after the answer, so neither the answer nor the work before it
 * waits on a send. The one wait a known address still adds is the directory call that issues its
 * code, which an address Planning Center does not hold for a known person skips.
 */
async function requestCode(
  request: Request,
  env: Env,
  mailer: Mailer,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readCodeRequest(request)
  if (body === null) return sent()
  const { churchId, address } = body
  const addressHash = await hashAddress(env, churchId, address)
  const directory = env.CHURCH_DIRECTORY.getByName(churchId)

  let accessToken: string | null
  try {
    accessToken = await directory.syncAccessToken(churchId)
  } catch (error) {
    console.error(`Refreshing ${churchId}'s sync token for an email code failed`, error)
    return tryAgain()
  }
  if (accessToken === null) return sent()
  if (!(await directory.takeEmailLookup(churchId))) return tryAgain()

  let owners: string[]
  try {
    owners = await findEmailOwners(address, accessToken)
  } catch (error) {
    console.error(`Looking an email address up in ${churchId}'s Planning Center failed`, error)
    return tryAgain()
  }
  if (owners.length === 0) return sent()

  const code = randomCode()
  const issued = await directory.issueEmailCode(
    churchId,
    addressHash,
    owners,
    await keyedHash(env, code),
  )
  if (issued === 'issued') {
    // The send runs after the answer, and a failed one only logs: waiting on it, or answering
    // differently when it fails, would tell that the address is known.
    ctx.waitUntil(
      mailer(signInCodeEmail(address, code), env).catch((error: unknown) => {
        console.error(`Sending an email sign-in code for ${churchId} failed`, error)
      }),
    )
  }
  return sent()
}

/**
 * Starts a session for the right code when one known person holds the address, answers the names
 * and a choice token when several do, answers `try-again` to any check at a church past its limit
 * on wrong codes, and answers `wrong-code` for anything else.
 */
async function checkCode(request: Request, env: Env): Promise<Response> {
  const body = await readCodeCheck(request)
  if (body === null) return wrongCode()
  const { churchId, address, code } = body
  const { token, tokenHash } = await newSession(churchId)
  const choice = await newChoiceToken()
  const checked = await env.CHURCH_DIRECTORY.getByName(churchId).checkEmailCode(
    churchId,
    await hashAddress(env, churchId, address),
    await keyedHash(env, code),
    tokenHash,
    choice.tokenHash,
  )
  if (checked === 'wrong') return wrongCode()
  if (checked === 'limited') return tryAgain()
  if (checked === 'started') {
    return Response.json({ token } satisfies SignInSession, { headers: NO_STORE })
  }
  return Response.json(
    { choiceToken: choice.token, people: checked.people } satisfies EmailNameChoice,
    { headers: NO_STORE },
  )
}

/**
 * Starts the session of the person picked with a name choice token, and answers `start-over` for
 * anything else.
 */
async function choosePerson(request: Request, env: Env): Promise<Response> {
  const body = await readPersonChoice(request)
  if (body === null) return startOver()
  const { churchId, choiceToken, personId } = body
  const { token, tokenHash } = await newSession(churchId)
  const chosen = await env.CHURCH_DIRECTORY.getByName(churchId).chooseEmailPerson(
    churchId,
    await hashToken(choiceToken),
    personId,
    tokenHash,
  )
  if (chosen !== 'started') return startOver()
  return Response.json({ token } satisfies SignInSession, { headers: NO_STORE })
}

/** A name choice's church, token and person, or null when any is malformed. */
async function readPersonChoice(request: Request): Promise<EmailPersonChoice | null> {
  const body = await readJsonObject(request)
  if (body === null) return null
  const { churchId, choiceToken, personId } = body
  if (typeof churchId !== 'string' || !CHURCH_ID.test(churchId)) return null
  if (typeof choiceToken !== 'string' || !CHOICE_TOKEN.test(choiceToken)) return null
  if (typeof personId !== 'string' || personId.length === 0 || personId.length > MAX_PERSON_ID) {
    return null
  }
  return { churchId, choiceToken, personId }
}

/** The church and the trimmed address of a code request, or null when either is malformed. */
async function readCodeRequest(request: Request): Promise<EmailCodeRequest | null> {
  const body = await readJsonObject(request)
  return body === null ? null : churchAndAddress(body)
}

/** A code request's fields and a 6-digit code, or null when any is malformed. */
async function readCodeCheck(request: Request): Promise<EmailCodeCheck | null> {
  const body = await readJsonObject(request)
  if (body === null) return null
  const asked = churchAndAddress(body)
  const { code } = body
  if (asked === null || typeof code !== 'string' || !CODE.test(code)) return null
  return { ...asked, code }
}

function churchAndAddress(body: Record<string, unknown>): EmailCodeRequest | null {
  const { churchId, address } = body
  if (typeof churchId !== 'string' || !CHURCH_ID.test(churchId)) return null
  if (typeof address !== 'string') return null
  const trimmed = address.trim()
  if (trimmed.length > MAX_ADDRESS || !ADDRESS.test(trimmed)) return null
  return { churchId, address: trimmed }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The hash an address is stored by: one church's, ignoring case. */
function hashAddress(env: Env, churchId: string, address: string): Promise<string> {
  return keyedHash(env, `${churchId}:${address.toLowerCase()}`)
}

/** The HMAC-SHA-256 of a text under the `EMAIL_HASH_KEY` secret's UTF-8 bytes, hex encoded. */
async function keyedHash(env: Env, text: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(emailHashKey(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The `EMAIL_HASH_KEY` secret. Throws an error that names it when it is missing or empty, which
 * `wrangler dev` allows with only a warning, in place of Web Crypto's bare `DataError`.
 */
function emailHashKey(env: Env): string {
  const key: unknown = env.EMAIL_HASH_KEY
  if (typeof key === 'string' && key !== '') return key
  throw new Error(
    'EMAIL_HASH_KEY is missing or empty, so email code sign-in cannot hash an address or a code. ' +
      'For wrangler dev, set it in the local env that `pnpm dev:server` reads (see .env.example); ' +
      'on the deployed Worker, push it from phon/prod.env in the secrets repo.',
  )
}

/** Six uniformly random digits. */
function randomCode(): string {
  // The largest multiple of a million below 2^32: a draw at or above it is redrawn, so every
  // code is equally likely.
  const bound = Math.floor(2 ** 32 / 1_000_000) * 1_000_000
  for (;;) {
    const draw = crypto.getRandomValues(new Uint32Array(1))[0] as number
    if (draw < bound) return String(draw % 1_000_000).padStart(6, '0')
  }
}

function sent(): Response {
  return new Response(null, { status: 204, headers: NO_STORE })
}

function tryAgain(): Response {
  return Response.json({ problem: 'try-again' } satisfies EmailSignInRefusal, {
    status: 503,
    headers: NO_STORE,
  })
}

function startOver(): Response {
  return Response.json({ problem: 'start-over' } satisfies EmailSignInRefusal, {
    status: 400,
    headers: NO_STORE,
  })
}

function wrongCode(): Response {
  return Response.json({ problem: 'wrong-code' } satisfies EmailSignInRefusal, {
    status: 400,
    headers: NO_STORE,
  })
}
