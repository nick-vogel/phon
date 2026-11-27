import type {
  ChurchConnectRefusal,
  EmailCodeCheck,
  EmailCodeRequest,
  EmailPersonChoice,
  SignInRefusal,
  SignInRequest,
  SignInSession,
} from '@phon/api-types'
import * as Crypto from 'expo-crypto'
import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import { createSession } from './client'
import { apiOrigin } from './config'
import {
  type ChurchListOutcome,
  type CodeRequestOutcome,
  checkCode,
  choosePerson,
  listChurches,
  type NameChoicePerson,
  requestCode,
} from './email-sign-in'
import { saveSession } from './session'
import { connectSync, type SyncConnectOutcome } from './sync-account'

/** Where the server's sign-in callback sends the browser back to the app. */
const SIGN_IN_RETURN_URL = 'phon://sign-in'

/** Where the server's sync account connect callback sends the browser back to the app. */
const CONNECT_RETURN_URL = 'phon://connect'

/**
 * How a sign-in ended, as the browser and the server said: signed in, a person the church does
 * not know yet, closed by the person, or anything else that went wrong.
 */
export type SignInOutcome = 'signed-in' | 'not-known' | 'cancelled' | 'failed'

/**
 * Signs in with Planning Center. The app makes the PKCE verifier, the state and the nonce, opens
 * the server's start route in an auth session, and sends the code it gets back to the server,
 * which answers a Phon session. No Planning Center token ever reaches the app.
 */
export async function signIn(): Promise<SignInOutcome> {
  const authorized = await authorize('/auth/start', SIGN_IN_RETURN_URL)
  if (typeof authorized === 'string') return authorized
  const answer = await createSession(authorized, '/auth/session')
  if (answer.status === 200) {
    await saveSession((answer.body as SignInSession).token)
    return 'signed-in'
  }
  if (answer.status === 403 && (answer.body as SignInRefusal | null)?.problem === 'not-known') {
    return 'not-known'
  }
  return 'failed'
}

/**
 * How connecting a church ended: connected and signed in as its first admin, refused because the
 * person is not a Planning Center administrator or because the church already has an admin,
 * closed by the person, or anything else that went wrong.
 */
export type ConnectOutcome =
  | 'signed-in'
  | 'not-administrator'
  | 'already-connected'
  | 'cancelled'
  | 'failed'

/**
 * Connects the person's church to Phon: the same Planning Center sign-in, which the server lets
 * through only for an organization administrator of a church with no admin yet. That person
 * becomes the church's first admin and is signed in.
 */
export async function connectChurch(): Promise<ConnectOutcome> {
  const authorized = await authorize('/auth/connect/start', SIGN_IN_RETURN_URL)
  if (typeof authorized === 'string') return authorized
  const answer = await createSession(authorized, '/auth/connect')
  if (answer.status === 200) {
    await saveSession((answer.body as SignInSession).token)
    return 'signed-in'
  }
  const problem = (answer.body as ChurchConnectRefusal | null)?.problem
  if (answer.status === 403 && problem === 'not-administrator') return 'not-administrator'
  if (answer.status === 409 && problem === 'already-connected') return 'already-connected'
  return 'failed'
}

/**
 * Connects the church's sync account: the dedicated Planning Center account, on a church email
 * address, that the roster sync reads with. The server lets it through only for an organization
 * administrator and stores its tokens. Saves no session: a sync connect signs no one in.
 */
export async function connectSyncAccount(): Promise<SyncConnectOutcome | 'cancelled'> {
  const authorized = await authorize('/connect/start', CONNECT_RETURN_URL)
  if (typeof authorized === 'string') return authorized
  const origin = originOrNull()
  return origin === null ? 'failed' : connectSync(fetch, origin, authorized)
}

/** The connected churches an email code sign-in picks from. */
export function churchesForEmailSignIn(): Promise<ChurchListOutcome> {
  const origin = originOrNull()
  return origin === null ? Promise.resolve({ outcome: 'try-again' }) : listChurches(fetch, origin)
}

/** Asks the server to email a sign-in code to an address at a church. */
export function sendEmailCode(request: EmailCodeRequest): Promise<CodeRequestOutcome> {
  const origin = originOrNull()
  return origin === null
    ? Promise.resolve({ outcome: 'try-again' })
    : requestCode(fetch, origin, request)
}

/**
 * How an email code sign-in ended. `choose` when several people share the address: nothing is
 * saved yet, and `signInAsChosenPerson` finishes the sign-in once the person picks their name.
 */
export type EmailSignInOutcome =
  | 'signed-in'
  | 'wrong-code'
  | 'wait'
  | 'try-again'
  | { outcome: 'choose'; choiceToken: string; people: NameChoicePerson[] }

/**
 * Signs in with the code from the email, and saves the session as the Planning Center sign-in
 * does, so the layout's guards then show the channels.
 */
export async function signInWithEmailCode(check: EmailCodeCheck): Promise<EmailSignInOutcome> {
  const origin = originOrNull()
  if (origin === null) return 'try-again'
  const checked = await checkCode(fetch, origin, check)
  if (checked.outcome === 'choose') return checked
  if (checked.outcome !== 'signed-in') return checked.outcome
  await saveSession(checked.token)
  return 'signed-in'
}

/**
 * Signs in as the person picked after a code for a shared address, and saves the session as
 * `signInWithEmailCode` does. `start-over` when the server refused the choice.
 */
export async function signInAsChosenPerson(
  choice: EmailPersonChoice,
): Promise<'signed-in' | 'start-over' | 'wait' | 'try-again'> {
  const origin = originOrNull()
  if (origin === null) return 'try-again'
  const chosen = await choosePerson(fetch, origin, choice)
  if (chosen.outcome !== 'signed-in') return chosen.outcome
  await saveSession(chosen.token)
  return 'signed-in'
}

function originOrNull(): string | null {
  try {
    return apiOrigin()
  } catch {
    return null
  }
}

/**
 * Plays the browser part of one Planning Center authorization: makes the PKCE verifier, the state
 * and the nonce, opens the server's start route in an auth session, and checks the state on the
 * way back. Answers the code, the verifier and the nonce for the caller to post, or how the
 * browser part ended when it did not finish.
 */
async function authorize(
  startPath: '/auth/start' | '/auth/connect/start' | '/connect/start',
  returnUrl: typeof SIGN_IN_RETURN_URL | typeof CONNECT_RETURN_URL,
): Promise<SignInRequest | 'cancelled' | 'failed'> {
  const codeVerifier = randomHex(32)
  const state = randomHex(16)
  const nonce = randomHex(16)
  const codeChallenge = await s256(codeVerifier)

  let startUrl: string
  try {
    startUrl = `${apiOrigin()}${startPath}?${query({ code_challenge: codeChallenge, state, nonce })}`
  } catch {
    return 'failed'
  }

  const result = await WebBrowser.openAuthSessionAsync(startUrl, returnUrl)
  if (result.type === 'cancel' || result.type === 'dismiss') return 'cancelled'
  if (result.type !== 'success') return 'failed'

  const params = Linking.parse(result.url).queryParams ?? {}
  if (params.state !== state || typeof params.code !== 'string' || params.code === '') {
    return 'failed'
  }

  return { code: params.code, codeVerifier, nonce }
}

/** `byteCount` random bytes as hex: unreserved URL characters, valid as a verifier or a state. */
function randomHex(byteCount: number): string {
  return Array.from(Crypto.getRandomBytes(byteCount), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/** The S256 PKCE challenge: the SHA-256 of the verifier in base64url, with no padding. */
async function s256(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  })
  return digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&')
}
