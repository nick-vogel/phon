import type { ChurchList, ConnectedChurch } from '@phon/api-types'
import { REGISTRY_NAME } from './church-registry.ts'
import { methodNotAllowed, NO_STORE } from './sign-in.ts'

/** A fixed locale, so the order does not move with the runtime's default locale. */
const byName = new Intl.Collator('en')

/** A church as the registry lists it, with its name `null` until one is read. */
type RegisteredChurch = { churchId: string; name: string | null }

/** How long the church list cache answers from one read of the registry: 60 seconds. */
export const CHURCH_LIST_PERIOD_MS = 60_000

/** How long the church list cache holds a failed first read before it reads again: 5 seconds. */
export const CHURCH_LIST_RETRY_MS = 5_000

/** How often a list that arrives during a first read checks whether that read has answered. */
const CHURCH_LIST_WAIT_MS = 10

/**
 * The registry's last `churches()` answer, held in this isolate for the cache period, so anonymous
 * church lists cost the one `all` ChurchRegistry at most one read per isolate per period, however
 * many arrive (`docs/adr/0001-one-church-registry.md`). It holds the plain answer and the time it
 * was read, never a read in flight: a request that awaited another request's read could hang once
 * that request ended. While one list reads the registry, every other list reads nothing: with an
 * answer to fall back on, it lists that answer, and with none, it checks every few milliseconds for
 * the read's answer or error, for up to the retry period. A failed read does not send the next list
 * back to the registry: with an answer to fall back on, the cache keeps it for another period, and
 * with none, it holds the error for the retry period, so an overloaded registry is not read once per
 * list.
 */
export class ChurchListCache {
  readonly #periodMs: number
  readonly #now: () => number
  #entry: { churches: RegisteredChurch[]; readAt: number } | null = null
  #failure: { error: unknown; failedAt: number } | null = null
  #firstReadAt: number | null = null

  constructor(periodMs: number = CHURCH_LIST_PERIOD_MS, now: () => number = Date.now) {
    this.#periodMs = periodMs
    this.#now = now
  }

  /** The registry's churches, read again only when the last read is missing or a period old. */
  async churches(env: Env): Promise<RegisteredChurch[]> {
    for (;;) {
      const now = this.#now()
      if (this.#entry !== null && now - this.#entry.readAt < this.#periodMs) {
        return this.#entry.churches
      }
      if (this.#failure !== null && now - this.#failure.failedAt < CHURCH_LIST_RETRY_MS) {
        throw this.#failure.error
      }
      if (this.#firstReadAt === null || now - this.#firstReadAt >= CHURCH_LIST_RETRY_MS) {
        return this.#read(env, now)
      }
      await new Promise((resolve) => setTimeout(resolve, CHURCH_LIST_WAIT_MS))
    }
  }

  /**
   * One read of the registry, marked before it starts: a refill stamps the answer it has fresh for
   * another period, and a first read records when it started, so no other list reads meanwhile.
   */
  async #read(env: Env, now: number): Promise<RegisteredChurch[]> {
    if (this.#entry !== null) this.#entry = { churches: this.#entry.churches, readAt: now }
    else this.#firstReadAt = now
    let churches: RegisteredChurch[]
    try {
      churches = await env.CHURCH_REGISTRY.getByName(REGISTRY_NAME).churches()
    } catch (error) {
      if (this.#entry !== null) return this.#entry.churches
      this.#failure = { error, failedAt: now }
      throw error
    } finally {
      if (this.#firstReadAt === now) this.#firstReadAt = null
    }
    this.#entry = { churches, readAt: now }
    this.#failure = null
    return churches
  }

  /** Forgets the last read, so the next list reads the registry. */
  clear(): void {
    this.#entry = null
    this.#failure = null
    this.#firstReadAt = null
  }
}

/** The Worker's church list cache, one per isolate. */
export const churchListCache = new ChurchListCache()

/**
 * `GET /churches`: every connected church with a name, which anyone may list before they sign in,
 * for the email code sign-in's church picker, in alphabetical order with a lowercase or accented
 * name among its letters, and in church ID order between two of one name. A church whose name is
 * not read yet is left out. The registry's answer comes through the church list cache, so a church
 * shows within the cache period of connecting or of its name being read. The response itself is
 * `no-store`, so no client or edge cache adds a second wait on top.
 */
export async function churchListRoute(
  request: Request,
  env: Env,
  cache: ChurchListCache = churchListCache,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/churches') return null
  if (request.method !== 'GET') return methodNotAllowed()

  const listed = await cache.churches(env)
  const churches: ConnectedChurch[] = []
  for (const { churchId, name } of listed) {
    if (name !== null) churches.push({ churchId, name })
  }
  churches.sort((a, b) => byName.compare(a.name, b.name) || compare(a.churchId, b.churchId))
  return Response.json({ churches } satisfies ChurchList, { headers: NO_STORE })
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
