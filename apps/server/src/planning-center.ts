/**
 * Everything the Worker knows about Planning Center: its origin, its authorize URL, its token
 * endpoint, the administrator check, the organization's name, the paced collection reader, and the
 * one fetch every Planning Center call goes through.
 */

/** Planning Center's API origin, which is also the ID token's issuer. */
export const PLANNING_CENTER_ORIGIN = 'https://api.planningcenteronline.com'

/**
 * The User-Agent every Planning Center request carries. Planning Center asks for the app's name
 * and a link, and may answer 403 to a request with none.
 */
export const USER_AGENT = 'Phon (https://phon.chat)'

/** The one way the Worker calls Planning Center. It sets the User-Agent. */
export function planningCenterFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('user-agent', USER_AGENT)
  return fetch(`${PLANNING_CENTER_ORIGIN}${path}`, { ...init, headers })
}

export interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  nonce: string
  /** Space-separated OAuth scopes. Sign-in asks for `openid` only, the default. */
  scope?: string
}

/** Planning Center's authorize URL for an OpenID Connect sign-in with an S256 PKCE challenge. */
export function authorizeUrl(request: AuthorizeRequest): string {
  const url = new URL(`${PLANNING_CENTER_ORIGIN}/oauth/authorize`)
  url.search = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: 'code',
    scope: request.scope ?? 'openid',
    // A person in two organizations confirms which one they are signing in to.
    prompt: 'select_account',
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    state: request.state,
    nonce: request.nonce,
  }).toString()
  return url.toString()
}

export interface CodeExchange {
  code: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  clientId: string
  clientSecret: string
}

/** Who signed in, as the ID token says, and nothing else Planning Center sent. */
export interface PlanningCenterPerson {
  organizationId: string
  personId: string
  /** The ID token's `name`, or null when it carries none. */
  name: string | null
}

/** An access token, the refresh token that renews it, and when the access token expires. */
export interface PlanningCenterTokens {
  accessToken: string
  refreshToken: string
  /** Milliseconds since the epoch. */
  expiresAt: number
}

/**
 * Exchanges an authorization code at Planning Center's token endpoint and reads who signed in
 * from the ID token. Every Planning Center token in the answer is dropped here. Null when the
 * exchange is refused or the ID token is not for this sign-in.
 */
export async function exchangeCode(exchange: CodeExchange): Promise<PlanningCenterPerson | null> {
  return (await exchangeCodeForTokens(exchange))?.person ?? null
}

/**
 * Exchanges an authorization code, as `exchangeCode` does, and keeps the tokens too: only for the
 * sync account, whose tokens the roster sync reads with. `tokens` is null when the answer carried
 * no usable access and refresh token.
 *
 * The ID token's signature is not checked: it comes straight from the token endpoint over TLS,
 * which OpenID Connect Core 3.1.3.7 allows in place of the check. `iss`, `aud`, `exp` and
 * `nonce` are checked.
 */
export async function exchangeCodeForTokens(
  exchange: CodeExchange,
): Promise<{ person: PlanningCenterPerson; tokens: PlanningCenterTokens | null } | null> {
  const answer = await tokenRequest({
    grant_type: 'authorization_code',
    code: exchange.code,
    client_id: exchange.clientId,
    client_secret: exchange.clientSecret,
    redirect_uri: exchange.redirectUri,
    code_verifier: exchange.codeVerifier,
  })
  if (answer === null) return null

  const idToken = answer.id_token
  const claims = typeof idToken === 'string' ? decodeJwtPayload(idToken) : null
  if (claims === null) return null

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const organizationId = claims.organization_id
  if (
    claims.iss !== PLANNING_CENTER_ORIGIN ||
    !audience.includes(exchange.clientId) ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= Date.now() ||
    claims.nonce !== exchange.nonce ||
    typeof claims.sub !== 'string' ||
    claims.sub === '' ||
    (typeof organizationId !== 'number' && typeof organizationId !== 'string') ||
    String(organizationId) === ''
  ) {
    return null
  }
  return {
    person: {
      organizationId: String(organizationId),
      personId: claims.sub,
      name: typeof claims.name === 'string' && claims.name.trim() !== '' ? claims.name : null,
    },
    tokens: readTokens(answer),
  }
}

