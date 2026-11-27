import { type FakeJsonApiOptions, fakeJsonApi } from './json-api.ts'
import { network } from './network.ts'
import { type fakePlanningCenter, PLANNING_CENTER } from './planning-center.ts'

/** One email record on a Planning Center People profile. */
interface FakeEmail {
  id: string
  personId: string
  address: string
  primary: boolean
  blocked: boolean
}

/**
 * A fake Planning Center People Email list over the network recorder: `GET /people/v2/emails`,
 * filtered by `where[address]` ignoring case, paged and throttled like every Planning Center API.
 * Each record names its person in `relationships.person`. Like Planning Center, it answers 403 to
 * a request with no User-Agent and 401 to any token but the sync account's current one with the
 * `people` scope.
 */
export function fakeEmails(
  planningCenter: ReturnType<typeof fakePlanningCenter>,
  options: {
    syncPersonId: string
    /** Planning Center's rate limit, as its headers report it. Default 100 requests per 20 seconds. */
    rateLimit?: FakeJsonApiOptions['rateLimit']
  },
) {
  const emails: FakeEmail[] = []
  const api = fakeJsonApi(planningCenter, {
    syncPersonId: options.syncPersonId,
    scope: 'people',
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  })
  let failures = 0
  let loose = false

  network.stubPath('GET', `${PLANNING_CENTER}/people/v2/emails`, (request) => {
    if (!request.headers.get('user-agent')) {
      return Response.json({ errors: [{ status: '403' }] }, { status: 403 })
    }
    if (failures > 0) {
      failures -= 1
      return Response.json({ errors: [{ status: '500' }] }, { status: 500 })
    }
    const asked = new URL(request.url).searchParams.get('where[address]')
    return api.answer(request, () =>
      emails
        .filter(
          (email) => loose || asked === null || email.address.toLowerCase() === asked.toLowerCase(),
        )
        .map((email) => ({
          record: {
            type: 'Email',
            id: email.id,
            attributes: {
              address: email.address,
              location: 'Home',
              primary: email.primary,
              blocked: email.blocked,
            },
            relationships: { person: { data: { type: 'Person', id: email.personId } } },
          },
        })),
    )
  })

  return {
    /** Puts an email address on a person's profile. Primary and not blocked unless told. */
    hold(personId: string, address: string, flags: { primary?: boolean; blocked?: boolean } = {}) {
      emails.push({
        id: `email-${emails.length + 1}`,
        personId,
        address,
        primary: flags.primary ?? true,
        blocked: flags.blocked ?? false,
      })
    },

    /**
     * Answers every lookup with every record, whatever its address: a Planning Center that matched
     * `where[address]` more loosely than exactly.
     */
    matchLoosely(): void {
      loose = true
    },

    /** Answers the next `count` lookups with 500. */
    fail(count: number): void {
      failures = count
    },

    /** Answers the next lookups with 429, one per entry: the entry is its `Retry-After`. */
    throttle(retryAfters: Array<string | null>): void {
      api.throttle('/people/v2/emails', retryAfters)
    },
  }
}

/** One birthdate write the fake People API accepted. */
export interface BirthdateWrite {
  personId: string
  birthdate: string
  /** The request's `Authorization` header, as sent. */
  authorization: string
}

export interface FakePeopleOptions {
  /** The person whose current access token is the only one the fake accepts: the sync account. */
  syncPersonId: string
  /** The people whose profile the fake answers for, by Planning Center person ID. */
  personIds: string[]
  /** Called for each accepted write, so a test can show it to the next sync. */
  onBirthdate?: (personId: string, birthdate: string) => void
}

/**
 * A fake Planning Center People API over the network recorder: `PATCH /people/v2/people/:id`,
 * which sets a person's birthdate. Like Planning Center, it answers 403 to a request with no
 * User-Agent and 401 to any token but the sync account's current one with the `people` scope, and
 * it takes only a JSON:API body, `{ data: { type: 'Person', id, attributes: { birthdate } } }`
 * (422 otherwise). Every accepted write is recorded.
 */
export function fakePeople(
  planningCenter: ReturnType<typeof fakePlanningCenter>,
  options: FakePeopleOptions,
) {
  const writes: BirthdateWrite[] = []
  let refusals = 0

  for (const personId of options.personIds) {
    network.stubPath(
      'PATCH',
      `${PLANNING_CENTER}/people/v2/people/${personId}`,
      async (request) => {
        if (!request.headers.get('user-agent')) {
          return Response.json({ errors: [{ status: '403' }] }, { status: 403 })
        }
        const grant = planningCenter.grantFor(request)
        if (
          grant === undefined ||
          grant.personId !== options.syncPersonId ||
          request.headers.get('authorization') !==
            `Bearer ${planningCenter.accessTokenOf(options.syncPersonId)}` ||
          !grant.scope.split(' ').includes('people')
        ) {
          return Response.json({ errors: [{ status: '401' }] }, { status: 401 })
        }
        if (refusals > 0) {
          refusals -= 1
          return Response.json({ errors: [{ status: '500' }] }, { status: 500 })
        }
        const body = (await request.json().catch(() => null)) as {
          data?: { type?: unknown; id?: unknown; attributes?: Record<string, unknown> }
        } | null
        const attributes = body?.data?.attributes
        const birthdate = attributes?.birthdate
        if (
          !request.headers.get('content-type')?.startsWith('application/json') ||
          body?.data?.type !== 'Person' ||
          body.data.id !== personId ||
          typeof birthdate !== 'string' ||
          Object.keys(attributes ?? {}).length !== 1
        ) {
          return Response.json({ errors: [{ status: '422' }] }, { status: 422 })
        }
        writes.push({
          personId,
          birthdate,
          authorization: request.headers.get('authorization') ?? '',
        })
        options.onBirthdate?.(personId, birthdate)
        return Response.json({ data: { type: 'Person', id: personId, attributes: { birthdate } } })
      },
    )
  }

  return {
    /** Every write accepted so far, in order. */
    writes(): BirthdateWrite[] {
      return [...writes]
    },

    /** Answers the next write with 500. */
    refuseNext(): void {
      refusals += 1
    },
  }
}

/**
 * The birthdate the fakes and the seed give a person whose fixture names none: an adult's. A
 * fixture about a missing birthdate says so with `birthdate: null`.
 */
export const ADULT_BIRTHDATE = '1980-01-01'

/**
 * The default image Planning Center answers as a person's photo when they uploaded none: their
 * first initial, under `/uploads/initials/`.
 */
export function initialsImage(name: string): string {
  return `https://avatars.planningcenteronline.com/uploads/initials/${name.charAt(0).toUpperCase()}.png`
}

/**
 * The birthdate of a person who turns `years` old today, counted on today's UTC date, moved by
 * `days` (a positive `days` makes them that many days younger). A February 29 today falls back to
 * February 28 in a common year, the day such a person has their birthday.
 */
export function birthdateFor(years: number, days = 0): string {
  const today = new Date()
  const year = today.getUTCFullYear() - years
  const month = today.getUTCMonth()
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const day = month === 1 && today.getUTCDate() === 29 && !leap ? 28 : today.getUTCDate()
  const date = new Date(Date.UTC(year, month, day + days))
  return date.toISOString().slice(0, 10)
}
