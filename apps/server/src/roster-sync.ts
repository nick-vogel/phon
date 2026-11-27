import { ageGroup, isCalendarDate, utcToday } from './age.ts'
import { syncedAvatar } from './avatar.ts'
import { channelObjectName } from './channel.ts'
import type { SyncedRoster } from './church-directory.ts'
import { REGISTRY_NAME } from './church-registry.ts'
import { planningCenterGet, type Resource, readOrganizationName } from './planning-center.ts'
import {
  readGroups,
  readGroupTypes,
  type SyncedGroup,
  type SyncedGroupType,
  smallGroupChannelId,
} from './small-groups.ts'

/**
 * The roster sync: Planning Center Services, and the Groups of the Group types an admin turned on,
 * are the source of truth for who is in which channel.
 * Each Cron Trigger tick syncs every church with a connected sync account, one after another, and
 * reads only with that account's token, never a volunteer's.
 */

/** A team's channel, keyed on its Planning Center team ID so it survives a rename. */
export function teamChannelId(teamId: string): string {
  return `team-${teamId}`
}

/** The church-wide channels every sync keeps, created once and never renamed by a sync. */
const CHURCH_WIDE = [
  { channelId: 'general', name: 'general', kind: 'open' },
  { channelId: 'off-topic', name: 'off-topic', kind: 'open' },
  { channelId: 'prayer-requests', name: 'prayer-requests', kind: 'open' },
  { channelId: 'announcements', name: 'announcements', kind: 'announcements' },
  { channelId: 'team-leads', name: 'team-leads', kind: 'team-leads' },
] as const

/**
 * What Planning Center Services holds: its people on any team, each with their birthdate
 * (`YYYY-MM-DD`) or null for none on file and their `photo_url` as Services sent it (null for
 * none), and its live teams.
 */
export interface ServicesRoster {
  people: Array<{
    personId: string
    name: string
    birthdate: string | null
    photoUrl: string | null
  }>
  teams: Array<{ teamId: string; name: string; memberIds: string[]; leaderIds: string[] }>
}

/**
 * Syncs every church with a connected sync account. One church's failure stops only its sync. A
 * church with no stored name has it read and stored first (the backfill for a church connected
 * before names, or whose connect-time read failed).
 */
export async function syncAllChurches(env: Env): Promise<void> {
  const churches = await env.CHURCH_REGISTRY.getByName(REGISTRY_NAME).churches()
  for (const { churchId, name } of churches) {
    try {
      await syncChurch(env, churchId, { named: name !== null })
    } catch (error) {
      console.error(`Roster sync for ${churchId} failed; the next tick tries again`, error)
    }
  }
}

/**
 * Syncs one church: refreshes the sync account's token when it is about to expire (storing the
 * new pair before anything else), reads the whole roster (Services teams, the Group types, and the
 * Groups of the enabled types), and applies it only once all of it was read. With no Group type
 * on that the latest sync saw, a failed Group types read does not stop it: Services alone is
 * applied. A person who lost a channel, in this sync or an earlier one, has their live sockets on
 * it closed, and the email sign-in rows no one can use again and the sessions past their lifetime
 * are swept, whether or not this sync's read succeeds.
 */
export async function syncChurch(
  env: Env,
  churchId: string,
  options: { named: boolean } = { named: true },
): Promise<void> {
  const directory = env.CHURCH_DIRECTORY.getByName(churchId)
  try {
    await readAndApplyRoster(env, directory, churchId, options.named)
  } finally {
    await closeLostSockets(env, directory, churchId)
    await pruneEmailSignIn(directory, churchId)
    await pruneSessions(directory, churchId)
  }
}

/**
 * Deletes the church's sessions past their lifetime. A failed sweep is logged and never fails the
 * church's sync; the next tick tries again. Never throws.
 */
async function pruneSessions(directory: Directory, churchId: string): Promise<void> {
  try {
    await directory.pruneSessions(churchId)
  } catch (error) {
    console.error(
      `Sweeping ${churchId}'s expired sessions failed; the next tick tries again`,
      error,
    )
  }
}