export interface Client {
  clientId: string
  clientSecret: string
}

/**
 * Renews an access token with its refresh token. Planning Center answers a new refresh token
 * every time, and the old one stops working, so the caller must store both before anything else.
 * Null when Planning Center refuses.
 */
export async function refreshTokens(
  refreshToken: string,
  client: Client,
): Promise<PlanningCenterTokens | null> {
  const answer = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  })
  return answer === null ? null : readTokens(answer)
}

/**
 * Whether the account an access token belongs to is a Planning Center organization administrator
 * (`site_administrator` on `GET /people/v2/me`). The one administrator check: connecting a sync
 * account uses it, and so does naming a church's first admin (phon#6). Anything but a clear yes,
 * a refused call included, is no.
 */
export async function isOrganizationAdministrator(accessToken: string): Promise<boolean> {
  let response: Response
  try {
    response = await planningCenterFetch('/people/v2/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
  } catch {
    return false
  }
  if (!response.ok) return false
  try {
    const body = (await response.json()) as {
      data?: { attributes?: { site_administrator?: unknown } }
    }
    return body.data?.attributes?.site_administrator === true
  } catch {
    return false
  }
}

/**
 * The name of the organization an access token belongs to (`GET /people/v2`, Planning Center
 * People's Organization), trimmed, or null when it has none. `options` go to `planningCenterGet`:
 * a read a person waits on passes `{ retries: 0, pace: false }`. Throws when the call fails.
 */
export async function readOrganizationName(
  accessToken: string,
  options: ReadOptions = {},
): Promise<string | null> {
  const read = await planningCenterGet('/people/v2', accessToken, options)
  const name = read.data[0]?.attributes?.name
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
}

/**
 * The Planning Center person IDs whose People profile holds an email address
 * (`GET /people/v2/emails?where[address]=`), primary or not, compared ignoring case, without
 * duplicates. A blocked address is left out. A person waits on this read, so neither a 429 nor an
 * answer that reports the rate limit reached makes it wait: a 429 throws at once. Throws when the
 * call fails.
 */
export async function findEmailOwners(address: string, accessToken: string): Promise<string[]> {
  const read = await planningCenterGet(
    `/people/v2/emails?${new URLSearchParams({ 'where[address]': address })}`,
    accessToken,
    { retries: 0, pace: false },
  )
  const asked = address.toLowerCase()
  const owners = new Set<string>()
  for (const email of read.data) {
    const held = email.attributes?.address
    const personId = email.relationships?.person?.data?.id
    if (
      email.type === 'Email' &&
      typeof held === 'string' &&
      held.trim().toLowerCase() === asked &&
      email.attributes?.blocked !== true &&
      typeof personId === 'string' &&
      personId !== ''
    ) {
      owners.add(personId)
    }
  }
  return [...owners]
}

/**
 * Sets a person's birthdate on their Planning Center People profile
 * (`PATCH /people/v2/people/:id`, JSON:API), with the sync account's access token. True only when
 * Planning Center answers 2xx; a refusal or a failed call is false.
 */
export async function updateBirthdate(
  personId: string,
  birthdate: string,
  accessToken: string,
): Promise<boolean> {
  try {
    const response = await planningCenterFetch(
      `/people/v2/people/${encodeURIComponent(personId)}`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ data: { type: 'Person', id: personId, attributes: { birthdate } } }),
      },
    )
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

