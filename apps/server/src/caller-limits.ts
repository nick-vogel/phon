import type { CallerLimitRefusal } from '@phon/api-types'
import { NO_STORE } from './sign-in.ts'

/**
 * Limits for each caller on the routes the Worker answers before it knows who is asking
 * (phon#176), through the Rate Limiting bindings in wrangler.jsonc, which hold each limit's value
 * and the reason for it. A caller is the address Cloudflare saw (`CF-Connecting-IP`).
 *
 * Every limit is checked before the route reads its body or calls anything, and a limited caller
 * gets the same answer on every route, so the answer depends only on how much the caller asked,
 * never on the address, the code or the church it sent.
 */

/**
 * Every route the Worker answers before sign-in: the routes of `signInRoute`, `connectRoute`,
 * `churchListRoute`, `emailSignInRoute` and `signOutRoute`. A route added to one of them belongs
 * here too, or no caller limit covers it.
 */
const ROUTES_BEFORE_SIGN_IN = new Set([
  '/auth/start',
  '/auth/callback',
  '/auth/session',
  '/auth/connect/start',
  '/auth/connect',
  '/connect/start',
  '/connect/callback',
  '/connect',
  '/churches',
  '/auth/email/code',
  '/auth/email/session',
  '/auth/email/choice',
  '/me/sign-out',
])

/** The period of every caller limit in wrangler.jsonc, which a limited caller waits out. */
const LIMIT_PERIOD_SECONDS = 60

/**
 * Answers 429 to a caller past one of its limits on a route answered before sign-in, or null
 * when the request may go on. Every such request counts towards `ANONYMOUS_REQUESTS`; a code
 * request also counts towards `EMAIL_CODE_REQUESTS`, and a code check towards `EMAIL_CODE_CHECKS`.
 */
export async function refuseLimitedCaller(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!ROUTES_BEFORE_SIGN_IN.has(path)) return null
  const key = callerKey(request.headers.get('cf-connecting-ip'))
  if (!(await env.ANONYMOUS_REQUESTS.limit({ key })).success) return tooManyRequests()
  if (request.method !== 'POST') return null
  const limit =
    path === '/auth/email/code'
      ? env.EMAIL_CODE_REQUESTS
      : path === '/auth/email/session'
        ? env.EMAIL_CODE_CHECKS
        : null
  if (limit !== null && !(await limit.limit({ key })).success) return tooManyRequests()
  return null
}

/**
 * The key a caller is counted by: an IPv4 address as it is, and an IPv6 address by its /64, the
 * block one connection is usually given whole, so a caller cannot start a new count by changing
 * the rest of its address. Cloudflare's rate limiting rules count the same way ("an individual
 * IPv4 address or IPv6 /64 IP range", developers.cloudflare.com/waf/reference/legacy/
 * old-rate-limiting/). A request with no address counts as one caller with every other such
 * request, so leaving the header out never escapes the limits.
 */
export function callerKey(address: string | null): string {
  if (address === null || address === '') return 'no-address'
  if (!address.includes(':')) return address
  const mapped = IPV4_MAPPED.exec(address)
  if (mapped !== null) return mapped[1] as string
  return ipv6Block(address) ?? address
}

/** An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`), in any written form, and the IPv4 it carries. */
const IPV4_MAPPED =
  /^(?:::(?:0{1,4}:){0,4}|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/** The first 64 bits of an IPv6 address, in one written form, or null when it is not one. */
function ipv6Block(address: string): string | null {
  const halves = address.toLowerCase().split('::')
  if (halves.length > 2) return null
  const groupsOf = (half: string | undefined) =>
    half === undefined || half === '' ? [] : half.split(':')
  const head = groupsOf(halves[0])
  const tail = groupsOf(halves[1])
  const zeros = 8 - head.length - tail.length
  if (halves.length === 1 ? zeros !== 0 : zeros < 1) return null
  const groups = [...head, ...Array<string>(zeros).fill('0'), ...tail]
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`
}

function tooManyRequests(): Response {
  return Response.json({ problem: 'try-again' } satisfies CallerLimitRefusal, {
    status: 429,
    headers: { ...NO_STORE, 'retry-after': String(LIMIT_PERIOD_SECONDS) },
  })
}