/**
 * Deletes the church's email sign-in codes, sends and name choices no one can use again. A failed
 * sweep is logged and never fails the church's sync; the next tick tries again. Never throws.
 */
async function pruneEmailSignIn(directory: Directory, churchId: string): Promise<void> {
  try {
    await directory.pruneEmailSignIn(churchId)
  } catch (error) {
    console.error(
      `Sweeping ${churchId}'s email sign-in rows failed; the next tick tries again`,
      error,
    )
  }
}

export type Directory = ReturnType<Env['CHURCH_DIRECTORY']['getByName']>

async function readAndApplyRoster(
  env: Env,
  directory: Directory,
  churchId: string,
  named: boolean,
) {
  const accessToken = await directory.syncAccessToken(churchId)
  if (accessToken === null) return
  if (!named) await backfillName(env, churchId, accessToken)

  const roster = await readRoster(accessToken)
  // Read before the Groups: a toggle that lands during the read is applied at the next tick.
  const enabledTypes = await directory.enabledGroupTypes(churchId)
  const enabled = new Set(enabledTypes.map((type) => type.groupTypeId))
  let groupTypes: SyncedGroupType[] | null
  try {
    groupTypes = await readGroupTypes(accessToken)
  } catch (error) {
    // With a Group type on that the latest sync saw, a roster without its Groups would mark their
    // members as left, so the sync fails and the next tick tries again. A type on that Planning
    // Center no longer has has no Groups to keep, so with none seen, Services is the whole roster.
    if (enabledTypes.some((type) => type.present)) throw error
    console.error(`Reading ${churchId}'s Group types failed; applying Services alone`, error)
    groupTypes = null
  }
  const groups =
    groupTypes === null
      ? []
      : await readGroups(
          accessToken,
          groupTypes.map((type) => type.groupTypeId).filter((id) => enabled.has(id)),
        )
  const profiles = await readProfiles(accessToken, groupOnlyPeople(roster, groups))
  await directory.applyRoster(churchId, toSyncedRoster(roster, groupTypes, groups, profiles))
}

/**
 * Reads a nameless church's Planning Center name and stores it, never replacing a stored one. A
 * failed read is logged and never stops the church's roster sync; the next tick tries again.
 */
async function backfillName(env: Env, churchId: string, accessToken: string): Promise<void> {
  try {
    const name = await readOrganizationName(accessToken)
    if (name !== null) await env.CHURCH_REGISTRY.getByName(REGISTRY_NAME).nameChurch(churchId, name)
  } catch (error) {
    console.error(`Reading ${churchId}'s name failed; the next tick tries again`, error)
  }
}

/**
 * Closes the sockets of every pending eviction, each on its own, so one failing channel stops
 * only its own eviction. A failed one stays pending, and the next sync retries it. Never throws.
 * The roster sync runs it after each sync, and the Worker after an admin sets a private channel's
 * members.
 */
export async function closeLostSockets(env: Env, directory: Directory, churchId: string) {
  let pending: Array<{ personId: string; channelId: string; takeMentions: boolean }>
  try {
    pending = await directory.pendingEvictions(churchId)
  } catch (error) {
    console.error(`Reading ${churchId}'s pending evictions failed; the next tick retries`, error)
    return
  }
  for (const eviction of pending) {
    try {
      const channel = env.CHANNEL.getByName(channelObjectName(churchId, eviction.channelId))
      await channel.evict(eviction.personId)
      // Their unread mentions there leave their total in the same step that clears the eviction,
      // so a retried eviction never takes them twice.
      const mentions = eviction.takeMentions
        ? (await channel.summaryFor(churchId, eviction.channelId, eviction.personId)).mentions
        : 0
      await directory.evicted(churchId, eviction, mentions)
    } catch (error) {
      console.error(
        `Closing ${eviction.personId}'s sockets on ${eviction.channelId} in ${churchId} failed; the next tick retries`,
        error,
      )
    }
  }
}