/** The JSON object Planning Center's token endpoint answered, or null for a refusal. */
async function tokenRequest(form: Record<string, string>): Promise<Record<string, unknown> | null> {
  let response: Response
  try {
    response = await planningCenterFetch('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  try {
    const answer: unknown = await response.json()
    return typeof answer === 'object' && answer !== null
      ? (answer as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readTokens(answer: Record<string, unknown>): PlanningCenterTokens | null {
  const { access_token, refresh_token, expires_in } = answer
  if (
    typeof access_token !== 'string' ||
    access_token === '' ||
    typeof refresh_token !== 'string' ||
    refresh_token === '' ||
    typeof expires_in !== 'number'
  ) {
    return null
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: Date.now() + expires_in * 1000,
  }
}

/** One JSON:API record. */
export interface Resource {
  type: string
  id: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, { data?: { type: string; id: string } | null }>
}

/** Every record of a collection, across all its pages. */
export interface Collection {
  data: Resource[]
  included: Resource[]
}

/** How many times one call is repeated after a 429 before the read gives up. */
const RETRY_LIMIT = 5

export interface ReadOptions {
  /**
   * How many times one call is repeated after a 429, default 5. A read a person is waiting on
   * passes 0, so a rate limit throws at once instead of waiting.
   */
  retries?: number
  /**
   * Whether to wait out the rate period once an answer reports the limit reached, default true. A
   * read a person waits on passes false.
   */
  pace?: boolean
}

/**
 * Reads a whole Planning Center collection, or one record as a collection of one, with an access
 * token, following `links.next`, 100 records a page. It paces itself from Planning Center's own
 * headers, never from a hard-coded limit: once an answer's `X-PCO-API-Request-Rate-Count`
 * reaches its `X-PCO-API-Request-Rate-Limit`, it waits `X-PCO-API-Request-Rate-Period` seconds
 * before the next call (not when `options.pace` is false), and a 429 waits `Retry-After` seconds
 * (the period when it is missing) and repeats the call, up to 5 times (`options.retries`). Throws
 * when a call fails, so a caller never mistakes part of a collection for the whole.
 */
export async function planningCenterGet(
  path: string,
  accessToken: string,
  options: ReadOptions = {},
): Promise<Collection> {
  const retries = options.retries ?? RETRY_LIMIT
  const pace = options.pace ?? true
  const collection: Collection = { data: [], included: [] }
  const first = new URL(`${PLANNING_CENTER_ORIGIN}${path}`)
  first.searchParams.set('per_page', '100')
  let next: string | null = `${first.pathname}${first.search}`
  while (next !== null) {
    const page = await getPage(next, accessToken, retries, pace)
    collection.data.push(...page.data)
    collection.included.push(...page.included)
    next = page.next
  }
  return collection
}

async function getPage(
  path: string,
  accessToken: string,
  retries: number,
  pace: boolean,
): Promise<Collection & { next: string | null }> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await planningCenterFetch(path, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const period = wholeNumber(response.headers.get('x-pco-api-request-rate-period'))
    if (response.status === 429) {
      await response.body?.cancel()
      if (attempt >= retries) {
        throw new Error(`Planning Center still answered 429 to ${path} after ${retries} retries`)
      }
      await wait(wholeNumber(response.headers.get('retry-after')) ?? period ?? 0)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Planning Center answered ${response.status} to ${path}`)
    }

    // A collection answers an array of records, and one record (`GET /people/v2/people/:id`) the
    // record itself.
    const body = (await response.json()) as {
      data?: Resource[] | Resource | null
      included?: Resource[]
      links?: { next?: string }
    }
    const limit = wholeNumber(response.headers.get('x-pco-api-request-rate-limit'))
    const count = wholeNumber(response.headers.get('x-pco-api-request-rate-count'))
    if (pace && limit !== null && count !== null && period !== null && count >= limit) {
      await wait(period)
    }

    return {
      data: Array.isArray(body.data) ? body.data : body.data ? [body.data] : [],
      included: Array.isArray(body.included) ? body.included : [],
      next: nextPath(body.links?.next),
    }
  }
}

/** The path and query of a `links.next` on Planning Center's own origin, or null. */
function nextPath(link: string | undefined): string | null {
  if (typeof link !== 'string') return null
  const url = new URL(link)
  if (url.origin !== PLANNING_CENTER_ORIGIN) {
    throw new Error(`Planning Center sent a next page on another origin: ${url.origin}`)
  }
  return `${url.pathname}${url.search}`
}

/** A header's whole number, or null when it is missing or not a number. */
function wholeNumber(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null
  return Number(header.trim())
}

function wait(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

/** A JWT's payload, or null when the token is not a JWT with a JSON object payload. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
