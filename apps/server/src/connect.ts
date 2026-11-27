import type { ConnectRefusal } from '@phon/api-types'
import { REGISTRY_NAME } from './church-registry.ts'
import {
  authorizeUrl,
  exchangeCodeForTokens,
  isOrganizationAdministrator,
  readOrganizationName,
} from './planning-center.ts'
import {
  churchIdFor,
  methodNotAllowed,
  NO_STORE,
  readCodeRequest,
  readStartParameters,
  redirect,
  returnToApp,
} from './sign-in.ts'

/**
 * The routes that connect a church's sync account: the dedicated Planning Center account whose
 * token the roster sync reads with. They mirror the sign-in routes, and the Worker keeps no state
 * between them.
 *
 * - `GET /connect/start` sends the browser to Planning Center's authorize page for the sync scopes.
 * - `GET /connect/callback` sends Planning Center's answer back to the app at `phon://connect`.
 * - `POST /connect` exchanges the code and stores the connection on the server.
 */

/** Where the connect callback sends the browser: the app's own scheme, fixed. */
export const CONNECT_RETURN_URL = 'phon://connect'

/**
 * What the sync account grants: Services now, Groups for small groups (phon#7), and People for
 * birthdates and the administrator check.
 */
export const SYNC_SCOPE = 'openid people services groups'

/** Answers a connect route, or null when the request is for no connect route. */
export async function connectRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  switch (url.pathname) {
    case '/connect/start':
      return request.method === 'GET' ? start(url, env) : methodNotAllowed()
    case '/connect/callback':
      return request.method === 'GET' ? returnToApp(CONNECT_RETURN_URL, url) : methodNotAllowed()
    case '/connect':
      return request.method === 'POST' ? connect(request, url, env) : methodNotAllowed()
    default:
      return null
  }
}

function start(url: URL, env: Env): Response {
  const parameters = readStartParameters(url)
  if (parameters === null) {
    return new Response('A connect needs a code_challenge, a state and a nonce', { status: 400 })
  }
  return redirect(
    authorizeUrl({
      clientId: env.PCO_CLIENT_ID,
      redirectUri: connectCallbackUrl(url),
      scope: SYNC_SCOPE,
      ...parameters,
    }),
  )
}

/**
 * Exchanges the app's code, checks that the account is a Planning Center organization
 * administrator, and stores its tokens as the church's sync connection, replacing any earlier one.
 * Only an administrator may connect or replace it. The tokens stay on the server. The church is
 * listed in the registry as soon as the connection is stored, before its Planning Center name is
 * read, so a connect dropped during the read still leaves the church listed for the roster sync.
 * The read neither retries a 429 nor waits out the rate period. When it fails the connect still
 * lands, and the roster sync's next tick reads the name.
 */
async function connect(request: Request, url: URL, env: Env): Promise<Response> {
  const body = await readCodeRequest(request)
  if (body === null) return refuse('connect-failed', 400)

  const exchanged = await exchangeCodeForTokens({
    ...body,
    redirectUri: connectCallbackUrl(url),
    clientId: env.PCO_CLIENT_ID,
    clientSecret: env.PCO_CLIENT_SECRET,
  })
  if (exchanged === null || exchanged.tokens === null) return refuse('connect-failed', 400)
  const { person, tokens } = exchanged

  if (!(await isOrganizationAdministrator(tokens.accessToken))) {
    return refuse('not-administrator', 403)
  }

  const churchId = churchIdFor(person.organizationId)
  await env.CHURCH_DIRECTORY.getByName(churchId).connectSync({
    churchId,
    tokens,
    connectedBy: person.personId,
    connectedAt: new Date().toISOString(),
  })
  const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
  await registry.register(churchId, null)
  const name = await organizationName(churchId, tokens.accessToken)
  if (name !== null) await registry.register(churchId, name)
  return new Response(null, { status: 204, headers: NO_STORE })
}

/**
 * The church's Planning Center name, or null when the read fails, is rate limited, or the church
 * has none. An admin waits on this read, so a 429 gives up at once and an answer that reports the
 * rate limit reached does not wait out the period.
 */
async function organizationName(churchId: string, accessToken: string): Promise<string | null> {
  try {
    return await readOrganizationName(accessToken, { retries: 0, pace: false })
  } catch (error) {
    console.error(`Reading ${churchId}'s name failed; the next roster sync tick reads it`, error)
    return null
  }
}

function refuse(problem: ConnectRefusal['problem'], status: 400 | 403): Response {
  return Response.json({ problem } satisfies ConnectRefusal, { status, headers: NO_STORE })
}

/** The Worker's own connect callback URL, which Planning Center redirects to. */
function connectCallbackUrl(url: URL): string {
  return `${url.origin}/connect/callback`
}