/**
 * Reads every live Services team, its people and its leaders. Archived or deleted teams and
 * archived people are skipped, and a leader counts as a member of their own team.
 */
export async function readRoster(accessToken: string): Promise<ServicesRoster> {
  const people = new Map<
    string,
    { name: string; birthdate: string | null; photoUrl: string | null }
  >()
  const teams: ServicesRoster['teams'] = []

  const listed = await planningCenterGet('/services/v2/teams', accessToken)
  for (const team of listed.data) {
    if (team.attributes?.archived_at || team.attributes?.deleted_at) continue

    const members = await planningCenterGet(`/services/v2/teams/${team.id}/people`, accessToken)
    const memberIds = new Set<string>()
    for (const person of members.data) {
      if (person.attributes?.archived === true) continue
      memberIds.add(person.id)
      people.set(person.id, {
        name: personName(person),
        birthdate: birthdateOf(person),
        photoUrl: photoOf(person, 'photo_url'),
      })
    }

    const leaders = await planningCenterGet(
      `/services/v2/teams/${team.id}/team_leaders?include=people`,
      accessToken,
    )
    const leaderIds = new Set<string>()
    for (const leader of leaders.data) {
      const personId = leader.relationships?.person?.data?.id
      if (personId === undefined) continue
      const person = leaders.included.find(
        (record) => record.type === 'Person' && record.id === personId,
      )
      if (person?.attributes?.archived === true) continue
      leaderIds.add(personId)
      memberIds.add(personId)
      if (!people.has(personId)) {
        people.set(personId, {
          name: person ? personName(person) : personId,
          birthdate: person ? birthdateOf(person) : null,
          photoUrl: person ? photoOf(person, 'photo_url') : null,
        })
      }
    }

    teams.push({
      teamId: team.id,
      name: String(team.attributes?.name ?? team.id),
      memberIds: [...memberIds],
      leaderIds: [...leaderIds],
    })
  }

  return {
    people: [...people].map(([personId, person]) => ({ personId, ...person })),
    teams,
  }
}

/**
 * The people, channels and memberships a Services roster and the synced Groups make. A person on a
 * team serves and keeps their Services name, birthdate and photo; a person only in Groups serves on
 * none, and takes the birthdate and photo Planning Center People holds for them. Each keeps their
 * photo only as the avatar rule allows (`syncedAvatar`), so a minor's never leaves this function.
 * A person under 13, or one Groups
 * marks as a child, is dropped first, from the people, every team's members and leaders, and every
 * Group, so nothing about them reaches the directory but their ID among the dropped, which takes
 * them out whatever their role.
 */
