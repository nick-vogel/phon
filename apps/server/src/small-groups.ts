import { planningCenterGet, type Resource } from './planning-center.ts'

/**
 * Reading Planning Center Groups for the roster sync. Only the Group types an admin turned on are
 * read past the type list, and every call goes through `planningCenterGet`, so it paces itself
 * and repeats a 429 like the Services read.
 */

/** A Group's channel, keyed on its Planning Center group ID so it survives a rename. */
export function smallGroupChannelId(groupId: string): string {
  return `group-${groupId}`
}

/** One Planning Center Group type. */
export interface SyncedGroupType {
  groupTypeId: string
  name: string
}

/**
 * One live Group and its members, leaders included, each with whether Groups marks them as a child
 * (under 13 by the birthdate Planning Center holds).
 */
export interface SyncedGroup {
  groupId: string
  name: string
  members: Array<{ personId: string; name: string; child: boolean }>
}

/** Every Group type of the church, enabled or not. */
export async function readGroupTypes(accessToken: string): Promise<SyncedGroupType[]> {
  const listed = await planningCenterGet('/groups/v2/group_types', accessToken)
  return listed.data.map((type) => ({
    groupTypeId: type.id,
    name: String(type.attributes?.name ?? type.id),
  }))
}

/**
 * Reads every Group of the given Group types that is not archived, and each one's members. The
 * read asks Planning Center for Groups that are not archived and also drops any that comes back
 * with `archived_at` set. A leader counts as a member. Each member's Person carries `child`, which
 * Groups answers only when the read names it in `fields[Person]`.
 */
export async function readGroups(
  accessToken: string,
  groupTypeIds: string[],
): Promise<SyncedGroup[]> {
  const groups: SyncedGroup[] = []
  for (const groupTypeId of groupTypeIds) {
    const listed = await planningCenterGet(
      `/groups/v2/group_types/${groupTypeId}/groups?where[archive_status]=not_archived`,
      accessToken,
    )
    for (const group of listed.data) {
      if (group.attributes?.archived_at) continue
      const memberships = await planningCenterGet(
        `/groups/v2/groups/${group.id}/memberships?include=person&fields[Person]=${PERSON_FIELDS}`,
        accessToken,
      )
      const members = new Map<string, { name: string; child: boolean }>()
      for (const membership of memberships.data) {
        const personId = membership.relationships?.person?.data?.id
        if (personId === undefined) continue
        const person = memberships.included.find(
          (record) => record.type === 'Person' && record.id === personId,
        )
        members.set(personId, {
          name: person ? personName(person) : personId,
          child: person?.attributes?.child === true,
        })
      }
      groups.push({
        groupId: group.id,
        name: String(group.attributes?.name ?? group.id),
        members: [...members].map(([personId, member]) => ({ personId, ...member })),
      })
    }
  }
  return groups
}

/** The Groups Person attributes the memberships read asks for. */
const PERSON_FIELDS = 'first_name,last_name,child'

function personName(person: Resource): string {
  const { first_name, last_name } = person.attributes ?? {}
  const parts = [first_name, last_name].filter((part) => typeof part === 'string' && part !== '')
  return parts.length > 0 ? parts.join(' ') : person.id
}
