import { type FakeJsonApiOptions, fakeJsonApi } from './json-api.ts'
import { network } from './network.ts'
import { ADULT_BIRTHDATE, initialsImage } from './people.ts'
import { type fakePlanningCenter, PLANNING_CENTER } from './planning-center.ts'

const GROUPS = `${PLANNING_CENTER}/groups/v2`
const PEOPLE = `${PLANNING_CENTER}/people/v2`

/** One member of a Group, by their organization-wide Planning Center person ID. */
export interface FakeGroupMember {
  id: string
  name: string
  /** Planning Center's membership role. Default `member`. */
  role?: 'member' | 'leader'
  /**
   * Whether Groups marks the person as a child (under 13). Groups answers it only when the
   * memberships read names it in `fields[Person]`. Default false.
   */
  child?: boolean
  /**
   * The `YYYY-MM-DD` birthdate on the person's People profile: absent for an adult's
   * (`ADULT_BIRTHDATE`), or null for none.
   */
  birthdate?: string | null
  /**
   * The `avatar` on the person's People profile: absent for Planning Center's default initials
   * image (no photo uploaded), a URL for an uploaded photo, or null.
   */
  avatar?: string | null
}

/** One Planning Center Group in the fake. */
export interface FakeGroup {
  id: string
  name: string
  archived?: boolean
  members: FakeGroupMember[]
}

/** One Group type and its Groups. */
export interface FakeGroupType {
  id: string
  name: string
  groups: FakeGroup[]
}

export interface FakeGroupsOptions {
  /** The person whose current access token is the only one the fake accepts: the sync account. */
  syncPersonId: string
  groupTypes: FakeGroupType[]
  rateLimit?: FakeJsonApiOptions['rateLimit']
}

/**
 * A fake Planning Center Groups API over the network recorder: `GET /group_types`, a type's
 * `groups` (honoring `where[archive_status]`) and a Group's `memberships` (including each
 * membership's person when asked, with `child` only when `fields[Person]` names it), paged and
 * throttled like every Planning Center API. It answers only the sync account's current access
 * token, and only while it carries the `groups` scope. It also answers each Group member's People
 * profile, `GET /people/v2/people/:id`, as one record with their birthdate, to the same token
 * with the `people` scope. A later call replaces the Groups API an earlier one installed.
 */
export function fakeGroups(
  planningCenter: ReturnType<typeof fakePlanningCenter>,
  options: FakeGroupsOptions,
) {
  const groupTypes = structuredClone(options.groupTypes)
  const api = fakeJsonApi(planningCenter, {
    syncPersonId: options.syncPersonId,
    scope: 'groups',
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  })
  const people = fakeJsonApi(planningCenter, {
    syncPersonId: options.syncPersonId,
    scope: 'people',
  })

  /** The person's latest record across every Group, or undefined for no Group member. */
  function member(id: string): FakeGroupMember | undefined {
    return groupTypes
      .flatMap((type) => type.groups.flatMap((candidate) => candidate.members))
      .findLast((candidate) => candidate.id === id)
  }

  function group(id: string): FakeGroup {
    for (const type of groupTypes) {
      const found = type.groups.find((candidate) => candidate.id === id)
      if (found !== undefined) return found
    }
    throw new Error(`The fake has no Group ${id}`)
  }

  /** Stubs every path the current Group types and Groups answer on. */
  function install(): void {
    network.stubPath('GET', `${GROUPS}/group_types`, (request) =>
      api.answer(request, () =>
        groupTypes.map((type, index) => ({
          record: {
            type: 'GroupType',
            id: type.id,
            attributes: { name: type.name, position: index + 1 },
          },
        })),
      ),
    )
    for (const type of groupTypes) {
      network.stubPath('GET', `${GROUPS}/group_types/${type.id}/groups`, (request) =>
        api.answer(request, () => {
          const status = new URL(request.url).searchParams.get('where[archive_status]')
          return type.groups
            .filter((candidate) => {
              if (status === 'not_archived') return !candidate.archived
              if (status === 'only') return candidate.archived === true
              return true
            })
            .map((candidate) => ({
              record: {
                type: 'Group',
                id: candidate.id,
                attributes: {
                  name: candidate.name,
                  archived_at: candidate.archived ? '2026-01-01T00:00:00Z' : null,
                  memberships_count: candidate.members.length,
                },
              },
            }))
        }),
      )
      for (const { id } of type.groups) {
        network.stubPath('GET', `${GROUPS}/groups/${id}/memberships`, (request) =>
          api.answer(request, () =>
            group(id).members.map((member) => ({
              record: {
                type: 'Membership',
                id: `membership-${id}-${member.id}`,
                attributes: {
                  role: member.role ?? 'member',
                  joined_at: '2026-01-01T00:00:00Z',
                },
                relationships: {
                  person: { data: { type: 'Person', id: member.id } },
                  group: { data: { type: 'Group', id } },
                },
              },
              included: groupsPerson(member, new URL(request.url)),
            })),
          ),
        )
        for (const { id: personId } of group(id).members) installProfile(personId)
      }
    }
  }

  /** Stubs one person's People profile, answered as Planning Center answers one record. */
  function installProfile(personId: string): void {
    network.stubPath('GET', `${PEOPLE}/people/${personId}`, async (request) => {
      const answered = people.answer(request, () => {
        const person = member(personId)
        return person === undefined ? null : [{ record: peoplePerson(person) }]
      })
      if (!answered.ok) return answered
      const body = (await answered.json()) as { data: object[] }
      return Response.json({ data: body.data[0] }, { headers: answered.headers })
    })
  }

  install()

  return {
    /** Puts a person in a Group, as a leader would in Planning Center. */
    addMember(groupId: string, person: FakeGroupMember): void {
      group(groupId).members.push(person)
      installProfile(person.id)
    },

    /** Takes a person out of a Group. */
    removeMember(groupId: string, personId: string): void {
      const changed = group(groupId)
      changed.members = changed.members.filter((member) => member.id !== personId)
    },

    /** Adds a Group type, with its Groups, as an administrator would in Planning Center. */
    addGroupType(type: FakeGroupType): void {
      groupTypes.push(structuredClone(type))
      install()
    },

    /**
     * Answers the next calls to one path (such as `/groups/v2/group_types`, any query) with 429,
     * one per entry: the entry is its `Retry-After`, or null for none.
     */
    throttle(path: string, retryAfters: Array<string | null>): void {
      api.throttle(path, retryAfters)
    },
  }
}

function groupsPerson(person: FakeGroupMember, url: URL) {
  const [firstName, ...rest] = person.name.split(' ')
  const fields = url.searchParams.get('fields[Person]')?.split(',') ?? []
  return {
    type: 'Person',
    id: person.id,
    attributes: {
      first_name: firstName,
      last_name: rest.join(' '),
      // Groups answers `child` only when the read asks for it.
      ...(fields.includes('child') ? { child: person.child ?? false } : {}),
    },
  }
}

function peoplePerson(person: FakeGroupMember) {
  const [firstName, ...rest] = person.name.split(' ')
  return {
    type: 'Person',
    id: person.id,
    attributes: {
      first_name: firstName,
      last_name: rest.join(' '),
      birthdate: person.birthdate === undefined ? ADULT_BIRTHDATE : person.birthdate,
      child: person.child ?? false,
      avatar: person.avatar === undefined ? initialsImage(person.name) : person.avatar,
    },
  }
}