function toSyncedRoster(
  roster: ServicesRoster,
  groupTypes: SyncedGroupType[] | null,
  groups: SyncedGroup[],
  profiles: Map<string, PeopleProfile>,
): SyncedRoster {
  const today = utcToday()
  const children = new Set(
    groups.flatMap((group) => group.members.filter((m) => m.child).map((m) => m.personId)),
  )
  const everyone = new Map<
    string,
    {
      personId: string
      name: string
      serves: boolean
      birthdate: string | null
      avatar: string | null
    }
  >()
  for (const { photoUrl, ...person } of roster.people) {
    everyone.set(person.personId, {
      ...person,
      serves: true,
      avatar: syncedAvatar(photoUrl, person.birthdate, today),
    })
  }
  for (const { personId, name } of groups.flatMap((group) => group.members)) {
    if (everyone.has(personId)) continue
    const profile = profiles.get(personId)
    const birthdate = profile?.birthdate ?? null
    everyone.set(personId, {
      personId,
      name,
      serves: false,
      birthdate,
      avatar: syncedAvatar(profile?.avatar ?? null, birthdate, today),
    })
  }
  const people = [...everyone.values()].filter(
    (person) => !children.has(person.personId) && ageGroup(person.birthdate, today) !== 'under-13',
  )
  const kept = new Set(people.map((person) => person.personId))
  const dropped = [...everyone.keys()].filter((personId) => !kept.has(personId))
  const teams = roster.teams.map((team) => ({
    ...team,
    memberIds: team.memberIds.filter((personId) => kept.has(personId)),
    leaderIds: team.leaderIds.filter((personId) => kept.has(personId)),
  }))
  const leaders = new Set(teams.flatMap((team) => team.leaderIds))
  return {
    people,
    dropped,
    groupTypes,
    channels: [
      ...teams.map((team) => ({
        channelId: teamChannelId(team.teamId),
        name: team.name,
        kind: 'team' as const,
        keepName: false,
      })),
      ...groups.map((group) => ({
        channelId: smallGroupChannelId(group.groupId),
        name: group.name,
        kind: 'small-group' as const,
        keepName: false,
      })),
      ...CHURCH_WIDE.map((channel) => ({ ...channel, keepName: true })),
    ],
    memberships: [
      ...teams.flatMap((team) =>
        team.memberIds.map((personId) => ({ channelId: teamChannelId(team.teamId), personId })),
      ),
      ...[...leaders].map((personId) => ({ channelId: 'team-leads', personId })),
      ...groups.flatMap((group) =>
        group.members
          .filter(({ personId }) => kept.has(personId))
          .map(({ personId }) => ({ channelId: smallGroupChannelId(group.groupId), personId })),
      ),
    ],
    leaders: teams.flatMap((team) =>
      team.leaderIds.map((personId) => ({ channelId: teamChannelId(team.teamId), personId })),
    ),
  }
}

/**
 * The people in a synced Group who are on no Services team and whom Groups does not mark as a
 * child: the ones whose birthdate and photo the sync reads from Planning Center People.
 */
function groupOnlyPeople(roster: ServicesRoster, groups: SyncedGroup[]): string[] {
  const onTeams = new Set(roster.people.map((person) => person.personId))
  const wanted = new Set<string>()
  for (const member of groups.flatMap((group) => group.members)) {
    if (!member.child && !onTeams.has(member.personId)) wanted.add(member.personId)
  }
  return [...wanted]
}

/**
 * What the sync reads of a person from their Planning Center People profile: the `YYYY-MM-DD`
 * birthdate on file or null for none, and their `avatar` as People sent it or null for none.
 */
export interface PeopleProfile {
  birthdate: string | null
  avatar: string | null
}

/**
 * Reads each person's birthdate and photo from Planning Center People
 * (`GET /people/v2/people/:id`), with the sync account's token.
 */
export async function readProfiles(
  accessToken: string,
  personIds: string[],
): Promise<Map<string, PeopleProfile>> {
  const profiles = new Map<string, PeopleProfile>()
  for (const personId of personIds) {
    const read = await planningCenterGet(
      `/people/v2/people/${encodeURIComponent(personId)}`,
      accessToken,
    )
    const person = read.data.find((record) => record.id === personId)
    profiles.set(personId, {
      birthdate: person ? birthdateOf(person) : null,
      avatar: person ? photoOf(person, 'avatar') : null,
    })
  }
  return profiles
}

function personName(person: Resource): string {
  const { full_name, first_name, last_name } = person.attributes ?? {}
  if (typeof full_name === 'string' && full_name.trim() !== '') return full_name.trim()
  const parts = [first_name, last_name].filter((part) => typeof part === 'string' && part !== '')
  return parts.length > 0 ? parts.join(' ') : person.id
}

/**
 * A Planning Center person's photo URL under the attribute this API names it (Services'
 * `photo_url`, People's `avatar`), as sent, or null for none or for one that is no string.
 */
function photoOf(person: Resource, attribute: 'photo_url' | 'avatar'): string | null {
  const url = person.attributes?.[attribute]
  return typeof url === 'string' ? url : null
}

/** A Planning Center person's birthdate on file, or null for none or for one that is no date. */
function birthdateOf(person: Resource): string | null {
  const birthdate = person.attributes?.birthdate
  return isCalendarDate(birthdate) ? birthdate : null
}
