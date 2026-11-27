import type {
  ChurchList,
  ConnectedChurch,
  EmailCodeCheck,
  EmailCodeRequest,
  EmailNameChoice,
  EmailPersonChoice,
  SignInSession,
} from '@phon/api-types'

/**
 * The email code sign-in's server calls, for a person whose only Planning Center login is Church
 * Center. Each takes the fetch to call with and the API origin, so a test runs it with a stub.
 * Each maps every server answer, and a call that never reached the server, to an outcome.
 */

/** The fetch these calls use: the global one in the app, a stub in a test. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type ChurchListOutcome =
  | { outcome: 'listed'; churches: ConnectedChurch[] }
  | { outcome: 'wait' }
  | { outcome: 'try-again' }

/** The connected churches to pick from (`GET /churches`). */
export async function listChurches(fetch: Fetch, origin: string): Promise<ChurchListOutcome> {
  try {
    const response = await fetch(`${origin}/churches`, { method: 'GET' })
    if (response.status === 429) return { outcome: 'wait' }
    if (response.status !== 200) return { outcome: 'try-again' }
    const body = (await response.json()) as Partial<ChurchList> | null
    if (!Array.isArray(body?.churches)) return { outcome: 'try-again' }
    return { outcome: 'listed', churches: body.churches }
  } catch {
    return { outcome: 'try-again' }
  }
}

/**
 * How a code request ended. `sent` whatever the address: the server answers the same for an
 * address it does not know, so the app never knows either. `wait` when this phone's address is
 * past its limit for the minute (the server's 429), and the person waits before trying again.
 */
export type CodeRequestOutcome =
  | { outcome: 'sent' }
  | { outcome: 'wait' }
  | { outcome: 'try-again' }

/** Asks for a sign-in code by email (`POST /auth/email/code`). */
export async function requestCode(
  fetch: Fetch,
  origin: string,
  request: EmailCodeRequest,
): Promise<CodeRequestOutcome> {
  try {
    const response = await postJson(fetch, `${origin}/auth/email/code`, request)
    if (response.status === 429) return { outcome: 'wait' }
    return response.status === 204 ? { outcome: 'sent' } : { outcome: 'try-again' }
  } catch {
    return { outcome: 'try-again' }
  }
}

/** A person to pick after a right code for an address several people share. */
export type NameChoicePerson = EmailNameChoice['people'][number]

/**
 * How a code check ended. `choose` when several people share the address: the person picks their
 * name, and `choosePerson` signs them in.
 */
export type CodeCheckOutcome =
  | { outcome: 'signed-in'; token: string }
  | { outcome: 'choose'; choiceToken: string; people: NameChoicePerson[] }
  | { outcome: 'wrong-code' }
  | { outcome: 'wait' }
  | { outcome: 'try-again' }

/** Signs in with the code from the email (`POST /auth/email/session`). */
export async function checkCode(
  fetch: Fetch,
  origin: string,
  check: EmailCodeCheck,
): Promise<CodeCheckOutcome> {
  try {
    const response = await postJson(fetch, `${origin}/auth/email/session`, check)
    if (response.status === 400) return { outcome: 'wrong-code' }
    if (response.status === 429) return { outcome: 'wait' }
    if (response.status !== 200) return { outcome: 'try-again' }
    const body = (await response.json()) as Partial<SignInSession & EmailNameChoice> | null
    const token = body?.token
    if (typeof token === 'string' && token !== '') return { outcome: 'signed-in', token }
    const choiceToken = body?.choiceToken
    const people = body?.people
    if (typeof choiceToken === 'string' && choiceToken !== '' && arePeople(people)) {
      return { outcome: 'choose', choiceToken, people }
    }
    return { outcome: 'try-again' }
  } catch {
    return { outcome: 'try-again' }
  }
}

/** A name choice's people: at least two, each with a string person ID and name. */
function arePeople(people: unknown): people is NameChoicePerson[] {
  return (
    Array.isArray(people) &&
    people.length >= 2 &&
    people.every(
      (person: unknown) =>
        typeof person === 'object' &&
        person !== null &&
        typeof (person as Partial<NameChoicePerson>).personId === 'string' &&
        typeof (person as Partial<NameChoicePerson>).name === 'string',
    )
  )
}

/** How a name choice ended. `start-over` when the server refused it: the person needs a new code. */
export type PersonChoiceOutcome =
  | { outcome: 'signed-in'; token: string }
  | { outcome: 'start-over' }
  | { outcome: 'wait' }
  | { outcome: 'try-again' }

/** Signs in as the person picked after a code check answered `choose` (`POST /auth/email/choice`). */
export async function choosePerson(
  fetch: Fetch,
  origin: string,
  choice: EmailPersonChoice,
): Promise<PersonChoiceOutcome> {
  try {
    const response = await postJson(fetch, `${origin}/auth/email/choice`, choice)
    if (response.status === 400) return { outcome: 'start-over' }
    if (response.status === 429) return { outcome: 'wait' }
    if (response.status !== 200) return { outcome: 'try-again' }
    const token = ((await response.json()) as Partial<SignInSession> | null)?.token
    return typeof token === 'string' && token !== ''
      ? { outcome: 'signed-in', token }
      : { outcome: 'try-again' }
  } catch {
    return { outcome: 'try-again' }
  }
}

function postJson(fetch: Fetch, url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
