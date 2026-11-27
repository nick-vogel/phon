import type { fakePlanningCenter } from './planning-center.ts'

/** One JSON:API record, and the records its page includes when the call asks for them. */
export interface Listed {
  record: object
  included?: object
}

export interface FakeJsonApiOptions {
  /** The person whose current access token is the only one the API accepts: the sync account. */
  syncPersonId: string
  /** The OAuth scope the access token must carry, such as `services` or `groups`. */
  scope: string
  /** Planning Center's rate limit, as its headers report it. Default 100 requests per 20 seconds. */
  rateLimit?: { limit: number; periodSeconds: number }
}

/** A page size small enough that every test's lists span pages. */
const PAGE_SIZE = 2

/**
 * One fake Planning Center product API, the way every one of them pages and throttles: JSON:API
 * pages of two with `links.next` and `meta.next.offset`, answered only to the sync account's
 * current access token while it carries the API's scope. Every answer carries Planning Center's
 * rate-limit headers, and a call past the limit answers 429 with `Retry-After`, as Planning Center
 * does.
 */
export function fakeJsonApi(
  planningCenter: ReturnType<typeof fakePlanningCenter>,
  options: FakeJsonApiOptions,
) {
  const limit = options.rateLimit?.limit ?? 100
  const periodSeconds = options.rateLimit?.periodSeconds ?? 20
  let windowStart = Date.now()
  let count = 0
  /** Planned 429 answers by URL path, each entry the `Retry-After` of one answer (null: none). */
  const throttles = new Map<string, Array<string | null>>()

  return {
    /**
     * Answers one call with a page of the whole list `list` returns, or 404 when it returns null.
     */
    answer(request: Request, list: () => Listed[] | null): Response {
      const now = Date.now()
      if (now - windowStart >= periodSeconds * 1000) {
        windowStart = now
        count = 0
      }
      count += 1
      const rateHeaders = {
        'x-pco-api-request-rate-limit': String(limit),
        'x-pco-api-request-rate-period': String(periodSeconds),
        'x-pco-api-request-rate-count': String(count),
      }
      const throttle = throttles.get(new URL(request.url).pathname)?.shift()
      if (throttle !== undefined || count > limit) {
        const wait =
          throttle !== undefined
            ? throttle
            : String(Math.ceil((windowStart + periodSeconds * 1000 - now) / 1000))
        return Response.json(
          { errors: [{ status: '429', title: 'Too Many Requests' }] },
          {
            status: 429,
            headers: { ...rateHeaders, ...(wait === null ? {} : { 'retry-after': wait }) },
          },
        )
      }

      const grant = planningCenter.grantFor(request)
      if (
        grant === undefined ||
        grant.personId !== options.syncPersonId ||
        request.headers.get('authorization') !==
          `Bearer ${planningCenter.accessTokenOf(options.syncPersonId)}` ||
        !grant.scope.split(' ').includes(options.scope)
      ) {
        return Response.json({ errors: [{ status: '401' }] }, { status: 401, headers: rateHeaders })
      }

      const whole = list()
      if (whole === null) {
        return Response.json({ errors: [{ status: '404' }] }, { status: 404, headers: rateHeaders })
      }
      const url = new URL(request.url)
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const perPage = Math.min(Number(url.searchParams.get('per_page') ?? '25'), PAGE_SIZE)
      const page = whole.slice(offset, offset + perPage)
      const more = offset + perPage < whole.length
      const next = new URL(url)
      next.searchParams.set('offset', String(offset + perPage))
      const include = url.searchParams.get('include') !== null
      return Response.json(
        {
          links: { self: url.toString(), ...(more ? { next: next.toString() } : {}) },
          data: page.map((listed) => listed.record),
          // Planning Center includes the related records of this page only, and only when asked.
          included: include ? page.flatMap((listed) => listed.included ?? []) : [],
          meta: {
            total_count: whole.length,
            count: page.length,
            ...(more ? { next: { offset: offset + perPage } } : {}),
          },
        },
        { headers: rateHeaders },
      )
    },

    /**
     * Answers the next calls to one path (any query) with 429, one per entry: the entry is its
     * `Retry-After`, or null for none.
     */
    throttle(path: string, retryAfters: Array<string | null>): void {
      throttles.set(path, [...retryAfters])
    },
  }
}
