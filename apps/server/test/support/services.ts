import { fakeGroups } from './groups.ts'
import { fakeJsonApi } from './json-api.ts'
import { network } from './network.ts'
import { ADULT_BIRTHDATE, initialsImage } from './people.ts'
import { type fakePlanningCenter, PLANNING_CENTER } from './planning-center.ts'

const SERVICES = `${PLANNING_CENTER}/services/v2`

/** One person on a Services team, by their organization-wide Planning Center person ID. */
export interface FakeServicesPerson {
  id: string
  name: string
  archived?: boolean
  /** `YYYY-MM-DD`, absent for an adult's (`ADULT_BIRTHDATE`), or null for none on file. */
  birthdate?: string | null
  /**
   * The person's `photo_url`: absent for Planning Center's default initials image (no photo
   * uploaded), a URL for an uploaded photo, or null.
   */
  photoUrl?: string | null
}

/** One Services team in the fake. */
export interface FakeTeam {
  id: string
  name: string
  members: FakeServicesPerson[]
  /** The team's leaders. A leader need not also be listed as a member. */
  leaders: FakeServicesPerson[]
  archived?: boolean
}

export interface FakeServicesOptions {
  /** The person whose current access token is the only one the fake accepts: the sync account. */
  syncPersonId: string
  teams: FakeTeam[]
  /** Planning Center's rate limit, as its headers report it. Default 100 requests per 20 seconds. */
  rateLimit?: { limit: number; periodSeconds: number }
}

/**
 * A fake Planning Center Services API over the network recorder: `GET /teams`, a team's `people`
 * and its `team_leaders`, paged and throttled like every Planning Center API. It answers only the
 * sync account's current access token, and only while it carries the `services` scope.
 *
 * Every sync also reads the Groups API's Group types, so this installs an empty Groups API (no
 * Group types) for the same sync account; a later `fakeGroups` call replaces it.
 */
export function fakeServices(
  planningCenter: ReturnType<typeof fakePlanningCenter>,
  options: FakeServicesOptions,
) {
  const teams = structuredClone(options.teams)
  const api = fakeJsonApi(planningCenter, {
    syncPersonId: options.syncPersonId,
    scope: 'services',
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  })
  fakeGroups(planningCenter, { syncPersonId: options.syncPersonId, groupTypes: [] })

  function team(id: string): FakeTeam {
    const found = teams.find((candidate) => candidate.id === id)
    if (found === undefined) throw new Error(`The fake has no team ${id}`)
    return found
  }

  const answer = api.answer

  network.stubPath('GET', `${SERVICES}/teams`, (request) =>
    answer(request, () =>
      teams.map((candidate) => ({
        record: {
          type: 'Team',
          id: candidate.id,
          attributes: {
            name: candidate.name,
            archived_at: candidate.archived ? '2026-01-01T00:00:00Z' : null,
            deleted_at: null,
          },
        },
      })),
    ),
  )

  for (const { id } of options.teams) {
    network.stubPath('GET', `${SERVICES}/teams/${id}/people`, (request) =>
      answer(request, () => team(id).members.map((member) => ({ record: servicesPerson(member) }))),
    )
    network.stubPath('GET', `${SERVICES}/teams/${id}/team_leaders`, (request) =>
      answer(request, () =>
        team(id).leaders.map((leader) => ({
          record: {
            type: 'TeamLeader',
            id: `leader-${id}-${leader.id}`,
            attributes: { send_responses_for_accepts: false, send_responses_for_declines: false },
            relationships: { person: { data: { type: 'Person', id: leader.id } } },
          },
          included: servicesPerson(leader),
        })),
      ),
    )
  }

  return {
    /** Takes a person off a team, as an admin would in Planning Center. */
    removeMember(teamId: string, personId: string): void {
      const changed = team(teamId)
      changed.members = changed.members.filter((member) => member.id !== personId)
      changed.leaders = changed.leaders.filter((leader) => leader.id !== personId)
    },

    /** Puts a person on a team. */
    addMember(teamId: string, person: FakeServicesPerson): void {
      team(teamId).members.push(person)
    },

    /** Replaces a team's leaders. */
    setLeaders(teamId: string, leaders: FakeServicesPerson[]): void {
      team(teamId).leaders = leaders
    },

    /**
     * Sets a person's birthdate on every team they are on, as their People profile would show it
     * through Services.
     */
    setBirthdate(personId: string, birthdate: string | null): void {
      for (const changed of teams) {
        for (const person of [...changed.members, ...changed.leaders]) {
          if (person.id === personId) person.birthdate = birthdate
        }
      }
    },

    /**
     * Sets a person's photo on every team they are on, as an upload or removal in Planning Center
     * would: a URL, null, or undefined for the default initials image.
     */
    setPhoto(personId: string, photoUrl: string | null | undefined): void {
      for (const changed of teams) {
        for (const person of [...changed.members, ...changed.leaders]) {
          if (person.id === personId) person.photoUrl = photoUrl
        }
      }
    },

    /**
     * Answers the next calls to one path (such as `/services/v2/teams`, any query) with 429, one per
     * entry: the entry is its `Retry-After`, or null for none.
     */
    throttle(path: string, retryAfters: Array<string | null>): void {
      api.throttle(path, retryAfters)
    },
  }
}

function servicesPerson(person: FakeServicesPerson) {
  const [firstName, ...rest] = person.name.split(' ')
  return {
    type: 'Person',
    id: person.id,
    attributes: {
      full_name: person.name,
      first_name: firstName,
      last_name: rest.join(' '),
      archived: person.archived ?? false,
      birthdate: person.birthdate === undefined ? ADULT_BIRTHDATE : person.birthdate,
      photo_url: person.photoUrl === undefined ? initialsImage(person.name) : person.photoUrl,
    },
  }
}
