/**
 * Caller addresses for the limits each caller has on the routes answered before sign-in
 * (`src/caller-limits.ts`). Every test request that names no caller gets a new one, so a test
 * about anything else is never refused by a limit it shares with another request; a test about a
 * limit names its caller with `CF-Connecting-IP`.
 */

// A random start, so two runs within one limit period seldom share an address.
let nextCaller = Math.floor(Math.random() * 2 ** 32)

/**
 * An address no other caller in this run has: each in its own /64 of the IPv6 documentation
 * prefix, since the Worker counts an IPv6 caller by its /64.
 */
export function newCallerAddress(): string {
  nextCaller = (nextCaller + 1) % 2 ** 32
  return `2001:db8:${(nextCaller >>> 16).toString(16)}:${(nextCaller & 0xffff).toString(16)}::1`
}

/** A request's init sent from the given caller address. */
export function fromCaller(caller: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('cf-connecting-ip', caller)
  return { ...init, headers }
}

/** The headers given, with a new caller's `CF-Connecting-IP` unless they already name one. */
export function withCaller(headers?: HeadersInit): Headers {
  const named = new Headers(headers)
  if (!named.has('cf-connecting-ip')) named.set('cf-connecting-ip', newCallerAddress())
  return named
}

/**
 * Waits, when needed, until at least `ms` are left of the limits' current 60-second period, so a
 * test's requests all fall in one period. The local simulation of the Rate Limiting binding starts
 * every period on a multiple of 60 seconds of the wall clock (miniflare's `RateLimiterObject`),
 * and a request in the next period would start a fresh count.
 */
export async function inOneLimitPeriod(ms = 15_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000)
  if (left < ms) await new Promise((resolve) => setTimeout(resolve, left + 100))
}

/** A test that waits with `inOneLimitPeriod` may wait up to 15 seconds before its own work. */
export const LIMIT_TEST_TIMEOUT_MS = 30_000
