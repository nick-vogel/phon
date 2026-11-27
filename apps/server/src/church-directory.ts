import { DurableObject } from 'cloudflare:workers'
import type {
  AgeGroup,
  AlertLevel,
  BirthdateRequestList,
  BirthdateStatus,
  ChannelAlerts,
  ChannelKind,
  ChannelList,
  ChannelMembers,
  ChannelPeople,
  ChannelSummary,
  CreatableChannelKind,
  GroupTypeList,
  Member,
  OversightLog,
  OversightNotice,
  PeopleList,
  PeopleWithoutBirthdate,
  QuietHours,
  QuietHoursSetting,
  Report,
  Role,
} from '@phon/api-types'
import { adultCutoff, ageGroup, isBirthdate, isMinor } from './age.ts'
import {
  alertChoices,
  decideAlert,
  defaultAlertLevel,
  type InterruptionLevel,
  inQuietHours,
  isAlertLevel,
  isQuietHours,
} from './alerts.ts'
import type { BadgedDevice, PushContext, PushTarget } from './expo-push.ts'
import type { Identity } from './identity.ts'
import {
  countsAsServing,
  creatableKinds,
  isRole,
  mayAssignRoles,
  mayEndSessions,
  mayManageBirthdates,
  mayManageGroupSync,
  mayMarkUrgent,
  mayModerate,
  mayPost,
  mayReadOversight,
  maySetMembers,
  PRIVATE_CHANNEL_MINIMUM,
  readsEveryChannel,
  SMALL_GROUP_MINIMUM,
  seesDeleted,
  staysWithoutRoster,
} from './permissions.ts'
import { type PlanningCenterTokens, refreshTokens } from './planning-center.ts'

/** Refresh the sync account's access token when it expires within this many milliseconds. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * A church's people and channels, as the test entry seeds them. A person's role defaults to
 * `member`, and a `birthdate` is written to file when given, cleared when null, and left as it is
 * when absent; a channel's `members` are the people who may open it when its kind needs membership,
 * and a team channel's `leaders` are the people who lead its team.
 */
export interface ChurchSeed {
  churchId: string
  people: Array<{ personId: string; name: string; role?: Role; birthdate?: string | null }>
  channels: Array<{
    channelId: string
    name: string
    kind: ChannelKind
    members?: string[]
    leaders?: string[]
  }>
}

/** Why a request about people or channels was refused, for the Worker to map to a status. */
export type Refusal =
  /** The caller is not a current person of the church (404). */
  | 'not-known'
  /** The target does not exist, or the caller may not open it (404). */
  | 'not-found'
  /** The caller can see the target, but their role may not do this (403). */
  | 'forbidden'
  /** The request names something it may not, such as a person of another church (400). */
  | 'invalid'
  /** The change would break a rule of the church as a whole (409). */
  | 'conflict'

/** A new channel, as `POST /channels` asks for it once its body is read. */
export interface NewChannel {
  name: string
  kind: CreatableChannelKind
  memberIds?: string[]
}

/**
 * One church's directory: its people and its channels, and who may open which channel. One
 * object per church, named by the church ID. Every row carries the church ID.
 */
export class ChurchDirectory extends DurableObject<Env> {
  /**
   * Whether this object's tables exist. Only the writes create them: an object that never writes
   * its storage ceases to exist when it shuts down, so a lookup of a church no one seeded, such as
   * one a forged session token names, leaves nothing behind.
   */
  private hasTables = false

  /** The sync token refresh in flight, which every `syncAccessToken` call during it waits on. */
  private refreshing: Promise<string> | undefined

  /** Writes a church's people and channels, replacing any with the same IDs. */
  seed(seed: ChurchSeed): void {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      this.createTables()
      for (const person of seed.people) {
        sql.exec(
          'INSERT OR REPLACE INTO people (church_id, person_id, name, role) VALUES (?, ?, ?, ?)',
          seed.churchId,
          person.personId,
          person.name,
          person.role ?? 'member',
        )
        if (person.birthdate === null) {
          sql.exec(
            'DELETE FROM birthdates WHERE church_id = ? AND person_id = ?',
            seed.churchId,
            person.personId,
          )
        } else if (person.birthdate !== undefined) {
          sql.exec(
            `INSERT INTO birthdates (church_id, person_id, birthdate) VALUES (?, ?, ?)
             ON CONFLICT (church_id, person_id) DO UPDATE SET birthdate = excluded.birthdate`,
            seed.churchId,
            person.personId,
            person.birthdate,
          )
        }
      }
      for (const channel of seed.channels) {
        sql.exec(
          'INSERT OR REPLACE INTO channels (church_id, channel_id, name, kind) VALUES (?, ?, ?, ?)',
          seed.churchId,
          channel.channelId,
          channel.name,
          channel.kind,
        )
        for (const personId of channel.members ?? []) {
          sql.exec(
            'INSERT OR IGNORE INTO memberships (church_id, channel_id, person_id) VALUES (?, ?, ?)',
            seed.churchId,
            channel.channelId,
            personId,
          )
        }
        for (const personId of channel.leaders ?? []) {
          sql.exec(
            'INSERT OR IGNORE INTO team_leaders (church_id, channel_id, person_id) VALUES (?, ?, ?)',
            seed.churchId,
            channel.channelId,
            personId,
          )
        }
      }
    })
  }

  /**
   * The person an identity names, with their role and what it lets them do, or null when their
   * church's directory does not know them.
   */
  member(identity: Identity): Member | null {
    const person = this.currentPerson(identity)
    if (person === null) return null
    const avatars = this.avatarsOf(identity.churchId, [identity.personId])
    return {
      personId: identity.personId,
      name: person.name,
      role: person.role,
      canCreate: creatableFor(person),
      canAssignRoles: mayAssignRoles(person.role),
      canReadOversight: mayReadOversight(person.role),
      canMarkUrgent: mayMarkUrgent(person.role),
      canManageBirthdates: mayManageBirthdates(person.role),
      canModerate: mayModerate(person.role),
      avatar: person.minor ? null : (avatars.get(identity.personId) ?? null),
    }
  }

  /** A person's own birthdate on file, their pending 18+ birthdate, and their age group. */
  birthdateStatus(identity: Identity): BirthdateStatus | Refusal {
    if (this.currentPerson(identity) === null) return 'not-known'
    const birthdate = this.birthdateOf(identity)
    return {
      birthdate,
      pendingBirthdate: this.pendingBirthdateOf(identity),
      ageGroup: ageGroup(birthdate),
    }
  }

  /**
   * Checks a person's own birthdate entry. A person enters one only while none is on file
   * (`conflict`), and it must be a birthdate `isBirthdate` takes (`invalid`). One that makes them
   * under 18 is to be written to Planning Center at once (`write`), and the caller then records it
   * with `recordBirthdate`. One that makes them 18 or older is stored here as a request waiting for
   * an admin (`pending`), replacing any other, and answers the devices to alert: every current
   * admin's and those of the leaders of each team channel the person is on, never the person's
   * own. The same birthdate again alerts no one.
   */
  birthdateEntry(identity: Identity, birthdate: unknown): BirthdateEntry | Refusal {
    const person = this.currentPerson(identity)
    if (person === null) return 'not-known'
    if (!isBirthdate(birthdate)) return 'invalid'
    if (this.birthdateOf(identity) !== null) return 'conflict'
    const group = ageGroup(birthdate)
    if (group !== 'adult') return { outcome: 'write', birthdate, ageGroup: group }

    if (this.pendingBirthdateOf(identity) === birthdate) {
      return { outcome: 'pending', name: person.name, devices: [] }
    }
    const sql = this.ctx.storage.sql
    sql.exec(
      `INSERT INTO birthdate_requests (church_id, person_id, birthdate, requested_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (church_id, person_id) DO UPDATE
         SET birthdate = excluded.birthdate, requested_at = excluded.requested_at`,
      identity.churchId,
      identity.personId,
      birthdate,
      new Date().toISOString(),
    )
    const approvers = sql
      .exec<{ person_id: string; role: string; leads: number }>(
        `SELECT p.person_id, p.role, EXISTS (
           SELECT 1 FROM team_leaders l
           JOIN memberships m ON m.church_id = l.church_id AND m.channel_id = l.channel_id
           JOIN channels c ON c.church_id = l.church_id AND c.channel_id = l.channel_id
           WHERE l.church_id = p.church_id AND l.person_id = p.person_id AND c.kind = 'team'
             AND m.person_id = ?) AS leads
         FROM people p WHERE p.church_id = ? AND p.left_at IS NULL`,
        identity.personId,
        identity.churchId,
      )
      .toArray()
      .filter((row) => row.person_id !== identity.personId)
      .filter((row) => mayManageBirthdates(toRole(row.role)) || row.leads === 1)
      .map((row) => row.person_id)
    return {
      outcome: 'pending',
      name: person.name,
      devices: this.devicesOf(identity.churchId, approvers),
    }
  }

  /**
   * Stores a birthdate Planning Center has accepted for a current person, and clears their pending
   * request. A birthdate under 13 takes the person out of Phon in the same transaction: they are
   * marked as left, and each channel anyone of the church can no longer open the same way, theirs
   * and any left with too few members, is recorded as a pending eviction.
   */
  recordBirthdate(churchId: string, personId: string, birthdate: string): void {
    const person = this.currentPerson({ churchId, personId })
    if (person === null) return
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO birthdates (church_id, person_id, birthdate) VALUES (?, ?, ?)
         ON CONFLICT (church_id, person_id) DO UPDATE SET birthdate = excluded.birthdate`,
        churchId,
        personId,
        birthdate,
      )
      sql.exec(
        'DELETE FROM birthdate_requests WHERE church_id = ? AND person_id = ?',
        churchId,
        personId,
      )
      if (ageGroup(birthdate) !== 'under-13') return
      const before = this.openable(churchId)
      sql.exec(
        'UPDATE people SET left_at = ? WHERE church_id = ? AND person_id = ?',
        new Date().toISOString(),
        churchId,
        personId,
      )
      const after = this.openable(churchId)
      for (const [pair, access] of before) {
        const now = after.get(pair)
        if (now === access || now === 'member') continue
        const [channelId, lostBy] = pair.split('\n') as [string, string]
        this.recordPendingEviction(churchId, channelId, lostBy, access)
      }
    })
  }

  /** Every birthdate waiting for approval, oldest first: admins only. */
  birthdateRequests(identity: Identity): BirthdateRequestList | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayManageBirthdates(caller.role)) return 'forbidden'
    const rows = this.ctx.storage.sql
      .exec<{ person_id: string; name: string; birthdate: string; requested_at: string }>(
        `SELECT r.person_id, p.name, r.birthdate, r.requested_at FROM birthdate_requests r
         JOIN people p ON p.church_id = r.church_id AND p.person_id = r.person_id
         WHERE r.church_id = ? AND p.left_at IS NULL
         ORDER BY r.requested_at, r.rowid`,
        identity.churchId,
      )
      .toArray()
    return {
      requests: rows.map((row) => ({
        personId: row.person_id,
        name: row.name,
        birthdate: row.birthdate,
        requestedAt: row.requested_at,
      })),
    }
  }

  /**
   * The pending birthdate an admin is about to approve, once the caller may: an admin
   * (`forbidden`), not approving their own (`forbidden`), for a current person's request
   * (`not-found`). The caller writes it to Planning Center, then records it.
   */
  approvalOf(identity: Identity, personId: string): { birthdate: string } | Refusal {
    const refusal = this.birthdateDecision(identity, personId)
    if (refusal !== null) return refusal
    return { birthdate: this.pendingBirthdateOf({ churchId: identity.churchId, personId }) ?? '' }
  }

  /** Declines a pending birthdate, with `approvalOf`'s checks. Nothing is written anywhere else. */
  declineBirthdate(identity: Identity, personId: string): 'declined' | Refusal {
    const refusal = this.birthdateDecision(identity, personId)
    if (refusal !== null) return refusal
    this.ctx.storage.sql.exec(
      'DELETE FROM birthdate_requests WHERE church_id = ? AND person_id = ?',
      identity.churchId,
      personId,
    )
    return 'declined'
  }

  /** Every current person with no birthdate on file, sorted by name: admins only. */
  peopleWithoutBirthdate(identity: Identity): PeopleWithoutBirthdate | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayManageBirthdates(caller.role)) return 'forbidden'
    const rows = this.ctx.storage.sql
      .exec<{ person_id: string; name: string }>(
        `SELECT p.person_id, p.name FROM people p
         LEFT JOIN birthdates b ON b.church_id = p.church_id AND b.person_id = p.person_id
         WHERE p.church_id = ? AND p.left_at IS NULL AND b.person_id IS NULL
         ORDER BY p.name, p.person_id`,
        identity.churchId,
      )
      .toArray()
    return { people: rows.map((row) => ({ personId: row.person_id, name: row.name })) }
  }

  /** Every current person of the caller's church with their role, sorted by name: admins only. */
  people(identity: Identity): PeopleList | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayAssignRoles(caller.role)) return 'forbidden'
    const rows = this.ctx.storage.sql
      .exec<{ person_id: string; name: string; role: string }>(
        `SELECT person_id, name, role FROM people WHERE church_id = ? AND left_at IS NULL
         ORDER BY name, person_id`,
        identity.churchId,
      )
      .toArray()
    return {
      people: rows.map((row) => ({
        personId: row.person_id,
        name: row.name,
        role: toRole(row.role),
      })),
    }
  }

  /**
   * Sets a person's role, as an admin. The church's last admin cannot be demoted, so a church
   * always has someone who can assign roles. Each channel the person could open before and cannot
   * now, such as a private channel a demoted admin read by oversight, is recorded as a pending
   * eviction in the same transaction.
   */
  setRole(identity: Identity, personId: string, role: Role): 'set' | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayAssignRoles(caller.role)) return 'forbidden'
    const target = this.currentPerson({ churchId: identity.churchId, personId })
    if (target === null) return 'not-found'
    if (target.role === 'admin' && role !== 'admin' && this.adminCount(identity.churchId) <= 1) {
      return 'conflict'
    }
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      const before = this.openableBy(
        identity.churchId,
        personId,
        target.role,
        target.serves,
        target.minor,
      )
      sql.exec(
        'UPDATE people SET role = ? WHERE church_id = ? AND person_id = ?',
        role,
        identity.churchId,
        personId,
      )
      // Every admin and chat admin counts as serving, so the new role can change that at once.
      const serves = countsAsServing(role, target.onTeam)
      const after = this.openableBy(identity.churchId, personId, role, serves, target.minor)
      for (const [channelId, access] of before) {
        const now = after.get(channelId)
        if (now === access || now === 'member') continue
        this.recordPendingEviction(identity.churchId, channelId, personId, access)
      }
    })
    return 'set'
  }

  /**
   * The channels of a person's own church that they may open, sorted by name, or null when
   * their church's directory does not know them. Each of their own carries their alert level for
   * it, stored or the kind's default, as `GET /channels/:channelId/alerts` answers it; an oversight
   * channel carries none.
   */
  channelsFor(identity: Identity): ChannelList | null {
    const person = this.currentPerson(identity)
    if (person === null) return null
    const rows = this.ctx.storage.sql
      .exec<{
        channel_id: string
        name: string
        kind: string
        is_member: number
        is_leader: number
        member_count: number
        level: string | null
      }>(
        `SELECT c.channel_id, c.name, c.kind, (m.person_id IS NOT NULL) AS is_member,
                (l.person_id IS NOT NULL) AS is_leader, ${MEMBER_COUNT} AS member_count,
                a.level
         FROM channels c
         LEFT JOIN memberships m
           ON m.church_id = c.church_id AND m.channel_id = c.channel_id AND m.person_id = ?
         LEFT JOIN team_leaders l
           ON l.church_id = c.church_id AND l.channel_id = c.channel_id AND l.person_id = ?
         LEFT JOIN alert_levels a
           ON a.church_id = c.church_id AND a.channel_id = c.channel_id AND a.person_id = ?
         WHERE c.church_id = ? ORDER BY c.name, c.channel_id`,
        adultCutoff(),
        identity.personId,
        identity.personId,
        identity.personId,
        identity.churchId,
      )
      .toArray()
    return {
      channels: rows
        .map((row) => ({
          row,
          standing: {
            isMember: row.is_member === 1,
            serves: person.serves,
            minor: person.minor,
            memberCount: row.member_count,
          },
        }))
        .filter(({ row, standing }) => mayOpen(person.role, row.kind, standing))
        .map(({ row, standing }) => {
          const channel = summary(
            row.channel_id,
            row.name,
            row.kind as ChannelKind,
            person.role,
            mayOpenAsMember(row.kind, standing),
            row.is_leader === 1,
          )
          if (channel.oversight !== true) {
            channel.alertLevel = isAlertLevel(row.level) ? row.level : defaultAlertLevel(row.kind)
          }
          return channel
        }),
    }
  }

  /**
   * Creates a channel, as a chat admin (open) or an admin (open or private); an open one only by
   * someone who serves, so its creator can open it. Its ID is minted here, never taken from the
   * request. A private channel names at least three current people of the church, so it is never
   * a direct message; an open channel names none.
   */
  createChannel(identity: Identity, channel: NewChannel): ChannelSummary | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!creatableFor(caller).includes(channel.kind)) return 'forbidden'

    const name = channel.name.trim()
    if (name.length < 1 || name.length > MAX_CHANNEL_NAME) return 'invalid'
    let memberIds: string[] = []
    if (channel.kind === 'private') {
      const members = this.validMembers(identity.churchId, channel.memberIds)
      if (members === null) return 'invalid'
      memberIds = members
    } else if (channel.memberIds !== undefined) {
      return 'invalid'
    }
    if (this.nameTaken(identity.churchId, name)) return 'conflict'

    const channelId = crypto.randomUUID()
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        'INSERT INTO channels (church_id, channel_id, name, kind) VALUES (?, ?, ?, ?)',
        identity.churchId,
        channelId,
        name,
        channel.kind,
      )
      for (const personId of memberIds) {
        sql.exec(
          'INSERT INTO memberships (church_id, channel_id, person_id) VALUES (?, ?, ?)',
          identity.churchId,
          channelId,
          personId,
        )
      }
    })
    return summary(
      channelId,
      name,
      channel.kind,
      caller.role,
      mayOpenAsMember(channel.kind, {
        isMember: memberIds.includes(identity.personId),
        serves: caller.serves,
        minor: caller.minor,
        memberCount: memberIds.length,
      }),
      false,
    )
  }

  /**
   * A private channel's members. An admin may read them for any private channel of the church;
   * anyone else who may open the channel is refused, and anyone who may not open it finds nothing.
   */
  channelMembers(identity: Identity, channelId: string): ChannelMembers | Refusal {
    const refusal = this.memberChange(identity, channelId)
    if (refusal !== null) return refusal
    return { personIds: this.memberIdsOf(identity.churchId, channelId) }
  }

  /**
   * Replaces a private channel's members, as an admin. A chat admin cannot add themselves: a
   * private channel they are not in does not exist for them, and one they are in refuses them.
   * Each person taken out is recorded as a pending eviction in the same transaction, so their live
   * sockets get closed even when the caller's eviction fails.
   */
  setChannelMembers(identity: Identity, channelId: string, personIds: unknown): 'set' | Refusal {
    const refusal = this.memberChange(identity, channelId)
    if (refusal !== null) return refusal
    const members = this.validMembers(identity.churchId, personIds)
    if (members === null) return 'invalid'
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      const kept = new Set(members)
      for (const personId of this.memberIdsOf(identity.churchId, channelId)) {
        if (kept.has(personId)) continue
        sql.exec(
          `INSERT OR IGNORE INTO pending_evictions (church_id, channel_id, person_id)
           VALUES (?, ?, ?)`,
          identity.churchId,
          channelId,
          personId,
        )
      }
      sql.exec(
        'DELETE FROM memberships WHERE church_id = ? AND channel_id = ?',
        identity.churchId,
        channelId,
      )
      for (const personId of members) {
        sql.exec(
          'INSERT INTO memberships (church_id, channel_id, person_id) VALUES (?, ?, ?)',
          identity.churchId,
          channelId,
          personId,
        )
      }
    })
    return 'set'
  }

  /**
   * Whether a person may post in a channel right now: they may open it as a member and their role
   * may post in its kind. An admin who reads it only by oversight is `overseeing`: oversight is
   * read only. Asked on every send, so a role change takes effect on the next message.
   *
   * A granted post also answers the @mentions it keeps from the ones sent: distinct current people
   * who may open the channel as members, other than the author, at most 50, in the order sent.
   * Anything else is dropped without a word, a malformed list included. Each person it keeps gets
   * one more unread mention in their total here, before the message is stored, so every later
   * read, delete, removal or list load already finds it counted.
   *
   * A team announcement needs a team channel the poster leads (`not-team-leader`), whatever their
   * role, and an urgent message a role that may mark one (`not-urgent-sender`).
   */
  postAccess(
    identity: Identity,
    channelId: string,
    mentions: unknown = [],
    flags: PostFlags = { teamAnnouncement: false, urgent: false },
  ): PostAccess {
    const person = this.currentPerson(identity)
    const kind = this.kindOf(identity.churchId, channelId)
    if (person === null || kind === null) return { access: 'denied' }
    const standing = this.standing(identity, channelId, person)
    if (!mayOpen(person.role, kind, standing)) return { access: 'denied' }
    if (!mayOpenAsMember(kind, standing)) return { access: 'overseeing' }
    if (!mayPost(person.role, kind)) return { access: 'read-only' }
    if (flags.teamAnnouncement && !(kind === 'team' && this.leads(identity, channelId))) {
      return { access: 'not-team-leader' }
    }
    if (flags.urgent && !mayMarkUrgent(person.role)) return { access: 'not-urgent-sender' }
    const kept = this.keptMentions(identity, channelId, kind, mentions)
    if (kept.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const personId of kept) this.addMentions(identity.churchId, personId, 1)
      })
    }
    return {
      access: 'granted',
      mentions: kept,
      teamAnnouncement: flags.teamAnnouncement,
      urgent: flags.urgent,
    }
  }

  /**
   * Registers a device's Expo push token for a current person. A token is one device, so one
   * registered by someone else of the church moves to the caller: a handed-down phone stops
   * alerting its last person.
   */
  registerDevice(identity: Identity, token: string): 'registered' | Refusal {
    if (this.currentPerson(identity) === null) return 'not-known'
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (church_id, token, person_id, registered_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (church_id, token) DO UPDATE
         SET person_id = excluded.person_id, registered_at = excluded.registered_at`,
      identity.churchId,
      token,
      identity.personId,
      new Date().toISOString(),
    )
    return 'registered'
  }

  /**
   * A person's alert level for a channel they are a member of, stored or the kind's default, and
   * the levels they may pick. An admin reading it only by oversight gets no alerts from it, so has
   * no level to read.
   */
  channelAlerts(identity: Identity, channelId: string): ChannelAlerts | Refusal {
    const kind = this.alertKind(identity, channelId)
    if (typeof kind !== 'string') return kind.refusal
    return { level: this.alertLevelOf(identity, channelId, kind), choices: alertChoices(kind) }
  }

  /**
   * Sets a person's alert level for a channel they are a member of. Announcements offer no
   * choice (`forbidden`), and a level the kind does not offer is `invalid`.
   */
  setAlertLevel(identity: Identity, channelId: string, level: unknown): 'set' | Refusal {
    const kind = this.alertKind(identity, channelId)
    if (typeof kind !== 'string') return kind.refusal
    const choices = alertChoices(kind)
    if (choices.length === 0) return 'forbidden'
    if (!isAlertLevel(level) || !choices.includes(level)) return 'invalid'
    this.ctx.storage.sql.exec(
      `INSERT INTO alert_levels (church_id, person_id, channel_id, level) VALUES (?, ?, ?, ?)
       ON CONFLICT (church_id, person_id, channel_id) DO UPDATE SET level = excluded.level`,
      identity.churchId,
      identity.personId,
      channelId,
      level,
    )
    return 'set'
  }

  /**
   * The people who may open a channel as its members, sorted by name: the people an @mention in
   * it can reach. Anyone who may open the channel may read them.
   */
  channelPeople(identity: Identity, channelId: string): ChannelPeople | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    const kind = this.kindOf(identity.churchId, channelId)
    if (kind === null || !mayOpen(caller.role, kind, this.standing(identity, channelId, caller))) {
      return 'not-found'
    }
    return {
      people: this.channelMemberPeople(identity.churchId, channelId, kind).map(
        ({ personId, name }) => ({ personId, name }),
      ),
    }
  }

  /** A person's quiet hours, or null for none. */
  quietHours(identity: Identity): QuietHoursSetting | Refusal {
    if (this.currentPerson(identity) === null) return 'not-known'
    const row = this.ctx.storage.sql
      .exec<{ start_time: string; end_time: string; time_zone: string }>(
        `SELECT start_time, end_time, time_zone FROM quiet_hours
         WHERE church_id = ? AND person_id = ?`,
        identity.churchId,
        identity.personId,
      )
      .toArray()[0]
    return {
      quietHours:
        row === undefined
          ? null
          : { start: row.start_time, end: row.end_time, timeZone: row.time_zone },
    }
  }

  /**
   * Sets or clears a person's own quiet hours: `null` clears them, and anything but quiet hours as
   * `isQuietHours` reads them is `invalid` and changes nothing.
   */
  setQuietHours(identity: Identity, value: unknown): 'set' | Refusal {
    if (this.currentPerson(identity) === null) return 'not-known'
    const sql = this.ctx.storage.sql
    if (value === null) {
      sql.exec(
        'DELETE FROM quiet_hours WHERE church_id = ? AND person_id = ?',
        identity.churchId,
        identity.personId,
      )
      return 'set'
    }
    if (!isQuietHours(value)) return 'invalid'
    sql.exec(
      `INSERT INTO quiet_hours (church_id, person_id, start_time, end_time, time_zone)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (church_id, person_id) DO UPDATE SET start_time = excluded.start_time,
         end_time = excluded.end_time, time_zone = excluded.time_zone`,
      identity.churchId,
      identity.personId,
      value.start,
      value.end,
      value.timeZone,
    )
    return 'set'
  }

  /**
   * Who to push for a message, by the alert decision: every device of every current person who may
   * open the channel as a member, but the author, whose level, quiet hours and the message's own
   * kind let it through, each at the interruption level the decision answered. An admin reading
   * the channel only by oversight is not a recipient. Also names the channel and author for the
   * push's text. Every push target carries its person's unread mention total as the badge, which
   * `postAccess` has already counted this message's @mentions into.
   */
  alertTargets(
    churchId: string,
    channelId: string,
    message: { authorId: string; mentions: string[]; teamAnnouncement?: boolean; urgent?: boolean },
  ): PushContext & { pushes: PushTarget[] } {
    const kind = this.kindOf(churchId, channelId)
    const channelName =
      this.ctx.storage.sql
        .exec<{ name: string }>(
          'SELECT name FROM channels WHERE church_id = ? AND channel_id = ?',
          churchId,
          channelId,
        )
        .toArray()[0]?.name ?? channelId
    const authorName =
      this.currentPerson({ churchId, personId: message.authorId })?.name ?? message.authorId
    if (kind === null) return { channelName, authorName, pushes: [] }

    const mentioned = new Set(message.mentions)
    const members = this.channelMemberPeople(churchId, channelId, kind)
    // One clock reading per message, so every recipient is judged at the same moment.
    const now = new Date()
    const recipients = new Map<string, InterruptionLevel>()
    for (const person of members) {
      if (person.personId === message.authorId) continue
      const alert = decideAlert({
        kind,
        level: person.level ?? defaultAlertLevel(kind),
        mentioned: mentioned.has(person.personId),
        teamAnnouncement: message.teamAnnouncement === true,
        urgent: message.urgent === true,
        quiet: inQuietHours(person.quietHours, now),
      })
      if (alert !== null) recipients.set(person.personId, alert.interruptionLevel)
    }
    if (recipients.size === 0) return { channelName, authorName, pushes: [] }

    const devices = this.ctx.storage.sql
      .exec<{ token: string; person_id: string }>(
        'SELECT token, person_id FROM devices WHERE church_id = ? ORDER BY person_id, token',
        churchId,
      )
      .toArray()
    const totals = this.mentionTotalsOf(churchId, [...recipients.keys()])
    return {
      channelName,
      authorName,
      pushes: devices.flatMap((device) => {
        const interruptionLevel = recipients.get(device.person_id)
        return interruptionLevel === undefined
          ? []
          : [
              {
                token: device.token,
                badge: totals.get(device.person_id) ?? 0,
                interruptionLevel,
              },
            ]
      }),
    }
  }

  /**
   * Sets a current person's unread mention total to the sum their channel list just computed,
   * which corrects any drift. A person the directory does not know is left alone.
   */
  setMentionTotal(identity: Identity, total: number): void {
    if (this.currentPerson(identity) === null) return
    const sql = this.ctx.storage.sql
    sql.exec(MENTION_TOTALS_TABLE)
    sql.exec(
      `INSERT INTO mention_totals (church_id, person_id, total) VALUES (?, ?, MAX(?, 0))
       ON CONFLICT (church_id, person_id) DO UPDATE SET total = excluded.total`,
      identity.churchId,
      identity.personId,
      total,
    )
  }

  /**
   * Takes unread mentions in a channel out of people's totals, never below 0, for those who still
   * may open it as a member. Anyone else lost the channel, and their mentions there are taken away
   * when their eviction runs (`evicted`), so they are not taken twice.
   */
  takeMentions(
    churchId: string,
    channelId: string,
    taken: Array<{ personId: string; count: number }>,
  ): void {
    const kind = this.kindOf(churchId, channelId)
    if (kind === null) return
    const members = new Set(
      this.channelMemberPeople(churchId, channelId, kind).map(({ personId }) => personId),
    )
    this.ctx.storage.transactionSync(() => {
      for (const { personId, count } of taken) {
        if (members.has(personId) && count > 0) this.addMentions(churchId, personId, -count)
      }
    })
  }

  /**
   * Whether a person may open a channel of their own church. An unknown person or channel is
   * denied.
   */
  channelAccess(identity: Identity, channelId: string): 'granted' | 'denied' {
    const person = this.currentPerson(identity)
    const kind = this.kindOf(identity.churchId, channelId)
    return person !== null &&
      kind !== null &&
      mayOpen(person.role, kind, this.standing(identity, channelId, person))
      ? 'granted'
      : 'denied'
  }

  /**
   * The church's Planning Center Group types the latest sync saw, sorted by name, each with
   * whether its sync is on: admins only.
   */
  groupTypes(identity: Identity): GroupTypeList | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayManageGroupSync(caller.role)) return 'forbidden'
    const rows = this.ctx.storage.sql
      .exec<{ group_type_id: string; name: string; sync_enabled: number }>(
        `SELECT group_type_id, name, sync_enabled FROM group_types
         WHERE church_id = ? AND present = 1 ORDER BY name, group_type_id`,
        identity.churchId,
      )
      .toArray()
    return {
      groupTypes: rows.map((row) => ({
        id: row.group_type_id,
        name: row.name,
        syncEnabled: row.sync_enabled === 1,
      })),
    }
  }

  /**
   * Turns a Group type's sync on or off, as an admin. Only a type the latest sync saw can be set;
   * the change takes effect at the next sync.
   */
  setGroupTypeSync(identity: Identity, groupTypeId: string, enabled: boolean): 'set' | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayManageGroupSync(caller.role)) return 'forbidden'
    const sql = this.ctx.storage.sql
    const known =
      sql
        .exec(
          'SELECT 1 FROM group_types WHERE church_id = ? AND group_type_id = ? AND present = 1',
          identity.churchId,
          groupTypeId,
        )
        .toArray().length > 0
    if (!known) return 'not-found'
    sql.exec(
      'UPDATE group_types SET sync_enabled = ? WHERE church_id = ? AND group_type_id = ?',
      enabled ? 1 : 0,
      identity.churchId,
      groupTypeId,
    )
    return 'set'
  }

  /**
   * The Group types whose sync an admin turned on, for the roster sync, each with whether the
   * latest sync saw it. A type the latest sync did not see keeps its setting, so it counts again
   * if it comes back.
   */
  enabledGroupTypes(churchId: string): Array<{ groupTypeId: string; present: boolean }> {
    if (!this.tablesExist()) return []
    return this.ctx.storage.sql
      .exec<{ group_type_id: string; present: number }>(
        `SELECT group_type_id, present FROM group_types WHERE church_id = ? AND sync_enabled = 1
         ORDER BY group_type_id`,
        churchId,
      )
      .toArray()
      .map((row) => ({ groupTypeId: row.group_type_id, present: row.present === 1 }))
  }

  /**
   * Whether a person may remove or pin messages in a channel: `denied` when they may not open it by
   * the full grant rule, so an admin reading it by oversight may moderate there, and `forbidden`
   * when they may open it but their role does not moderate. When an admin is granted in a private
   * channel they read only by oversight, the look is recorded in this same call, as `openChannel`
   * does.
   */
  moderationAccess(identity: Identity, channelId: string): 'granted' | 'forbidden' | 'denied' {
    const person = this.currentPerson(identity)
    const kind = this.kindOf(identity.churchId, channelId)
    if (person === null || kind === null) return 'denied'
    const standing = this.standing(identity, channelId, person)
    if (!mayOpen(person.role, kind, standing)) return 'denied'
    if (!mayModerate(person.role)) return 'forbidden'
    if (kind === 'private' && !mayOpenAsMember(kind, standing)) {
      this.recordOversight(identity, channelId)
    }
    return 'granted'
  }

  /**
   * Files a report of a message by a current person who may open its channel (`not-found`
   * otherwise). The caller has already read the message from its channel. A person has one open
   * report per message: a repeat files nothing and answers no devices. A new report answers the
   * devices to alert: every device of every current admin and chat admin who may open the channel,
   * but the reporter's own, and the channel's name for the push.
   */
  fileReport(
    identity: Identity,
    channelId: string,
    message: { messageId: string; authorId: string },
  ): FiledReport | Refusal {
    const reporter = this.currentPerson(identity)
    if (reporter === null) return 'not-known'
    const channel = this.channelOf(identity.churchId, channelId)
    if (channel === null) return 'not-found'
    if (!mayOpen(reporter.role, channel.kind, this.standing(identity, channelId, reporter))) {
      return 'not-found'
    }
    const sql = this.ctx.storage.sql
    const open = sql
      .exec<{ report_id: string }>(
        `SELECT report_id FROM reports
         WHERE church_id = ? AND channel_id = ? AND message_id = ? AND reporter_id = ?
           AND closed_at IS NULL`,
        identity.churchId,
        channelId,
        message.messageId,
        identity.personId,
      )
      .toArray()[0]
    if (open !== undefined) {
      return { reportId: open.report_id, channelName: channel.name, devices: [] }
    }

    const reportId = crypto.randomUUID()
    sql.exec(
      `INSERT INTO reports
         (church_id, report_id, channel_id, message_id, author_id, reporter_id, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      identity.churchId,
      reportId,
      channelId,
      message.messageId,
      message.authorId,
      identity.personId,
      new Date().toISOString(),
    )
    const moderators = this.moderatorsOf(identity.churchId, channelId, channel.kind).filter(
      (personId) => personId !== identity.personId,
    )
    return {
      reportId,
      channelName: channel.name,
      devices: this.devicesOf(identity.churchId, moderators),
    }
  }

  /**
   * The open reports a moderator may see, newest first: those of every channel they may open, so a
   * chat admin sees none from a private channel they are not in (`forbidden` for anyone who does
   * not moderate). Also answers whether the moderator sees deleted messages, for reading the
   * reported messages from their channels.
   */
  openReports(identity: Identity): OpenReports | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayModerate(caller.role)) return 'forbidden'
    const rows = this.ctx.storage.sql
      .exec<{
        report_id: string
        channel_id: string
        channel_name: string
        kind: string
        is_member: number
        member_count: number
        message_id: string
        author_id: string
        author_name: string | null
        reporter_id: string
        reporter_name: string | null
        reported_at: string
      }>(
        `SELECT r.report_id, r.channel_id, c.name AS channel_name, c.kind,
                (m.person_id IS NOT NULL) AS is_member, ${MEMBER_COUNT} AS member_count,
                r.message_id,
                r.author_id, a.name AS author_name, r.reporter_id, p.name AS reporter_name,
                r.reported_at
         FROM reports r
         JOIN channels c ON c.church_id = r.church_id AND c.channel_id = r.channel_id
         LEFT JOIN memberships m
           ON m.church_id = r.church_id AND m.channel_id = r.channel_id AND m.person_id = ?
         LEFT JOIN people a ON a.church_id = r.church_id AND a.person_id = r.author_id
         LEFT JOIN people p ON p.church_id = r.church_id AND p.person_id = r.reporter_id
         WHERE r.church_id = ? AND r.closed_at IS NULL
         ORDER BY r.reported_at DESC, r.rowid DESC`,
        adultCutoff(),
        identity.personId,
        identity.churchId,
      )
      .toArray()
    return {
      seesDeleted: seesDeleted(caller.role),
      reports: rows
        .filter((row) =>
          mayOpen(caller.role, row.kind, {
            isMember: row.is_member === 1,
            serves: caller.serves,
            minor: caller.minor,
            memberCount: row.member_count,
          }),
        )
        .map((row) => ({
          reportId: row.report_id,
          channelId: row.channel_id,
          channelName: row.channel_name,
          messageId: row.message_id,
          reporterId: row.reporter_id,
          reporterName: row.reporter_name ?? row.reporter_id,
          reportedAt: row.reported_at,
          authorId: row.author_id,
          authorName: row.author_name ?? row.author_id,
        })),
    }
  }

  /**
   * Closes an open report, as a moderator who may see it: `forbidden` for anyone who does not
   * moderate, `not-found` for a report that is unknown, already closed, or from a channel the
   * caller may not open.
   */
  closeReport(identity: Identity, reportId: string): 'closed' | Refusal {
    const open = this.openReports(identity)
    if (typeof open === 'string') return open
    if (!open.reports.some((report) => report.reportId === reportId)) return 'not-found'
    this.ctx.storage.sql.exec(
      'UPDATE reports SET closed_at = ?, closed_by = ? WHERE church_id = ? AND report_id = ?',
      new Date().toISOString(),
      identity.personId,
      identity.churchId,
      reportId,
    )
    return 'closed'
  }

  /**
   * The read gate behind a channel's history and socket: whether a person may open a channel, and
   * whether they see its deleted messages. When an admin opens a private channel they read only by
   * oversight, as a non-member or as one of its last two members, the look is recorded in this same
   * call, so no such read happens without its record.
   */
  openChannel(identity: Identity, channelId: string): { seesDeleted: boolean } | 'denied' {
    const read = this.readAccess(identity, channelId)
    if (read === 'denied') return 'denied'
    if (read.kind === 'private' && read.overseeing) this.recordOversight(identity, channelId)
    return { seesDeleted: read.seesDeleted }
  }

  /** Records that an admin opened a private channel they read only by oversight, now. */
  private recordOversight(identity: Identity, channelId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO oversight_views (church_id, view_id, admin_id, channel_id, opened_at)
       VALUES (?, ?, ?, ?, ?)`,
      identity.churchId,
      crypto.randomUUID(),
      identity.personId,
      channelId,
      new Date().toISOString(),
    )
  }

  /**
   * The read gate without its record: whether a person may open a channel, and whether they see
   * its deleted messages. The image route asks this, because an image ID is only learned from a
   * history, a socket or the reports list, whose opening `openChannel` has already recorded.
   */
  readAccess(
    identity: Identity,
    channelId: string,
  ): { seesDeleted: boolean; kind: string; overseeing: boolean } | 'denied' {
    const person = this.currentPerson(identity)
    const kind = this.kindOf(identity.churchId, channelId)
    if (person === null || kind === null) return 'denied'
    const standing = this.standing(identity, channelId, person)
    if (!mayOpen(person.role, kind, standing)) return 'denied'
    return {
      seesDeleted: seesDeleted(person.role),
      kind,
      overseeing: !mayOpenAsMember(kind, standing),
    }
  }

  /**
   * The name and photo of each of these authors who is a current person of the church, once each,
   * in the order given: the authors a channel's history names. Whoever may read the history may
   * read them, since its messages already show who wrote them.
   */
  authorNames(
    churchId: string,
    personIds: string[],
  ): Array<{ personId: string; name: string; avatar: string | null }> {
    const authorIds = [...new Set(personIds)]
    const avatars = this.avatarsOf(churchId, authorIds)
    return authorIds.flatMap((personId) => {
      const person = this.currentPerson({ churchId, personId })
      if (person === null) return []
      return [
        {
          personId,
          name: person.name,
          avatar: person.minor ? null : (avatars.get(personId) ?? null),
        },
      ]
    })
  }

  /** The people among these who are current admins, so they see deleted messages live. */
  overseers(churchId: string, personIds: string[]): string[] {
    return [...new Set(personIds)].filter((personId) => {
      const person = this.currentPerson({ churchId, personId })
      return person !== null && seesDeleted(person.role)
    })
  }

  /**
   * Every time an admin opened a private channel they are not a member of, newest first: admins
   * only.
   */
  oversightLog(identity: Identity): OversightLog | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayReadOversight(caller.role)) return 'forbidden'
    const rows = this.ctx.storage.sql
      .exec<{
        view_id: string
        admin_id: string
        admin_name: string
        channel_id: string
        channel_name: string
        opened_at: string
      }>(
        `SELECT v.view_id, v.admin_id, p.name AS admin_name, v.channel_id, c.name AS channel_name, v.opened_at
         FROM oversight_views v
         JOIN people p ON p.church_id = v.church_id AND p.person_id = v.admin_id
         JOIN channels c ON c.church_id = v.church_id AND c.channel_id = v.channel_id
         WHERE v.church_id = ? ORDER BY v.opened_at DESC, v.rowid DESC`,
        identity.churchId,
      )
      .toArray()
    return {
      views: rows.map((row) => ({
        viewId: row.view_id,
        adminId: row.admin_id,
        adminName: row.admin_name,
        channelId: row.channel_id,
        channelName: row.channel_name,
        openedAt: row.opened_at,
      })),
    }
  }

  /** Whether a person has seen the oversight notice. */
  oversightNotice(identity: Identity): OversightNotice | Refusal {
    if (this.currentPerson(identity) === null) return 'not-known'
    const seen =
      this.ctx.storage.sql
        .exec(
          'SELECT 1 FROM oversight_notices_seen WHERE church_id = ? AND person_id = ?',
          identity.churchId,
          identity.personId,
        )
        .toArray().length > 0
    return { seen }
  }

  /** Records that a person saw the oversight notice. The first time they saw it is kept. */
  acknowledgeOversightNotice(identity: Identity): 'set' | Refusal {
    if (this.currentPerson(identity) === null) return 'not-known'
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO oversight_notices_seen (church_id, person_id, seen_at)
       VALUES (?, ?, ?)`,
      identity.churchId,
      identity.personId,
      new Date().toISOString(),
    )
    return 'set'
  }

  /**
   * Starts a session for a person, stored by the hash of its token. Only a person this directory
   * knows gets one.
   */
  startSession(identity: Identity, tokenHash: string): 'started' | 'not-known' {
    if (!this.knows(identity)) return 'not-known'
    this.insertSession(identity, tokenHash)
    return 'started'
  }

  /**
   * Takes one of the church's email code lookups for the period, or answers false when none is
   * left. Every lookup spends the sync account's Planning Center rate limit of 100 calls in 20
   * seconds, which the roster sync and birthdate writes share, so the budget leaves them at least
   * 80 of every period, whatever the address.
   */
  takeEmailLookup(churchId: string): boolean {
    const sql = this.ctx.storage.sql
    return this.ctx.storage.transactionSync(() => {
      this.createTables()
      const now = Date.now()
      sql.exec(
        'DELETE FROM email_lookups WHERE church_id = ? AND looked_at <= ?',
        churchId,
        now - EMAIL_LOOKUP_PERIOD_MS,
      )
      const row = sql
        .exec<{ taken: number }>(
          'SELECT COUNT(*) AS taken FROM email_lookups WHERE church_id = ?',
          churchId,
        )
        .toArray()[0]
      if ((row?.taken ?? 0) >= EMAIL_LOOKUPS_PER_PERIOD) return false
      sql.exec('INSERT INTO email_lookups (church_id, looked_at) VALUES (?, ?)', churchId, now)
      return true
    })
  }

  /**
   * Stores a new sign-in code for an address, by the hashes of both, for the people Planning
   * Center says hold it. Only the people this directory knows count: someone who left, or was
   * never synced (such as a person under 13), is no one. `none` when no one counts or the address
   * reached its send limit, and nothing is stored; otherwise the send is counted and the code
   * replaces any earlier one for the address, working for 10 minutes.
   */
  issueEmailCode(
    churchId: string,
    addressHash: string,
    personIds: string[],
    codeHash: string,
  ): 'issued' | 'none' {
    const sql = this.ctx.storage.sql
    return this.ctx.storage.transactionSync(() => {
      this.createTables()
      const known = personIds.filter((personId) => this.knows({ churchId, personId }))
      const now = Date.now()
      if (known.length === 0 || this.sendLimitReached(churchId, addressHash, now)) return 'none'
      sql.exec(
        'DELETE FROM email_code_sends WHERE church_id = ? AND address_hash = ? AND sent_at <= ?',
        churchId,
        addressHash,
        now - HOUR_MS,
      )
      sql.exec(
        'INSERT INTO email_code_sends (church_id, address_hash, sent_at) VALUES (?, ?, ?)',
        churchId,
        addressHash,
        now,
      )
      sql.exec(
        `INSERT OR REPLACE INTO email_codes
           (church_id, address_hash, code_hash, person_ids, expires_at, wrong_tries)
         VALUES (?, ?, ?, ?, ?, 0)`,
        churchId,
        addressHash,
        codeHash,
        JSON.stringify(known),
        now + EMAIL_CODE_LIFETIME_MS,
      )
      return 'issued'
    })
  }

  /**
   * Checks a sign-in code for an address, by the hashes of both. The right code, before it
   * expires, is used up. When this directory still knows exactly one of the people it was sent
   * for, it starts that person's session; when it knows several, it stores a name choice by its
   * token's hash, working for 5 minutes, and answers their names, sorted by name then person ID.
   * Anything else is `wrong`: no code, an expired one (deleted), a wrong one (counted, and the
   * code deleted at the fifth), or a right one for no one. A wrong code for a live one is also
   * counted for the church, and once the church has 100 in the last hour every check is
   * `limited`, the right code included, before the address's code is read or its tries spent.
   */
  checkEmailCode(
    churchId: string,
    addressHash: string,
    codeHash: string,
    sessionTokenHash: string,
    choiceTokenHash: string,
  ):
    | 'started'
    | 'wrong'
    | 'limited'
    | { outcome: 'choose'; people: Array<{ personId: string; name: string }> } {
    if (!this.tableExists('email_codes')) return 'wrong'
    const sql = this.ctx.storage.sql
    return this.ctx.storage.transactionSync(() => {
      if (this.codeMissLimitReached(churchId, Date.now())) return 'limited'
      const row = sql
        .exec<{ code_hash: string; person_ids: string; expires_at: number; wrong_tries: number }>(
          `SELECT code_hash, person_ids, expires_at, wrong_tries FROM email_codes
           WHERE church_id = ? AND address_hash = ?`,
          churchId,
          addressHash,
        )
        .toArray()[0]
      if (row === undefined) return 'wrong'
      const forget = () =>
        sql.exec(
          'DELETE FROM email_codes WHERE church_id = ? AND address_hash = ?',
          churchId,
          addressHash,
        )
      if (row.expires_at <= Date.now()) {
        forget()
        return 'wrong'
      }
      if (row.code_hash !== codeHash) {
        this.countCodeMiss(churchId, Date.now())
        if (row.wrong_tries + 1 >= EMAIL_CODE_TRIES) forget()
        else {
          sql.exec(
            `UPDATE email_codes SET wrong_tries = wrong_tries + 1
             WHERE church_id = ? AND address_hash = ?`,
            churchId,
            addressHash,
          )
        }
        return 'wrong'
      }
      forget()
      const known = (JSON.parse(row.person_ids) as string[]).filter((personId) =>
        this.knows({ churchId, personId }),
      )
      if (known.length === 0) return 'wrong'
      if (known.length === 1) {
        this.insertSession({ churchId, personId: known[0] as string }, sessionTokenHash)
        return 'started'
      }
      // A directory whose tables predate the name choice has no email_code_choices yet.
      this.createTables()
      const now = Date.now()
      sql.exec(
        'DELETE FROM email_code_choices WHERE church_id = ? AND expires_at <= ?',
        churchId,
        now,
      )
      sql.exec(
        `INSERT INTO email_code_choices (church_id, token_hash, person_ids, expires_at)
         VALUES (?, ?, ?, ?)`,
        churchId,
        choiceTokenHash,
        JSON.stringify(known),
        now + EMAIL_CHOICE_LIFETIME_MS,
      )
      const people = sql
        .exec<{ person_id: string; name: string }>(
          `SELECT person_id, name FROM people
           WHERE church_id = ? AND left_at IS NULL
             AND person_id IN (SELECT value FROM json_each(?))
           ORDER BY name, person_id`,
          churchId,
          JSON.stringify(known),
        )
        .toArray()
        .map((row) => ({ personId: row.person_id, name: row.name }))
      return { outcome: 'choose' as const, people }
    })
  }

  /**
   * Starts the session of the person picked with an email name choice token, by its hash. Any
   * refusal uses the token up. A success keeps it for the person picked only, for a minute (never
   * past its own expiry), so a retry after a lost answer starts them a new session instead of
   * sending them back for a new code. `refused` when there is no such choice, it expired, the
   * person was not one of the code's match (or not the one it already signed in), or this
   * directory no longer knows them.
   */
  chooseEmailPerson(
    churchId: string,
    choiceTokenHash: string,
    personId: string,
    sessionTokenHash: string,
  ): 'started' | 'refused' {
    if (!this.tableExists('email_code_choices')) return 'refused'
    const sql = this.ctx.storage.sql
    return this.ctx.storage.transactionSync(() => {
      const row = sql
        .exec<{ person_ids: string; expires_at: number }>(
          `SELECT person_ids, expires_at FROM email_code_choices
           WHERE church_id = ? AND token_hash = ?`,
          churchId,
          choiceTokenHash,
        )
        .toArray()[0]
      if (row === undefined) return 'refused'
      const now = Date.now()
      const refuse = () => {
        sql.exec(
          'DELETE FROM email_code_choices WHERE church_id = ? AND token_hash = ?',
          churchId,
          choiceTokenHash,
        )
        return 'refused' as const
      }
      if (row.expires_at <= now) return refuse()
      if (!(JSON.parse(row.person_ids) as string[]).includes(personId)) return refuse()
      if (!this.knows({ churchId, personId })) return refuse()
      sql.exec(
        `UPDATE email_code_choices SET person_ids = json_array(?), expires_at = MIN(expires_at, ?)
         WHERE church_id = ? AND token_hash = ?`,
        personId,
        now + EMAIL_CHOICE_RETRY_MS,
        churchId,
        choiceTokenHash,
      )
      this.insertSession({ churchId, personId }, sessionTokenHash)
      return 'started'
    })
  }

  /**
   * Deletes the church's email sign-in rows no one can use again: codes and name choices past
   * their expiry, and sends an hour old, which no longer count toward the send limits. The roster
   * sync runs it on every tick, so an address that never asks again, or a choice never picked,
   * leaves nothing behind. Writes nothing, and creates no table, in a directory without them.
   */
  pruneEmailSignIn(churchId: string): void {
    const sql = this.ctx.storage.sql
    const tables = ['email_codes', 'email_code_choices', 'email_code_sends'].filter((name) =>
      this.tableExists(name),
    )
    if (tables.length === 0) return
    this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      if (tables.includes('email_codes')) {
        sql.exec('DELETE FROM email_codes WHERE church_id = ? AND expires_at <= ?', churchId, now)
      }
      if (tables.includes('email_code_choices')) {
        sql.exec(
          'DELETE FROM email_code_choices WHERE church_id = ? AND expires_at <= ?',
          churchId,
          now,
        )
      }
      if (tables.includes('email_code_sends')) {
        // The edge `sendLimitReached` counts from, so no send that still counts is deleted.
        sql.exec(
          'DELETE FROM email_code_sends WHERE church_id = ? AND sent_at <= ?',
          churchId,
          now - HOUR_MS,
        )
      }
    })
  }

  /** Whether an address had a send in the last 60 seconds, or 5 in the last hour, before `now`. */
  private sendLimitReached(churchId: string, addressHash: string, now: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ minute: number; hour: number }>(
        `SELECT COALESCE(SUM(sent_at > ?), 0) AS minute, COUNT(*) AS hour FROM email_code_sends
         WHERE church_id = ? AND address_hash = ? AND sent_at > ?`,
        now - MINUTE_MS,
        churchId,
        addressHash,
        now - HOUR_MS,
      )
      .toArray()[0]
    return (row?.minute ?? 0) > 0 || (row?.hour ?? 0) >= EMAIL_SENDS_PER_HOUR
  }

  /** Whether a church had 100 wrong email codes for live ones in the hour before `now`. */
  private codeMissLimitReached(churchId: string, now: number): boolean {
    if (!this.tableExists('email_code_misses')) return false
    const row = this.ctx.storage.sql
      .exec<{ missed: number }>(
        'SELECT COUNT(*) AS missed FROM email_code_misses WHERE church_id = ? AND missed_at > ?',
        churchId,
        now - HOUR_MS,
      )
      .toArray()[0]
    return (row?.missed ?? 0) >= EMAIL_CODE_MISSES_PER_HOUR
  }

  /** Counts one wrong email code for the church at `now`, and deletes its misses an hour old. */
  private countCodeMiss(churchId: string, now: number): void {
    const sql = this.ctx.storage.sql
    // A directory whose tables predate the limit has no email_code_misses yet.
    this.createTables()
    sql.exec(
      'DELETE FROM email_code_misses WHERE church_id = ? AND missed_at <= ?',
      churchId,
      now - HOUR_MS,
    )
    sql.exec('INSERT INTO email_code_misses (church_id, missed_at) VALUES (?, ?)', churchId, now)
  }

  /** Stores a session by its token's hash. The caller has checked that the person is known. */
  private insertSession(identity: Identity, tokenHash: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO sessions (church_id, token_hash, person_id, created_at) VALUES (?, ?, ?, ?)',
      identity.churchId,
      tokenHash,
      identity.personId,
      new Date().toISOString(),
    )
  }

  /**
   * Connects a church: names its first admin and starts their session, in one transaction. The
   * caller has already checked that the person is a Planning Center organization administrator.
   * A person the directory does not know yet is added under the name given; one it knows keeps
   * their name. Once the church has an admin, every later connect is refused and changes nothing.
   */
  connectChurch(
    identity: Identity,
    name: string,
    tokenHash: string,
  ): 'connected' | 'already-connected' {
    const sql = this.ctx.storage.sql
    return this.ctx.storage.transactionSync(() => {
      this.createTables()
      if (this.adminCount(identity.churchId) > 0) return 'already-connected'
      sql.exec(
        `INSERT INTO people (church_id, person_id, name, role) VALUES (?, ?, ?, 'admin')
         ON CONFLICT (church_id, person_id) DO UPDATE SET role = 'admin', left_at = NULL`,
        identity.churchId,
        identity.personId,
        name,
      )
      this.insertSession(identity, tokenHash)
      return 'connected'
    })
  }

  /**
   * The person a session belongs to, or null when there is no such session, it is past its
   * lifetime, or this directory no longer knows the person. A session past its lifetime is deleted.
   */
  sessionIdentity(churchId: string, tokenHash: string): string | null {
    const personId = this.liveSession(churchId, tokenHash)
    if (personId === null) return null
    return this.knows({ churchId, personId }) ? personId : null
  }

  /**
   * The person of a session within its lifetime, whether or not the directory still knows them,
   * or null. A session past its lifetime is deleted on the way, and a directory without tables
   * writes nothing.
   */
  private liveSession(churchId: string, tokenHash: string): string | null {
    if (!this.tablesExist()) return null
    const sql = this.ctx.storage.sql
    const row = sql
      .exec<{ person_id: string; created_at: string }>(
        'SELECT person_id, created_at FROM sessions WHERE church_id = ? AND token_hash = ?',
        churchId,
        tokenHash,
      )
      .toArray()[0]
    if (row === undefined) return null
    if (Date.parse(row.created_at) + SESSION_LIFETIME_MS <= Date.now()) {
      this.ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM sessions WHERE church_id = ? AND token_hash = ?', churchId, tokenHash)
        this.deleteDevicesWithoutSession(churchId, [row.person_id])
      })
      return null
    }
    return row.person_id
  }

  /**
   * Ends one session, as its holder signs out, and with a device token of the session's person
   * deletes that device, so the phone stops alerting. A token of another person's device is left
   * alone. The person need not be current: one who left can still end a session they hold.
   * Answers `no-session`, writing nothing, when there is no such session within its lifetime.
   */
  endSession(churchId: string, tokenHash: string, deviceToken?: string): 'ended' | 'no-session' {
    const personId = this.liveSession(churchId, tokenHash)
    if (personId === null) return 'no-session'
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM sessions WHERE church_id = ? AND token_hash = ?', churchId, tokenHash)
      if (deviceToken !== undefined) {
        sql.exec(
          'DELETE FROM devices WHERE church_id = ? AND token = ? AND person_id = ?',
          churchId,
          deviceToken,
          personId,
        )
      }
    })
    return 'ended'
  }

  /**
   * Ends every session of a current person of the caller's church, as an admin, and deletes every
   * device of theirs, so no phone of theirs reads or alerts until they sign in again. Answers the
   * channels the person may open, as a member or by oversight, whose sockets the caller closes
   * next. It works on any current person, another admin and the caller included, and a person
   * with no session answers the same.
   */
  endPersonSessions(identity: Identity, personId: string): { channelIds: string[] } | Refusal {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayEndSessions(caller.role)) return 'forbidden'
    if (this.currentPerson({ churchId: identity.churchId, personId }) === null) return 'not-found'
    const sql = this.ctx.storage.sql
    return this.ctx.storage.transactionSync(() => {
      sql.exec(
        'DELETE FROM sessions WHERE church_id = ? AND person_id = ?',
        identity.churchId,
        personId,
      )
      sql.exec(
        'DELETE FROM devices WHERE church_id = ? AND person_id = ?',
        identity.churchId,
        personId,
      )
      const channelIds: string[] = []
      for (const pair of this.openable(identity.churchId).keys()) {
        const [channelId, holder] = pair.split('\n') as [string, string]
        if (holder === personId) channelIds.push(channelId)
      }
      return { channelIds: channelIds.sort() }
    })
  }

  /**
   * Deletes the church's sessions past their lifetime. The roster sync runs it on every tick, so
   * a session never presented again leaves nothing behind. Writes nothing, and creates no table,
   * in a directory without them.
   */
  pruneSessions(churchId: string): void {
    if (!this.tablesExist()) return
    // ISO 8601 UTC strings of one format sort in time order.
    const cutoff = new Date(Date.now() - SESSION_LIFETIME_MS).toISOString()
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      const expired = sql
        .exec<{ person_id: string }>(
          'SELECT DISTINCT person_id FROM sessions WHERE church_id = ? AND created_at <= ?',
          churchId,
          cutoff,
        )
        .toArray()
        .map((expiredRow) => expiredRow.person_id)
      sql.exec('DELETE FROM sessions WHERE church_id = ? AND created_at <= ?', churchId, cutoff)
      this.deleteDevicesWithoutSession(churchId, expired)
    })
  }

  /**
   * Deletes every device of each of these persons who holds no session any more, so a phone stops
   * alerting once the last session of its person is gone. A person who still holds a session keeps
   * every device, since a device is not linked to the session that registered it.
   */
  private deleteDevicesWithoutSession(churchId: string, personIds: string[]): void {
    for (const personId of personIds) {
      this.ctx.storage.sql.exec(
        `DELETE FROM devices WHERE church_id = ? AND person_id = ?
           AND NOT EXISTS (SELECT 1 FROM sessions WHERE church_id = ? AND person_id = ?)`,
        churchId,
        personId,
        churchId,
        personId,
      )
    }
  }

  /**
   * Stores a church's sync connection: the sync account's tokens, who connected it and when. It
   * replaces any earlier connection.
   */
  connectSync(connection: SyncConnection): void {
    this.ctx.storage.transactionSync(() => {
      this.createTables()
      this.ctx.storage.sql.exec(
        'DELETE FROM sync_connection WHERE church_id = ?',
        connection.churchId,
      )
      this.ctx.storage.sql.exec(
        `INSERT INTO sync_connection
           (church_id, access_token, refresh_token, expires_at, connected_by, connected_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        connection.churchId,
        connection.tokens.accessToken,
        connection.tokens.refreshToken,
        connection.tokens.expiresAt,
        connection.connectedBy,
        connection.connectedAt,
      )
    })
  }

  /** The church's sync connection, or null when no sync account is connected. */
  syncConnection(churchId: string): SyncConnection | null {
    if (!this.tablesExist()) return null
    const row = this.ctx.storage.sql
      .exec<{
        access_token: string
        refresh_token: string
        expires_at: number
        connected_by: string
        connected_at: string
      }>(
        `SELECT access_token, refresh_token, expires_at, connected_by, connected_at
         FROM sync_connection WHERE church_id = ?`,
        churchId,
      )
      .toArray()[0]
    if (row === undefined) return null
    return {
      churchId,
      tokens: {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
      },
      connectedBy: row.connected_by,
      connectedAt: row.connected_at,
    }
  }

  /**
   * The sync account's access token, refreshed first when it is about to expire (the new pair
   * stored before it answers). Null when the church has no sync connection; throws when Planning
   * Center refuses the refresh. Every call made with the sync account's token gets it here, so
   * the church refreshes one at a time: Planning Center rotates the refresh token and refuses a
   * second refresh with the same one. A call that arrives during a refresh waits for it and gets
   * the same token, or the same refusal.
   */
  async syncAccessToken(churchId: string): Promise<string | null> {
    // The read and the check of `refreshing` run in one synchronous turn, so a call that comes
    // after a refresh stored its pair reads that pair and does not refresh again.
    const tokens = this.syncConnection(churchId)?.tokens
    if (tokens === undefined) return null
    if (tokens.expiresAt - Date.now() >= REFRESH_MARGIN_MS) return tokens.accessToken
    // An awaited fetch lets other calls into the object, so the refresh is shared rather than
    // held behind `blockConcurrencyWhile`, which would stall every call to the church.
    this.refreshing ??= this.refreshSyncTokens(churchId, tokens.refreshToken).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  /** Refreshes the sync account's tokens and stores the new pair, answering its access token. */
  private async refreshSyncTokens(churchId: string, refreshToken: string): Promise<string> {
    const refreshed = await refreshTokens(refreshToken, {
      clientId: this.env.PCO_CLIENT_ID,
      clientSecret: this.env.PCO_CLIENT_SECRET,
    })
    if (refreshed === null) throw new Error('Planning Center refused to refresh the sync token')
    this.storeSyncTokens(churchId, refreshed)
    return refreshed.accessToken
  }

  /** Replaces the sync account's tokens after a refresh, keeping who connected it. */
  private storeSyncTokens(churchId: string, tokens: PlanningCenterTokens): void {
    this.ctx.storage.sql.exec(
      `UPDATE sync_connection SET access_token = ?, refresh_token = ?, expires_at = ?
       WHERE church_id = ?`,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt,
      churchId,
    )
  }

  /**
   * Applies a whole synced roster in one transaction: people added, renamed, marked as on a team or
   * not, or marked as left when they are on no team and in no synced Group (and back when they
   * return), except that an admin or chat admin on no team and in no Group stays, and anyone the
   * age rule dropped leaves whatever their role. Every admin and chat admin counts as serving
   * whether or not they are on a team or in a Group (`countsAsServing`); each roster person's
   * birthdate and photo made exactly the roster's, and a dropped person's photo deleted; the Group
   * types Planning Center listed (when they were read); the synced channels created or renamed;
   * and the memberships of every synced channel made exactly the roster's.
   * Each channel a person could open before and cannot now is recorded as a pending eviction in
   * the same transaction, so their live sockets get closed even when this sync's eviction fails.
   */
  applyRoster(churchId: string, roster: SyncedRoster): void {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      this.createTables()
      const before = this.openable(churchId)

      const now = new Date().toISOString()
      for (const person of roster.people) {
        sql.exec(
          `INSERT INTO people (church_id, person_id, name, serves, left_at) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (church_id, person_id)
           DO UPDATE SET name = excluded.name, serves = excluded.serves, left_at = NULL`,
          churchId,
          person.personId,
          person.name,
          person.serves ? 1 : 0,
        )
        // Planning Center is the one source of a birthdate: none there is none here.
        if (person.birthdate === null) {
          sql.exec(
            'DELETE FROM birthdates WHERE church_id = ? AND person_id = ?',
            churchId,
            person.personId,
          )
        } else {
          sql.exec(
            `INSERT INTO birthdates (church_id, person_id, birthdate) VALUES (?, ?, ?)
             ON CONFLICT (church_id, person_id) DO UPDATE SET birthdate = excluded.birthdate`,
            churchId,
            person.personId,
            person.birthdate,
          )
        }
        // The same for a photo, which the sync keeps only for an adult (`syncedAvatar`).
        if (person.avatar === null) {
          sql.exec(
            'DELETE FROM avatars WHERE church_id = ? AND person_id = ?',
            churchId,
            person.personId,
          )
        } else {
          sql.exec(
            `INSERT INTO avatars (church_id, person_id, url) VALUES (?, ?, ?)
             ON CONFLICT (church_id, person_id) DO UPDATE SET url = excluded.url`,
            churchId,
            person.personId,
            person.avatar,
          )
        }
      }
      for (const personId of roster.dropped) {
        sql.exec('DELETE FROM avatars WHERE church_id = ? AND person_id = ?', churchId, personId)
      }
      const current = new Set(roster.people.map((person) => person.personId))
      const dropped = new Set(roster.dropped)
      for (const { person_id, role } of sql
        .exec<{ person_id: string; role: string }>(
          'SELECT person_id, role FROM people WHERE church_id = ? AND left_at IS NULL',
          churchId,
        )
        .toArray()) {
        if (current.has(person_id)) continue
        if (staysWithoutRoster(toRole(role)) && !dropped.has(person_id)) {
          // Kept current by their role on no team. Their role still counts them as serving
          // (`countsAsServing`), until a demotion gives them the plain member rule.
          sql.exec(
            'UPDATE people SET serves = 0 WHERE church_id = ? AND person_id = ?',
            churchId,
            person_id,
          )
          continue
        }
        sql.exec(
          'UPDATE people SET left_at = ? WHERE church_id = ? AND person_id = ?',
          now,
          churchId,
          person_id,
        )
      }

      if (roster.groupTypes !== null) {
        sql.exec('UPDATE group_types SET present = 0 WHERE church_id = ?', churchId)
        for (const type of roster.groupTypes) {
          sql.exec(
            `INSERT INTO group_types (church_id, group_type_id, name) VALUES (?, ?, ?)
             ON CONFLICT (church_id, group_type_id)
             DO UPDATE SET name = excluded.name, present = 1`,
            churchId,
            type.groupTypeId,
            type.name,
          )
        }
      }

      for (const channel of roster.channels) {
        sql.exec(
          `INSERT INTO channels (church_id, channel_id, name, kind) VALUES (?, ?, ?, ?)
           ON CONFLICT (church_id, channel_id) DO UPDATE SET name = ${
             channel.keepName ? 'channels.name' : 'excluded.name'
           }`,
          churchId,
          channel.channelId,
          channel.name,
          channel.kind,
        )
      }

      const wanted = new Set(roster.memberships.map((m) => `${m.channelId}\n${m.personId}`))
      for (const row of sql
        .exec<{ channel_id: string; person_id: string }>(
          `SELECT m.channel_id, m.person_id FROM memberships m
           JOIN channels c ON c.church_id = m.church_id AND c.channel_id = m.channel_id
           WHERE m.church_id = ? AND c.kind IN (${SYNCED_KINDS.map(() => '?').join(', ')})`,
          churchId,
          ...SYNCED_KINDS,
        )
        .toArray()) {
        if (!wanted.has(`${row.channel_id}\n${row.person_id}`)) {
          sql.exec(
            'DELETE FROM memberships WHERE church_id = ? AND channel_id = ? AND person_id = ?',
            churchId,
            row.channel_id,
            row.person_id,
          )
        }
      }
      for (const membership of roster.memberships) {
        sql.exec(
          'INSERT OR IGNORE INTO memberships (church_id, channel_id, person_id) VALUES (?, ?, ?)',
          churchId,
          membership.channelId,
          membership.personId,
        )
      }

      // Every synced team channel's leaders are exactly the roster's.
      sql.exec(
        `DELETE FROM team_leaders WHERE church_id = ? AND channel_id IN (
           SELECT channel_id FROM channels WHERE church_id = ? AND kind = 'team')`,
        churchId,
        churchId,
      )
      for (const leader of roster.leaders) {
        sql.exec(
          'INSERT OR IGNORE INTO team_leaders (church_id, channel_id, person_id) VALUES (?, ?, ?)',
          churchId,
          leader.channelId,
          leader.personId,
        )
      }

      // A request is only for a current person with no birthdate on file.
      sql.exec(
        `DELETE FROM birthdate_requests WHERE church_id = ? AND person_id IN (
           SELECT person_id FROM birthdates WHERE church_id = ?
           UNION SELECT person_id FROM people WHERE church_id = ? AND left_at IS NOT NULL)`,
        churchId,
        churchId,
        churchId,
      )

      const after = this.openable(churchId)
      for (const [pair, access] of before) {
        // Kept when still open the same way, or now as a member. An admin taken out of a channel
        // still loses the socket they had as a member, so a reopen by oversight is a new look.
        const now = after.get(pair)
        if (now === access || now === 'member') continue
        const [channelId, personId] = pair.split('\n') as [string, string]
        this.recordPendingEviction(churchId, channelId, personId, access)
      }
    })
  }

  /**
   * Every person and channel whose live sockets are still to be closed. A pair the person may open
   * again as a member, because a later sync gave the channel back, is dropped instead. Oversight
   * alone never drops one, so an admin taken out of a channel still has the socket closed.
   */
  pendingEvictions(
    churchId: string,
  ): Array<{ personId: string; channelId: string; takeMentions: boolean }> {
    if (!this.tablesExist()) return []
    const sql = this.ctx.storage.sql
    const openable = this.openable(churchId)
    const oversightOnly = this.tableExists('pending_oversight_evictions')
      ? `UNION SELECT channel_id, person_id, 0 AS take_mentions FROM pending_oversight_evictions
         WHERE church_id = ?`
      : ''
    const rows = sql
      .exec<{ channel_id: string; person_id: string; take_mentions: number }>(
        `SELECT channel_id, person_id, MAX(take_mentions) AS take_mentions
         FROM (SELECT channel_id, person_id, 1 AS take_mentions FROM pending_evictions
               WHERE church_id = ? ${oversightOnly})
         GROUP BY channel_id, person_id
         ORDER BY channel_id, person_id`,
        ...(oversightOnly === '' ? [churchId] : [churchId, churchId]),
      )
      .toArray()
    const pending: Array<{ personId: string; channelId: string; takeMentions: boolean }> = []
    for (const row of rows) {
      const eviction = { personId: row.person_id, channelId: row.channel_id }
      if (openable.get(`${row.channel_id}\n${row.person_id}`) === 'member') {
        this.evicted(churchId, eviction)
      } else {
        pending.push({ ...eviction, takeMentions: row.take_mentions === 1 })
      }
    }
    return pending
  }

  /**
   * Clears a pending eviction once the person's sockets on the channel are closed, and takes the
   * unread mentions they had there out of their total in the same transaction. Only a pending
   * eviction still on file takes them, so a retried one takes nothing twice. An oversight-only
   * eviction (`takeMentions: false`) clears only its own row, leaving a lost membership for the next
   * tick to take with its mentions.
   */
  evicted(
    churchId: string,
    eviction: { personId: string; channelId: string; takeMentions?: boolean },
    mentions = 0,
  ): void {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      const cleared =
        eviction.takeMentions === false
          ? 0
          : sql.exec(
              'DELETE FROM pending_evictions WHERE church_id = ? AND channel_id = ? AND person_id = ?',
              churchId,
              eviction.channelId,
              eviction.personId,
            ).rowsWritten
      if (this.tableExists('pending_oversight_evictions')) {
        sql.exec(
          `DELETE FROM pending_oversight_evictions
           WHERE church_id = ? AND channel_id = ? AND person_id = ?`,
          churchId,
          eviction.channelId,
          eviction.personId,
        )
      }
      if (cleared > 0 && mentions > 0) this.addMentions(churchId, eviction.personId, -mentions)
    })
  }

  /**
   * Every `<channelId>\n<personId>` pair the full grant rule lets a current person open, and
   * whether they open it as a member or only by oversight, so a departed admin's oversight sockets
   * close too.
   */
  private openable(churchId: string): Map<string, 'member' | 'oversight'> {
    const rows = this.ctx.storage.sql
      .exec<{
        channel_id: string
        person_id: string
        role: string
        kind: string
        is_member: number
        serves: number
        birthdate: string | null
        member_count: number
      }>(
        `SELECT c.channel_id, p.person_id, p.role, c.kind, (m.person_id IS NOT NULL) AS is_member,
                p.serves, b.birthdate, ${MEMBER_COUNT} AS member_count
         FROM people p
         JOIN channels c ON c.church_id = p.church_id
         LEFT JOIN memberships m ON m.church_id = c.church_id AND m.channel_id = c.channel_id
           AND m.person_id = p.person_id
         LEFT JOIN birthdates b ON b.church_id = p.church_id AND b.person_id = p.person_id
         WHERE p.church_id = ? AND p.left_at IS NULL`,
        adultCutoff(),
        churchId,
      )
      .toArray()
    const openable = new Map<string, 'member' | 'oversight'>()
    for (const row of rows) {
      const pair = `${row.channel_id}\n${row.person_id}`
      const role = toRole(row.role)
      const standing = {
        isMember: row.is_member === 1,
        serves: countsAsServing(role, row.serves === 1),
        minor: isMinor(row.birthdate),
        memberCount: row.member_count,
      }
      if (mayOpenAsMember(row.kind, standing)) openable.set(pair, 'member')
      else if (mayOpen(role, row.kind, standing)) openable.set(pair, 'oversight')
    }
    return openable
  }

  /**
   * Every channel of the church that a person with a role, who serves or not and is a minor or not,
   * may open, by the full grant rule.
   */
  private openableBy(
    churchId: string,
    personId: string,
    role: Role,
    serves: boolean,
    minor: boolean,
  ): Map<string, 'member' | 'oversight'> {
    const rows = this.ctx.storage.sql
      .exec<{ channel_id: string; kind: string; is_member: number; member_count: number }>(
        `SELECT c.channel_id, c.kind, (m.person_id IS NOT NULL) AS is_member,
                ${MEMBER_COUNT} AS member_count
         FROM channels c
         LEFT JOIN memberships m
           ON m.church_id = c.church_id AND m.channel_id = c.channel_id AND m.person_id = ?
         WHERE c.church_id = ?`,
        adultCutoff(),
        personId,
        churchId,
      )
      .toArray()
    const openable = new Map<string, 'member' | 'oversight'>()
    for (const row of rows) {
      const standing = {
        isMember: row.is_member === 1,
        serves,
        minor,
        memberCount: row.member_count,
      }
      if (mayOpenAsMember(row.kind, standing)) openable.set(row.channel_id, 'member')
      else if (mayOpen(role, row.kind, standing)) openable.set(row.channel_id, 'oversight')
    }
    return openable
  }

  /**
   * Records that a person lost a channel, so their sockets there get closed. Losing it as a member
   * also takes their unread mentions there out of their total; losing oversight alone does not,
   * since an earlier loss of membership already took them.
   */
  private recordPendingEviction(
    churchId: string,
    channelId: string,
    personId: string,
    lost: 'member' | 'oversight',
  ): void {
    const sql = this.ctx.storage.sql
    if (lost === 'member') {
      sql.exec(
        `INSERT OR IGNORE INTO pending_evictions (church_id, channel_id, person_id)
         VALUES (?, ?, ?)`,
        churchId,
        channelId,
        personId,
      )
      return
    }
    sql.exec(PENDING_OVERSIGHT_EVICTIONS_TABLE)
    sql.exec(
      `INSERT OR IGNORE INTO pending_oversight_evictions (church_id, channel_id, person_id)
       VALUES (?, ?, ?)`,
      churchId,
      channelId,
      personId,
    )
  }

  /**
   * The kind of a channel whose alerts a person may read and set: they may open it as a member.
   * A channel they may not open at all is `not-found`, and one they read only by oversight is
   * `forbidden`, since they get no alerts from it.
   */
  private alertKind(identity: Identity, channelId: string): ChannelKind | { refusal: Refusal } {
    const caller = this.currentPerson(identity)
    if (caller === null) return { refusal: 'not-known' }
    const kind = this.kindOf(identity.churchId, channelId)
    if (kind === null) return { refusal: 'not-found' }
    const standing = this.standing(identity, channelId, caller)
    if (!mayOpen(caller.role, kind, standing)) return { refusal: 'not-found' }
    if (!mayOpenAsMember(kind, standing)) return { refusal: 'forbidden' }
    return kind
  }

  /** A person's stored alert level for a channel, or the kind's default. */
  private alertLevelOf(identity: Identity, channelId: string, kind: ChannelKind): AlertLevel {
    const stored = this.ctx.storage.sql
      .exec<{ level: string }>(
        'SELECT level FROM alert_levels WHERE church_id = ? AND person_id = ? AND channel_id = ?',
        identity.churchId,
        identity.personId,
        channelId,
      )
      .toArray()[0]?.level
    return isAlertLevel(stored) ? stored : defaultAlertLevel(kind)
  }

  /**
   * Every current person who may open a channel as a member, sorted by name, with their stored
   * alert level for it, if any, and their quiet hours, if any.
   */
  private channelMemberPeople(
    churchId: string,
    channelId: string,
    kind: ChannelKind,
  ): Array<{
    personId: string
    name: string
    level: AlertLevel | null
    quietHours: QuietHours | null
  }> {
    const memberCount = this.memberCountOf(churchId, channelId)
    return this.ctx.storage.sql
      .exec<{
        person_id: string
        name: string
        is_member: number
        role: string
        serves: number
        birthdate: string | null
        level: string | null
        start_time: string | null
        end_time: string | null
        time_zone: string | null
      }>(
        `SELECT p.person_id, p.name, (m.person_id IS NOT NULL) AS is_member, p.role, p.serves,
                b.birthdate, a.level, q.start_time, q.end_time, q.time_zone
         FROM people p
         LEFT JOIN memberships m
           ON m.church_id = p.church_id AND m.channel_id = ? AND m.person_id = p.person_id
         LEFT JOIN alert_levels a
           ON a.church_id = p.church_id AND a.channel_id = ? AND a.person_id = p.person_id
         LEFT JOIN quiet_hours q ON q.church_id = p.church_id AND q.person_id = p.person_id
         LEFT JOIN birthdates b ON b.church_id = p.church_id AND b.person_id = p.person_id
         WHERE p.church_id = ? AND p.left_at IS NULL
         ORDER BY p.name, p.person_id`,
        channelId,
        channelId,
        churchId,
      )
      .toArray()
      .filter((row) =>
        mayOpenAsMember(kind, {
          isMember: row.is_member === 1,
          serves: countsAsServing(toRole(row.role), row.serves === 1),
          minor: isMinor(row.birthdate),
          memberCount,
        }),
      )
      .map((row) => ({
        personId: row.person_id,
        name: row.name,
        level: isAlertLevel(row.level) ? row.level : null,
        quietHours:
          row.start_time !== null && row.end_time !== null && row.time_zone !== null
            ? { start: row.start_time, end: row.end_time, timeZone: row.time_zone }
            : null,
      }))
  }

  /** The @mentions a post keeps, as `postAccess` describes them. */
  private keptMentions(
    identity: Identity,
    channelId: string,
    kind: ChannelKind,
    mentions: unknown,
  ): string[] {
    if (!Array.isArray(mentions) || !mentions.every((id) => typeof id === 'string')) return []
    const reachable = new Set(
      this.channelMemberPeople(identity.churchId, channelId, kind).map((p) => p.personId),
    )
    reachable.delete(identity.personId)
    return [...new Set(mentions as string[])]
      .filter((personId) => reachable.has(personId))
      .slice(0, MAX_MENTIONS)
  }

  /** Why a caller may not read or set a channel's members, or null when they may. */
  private memberChange(identity: Identity, channelId: string): Refusal | null {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    const kind = this.kindOf(identity.churchId, channelId)
    if (kind === null) return 'not-found'
    // A minor admin cannot open a private channel (phon#17), so its members stay unknown to them.
    if (kind === 'private' && maySetMembers(caller.role) && !caller.minor) return null
    // Not found, never forbidden, for a channel the caller cannot open, so a private channel
    // stays unknown to everyone outside it but the admins.
    if (!mayOpen(caller.role, kind, this.standing(identity, channelId, caller))) {
      return 'not-found'
    }
    return 'forbidden'
  }

  /**
   * A private channel's member set from a request: distinct current people of the church, at least
   * three, and no minor among them, since a minor cannot open a private channel (phon#17). Null for
   * anything else.
   */
  private validMembers(churchId: string, personIds: unknown): string[] | null {
    if (!Array.isArray(personIds) || !personIds.every((id) => typeof id === 'string')) return null
    const members = [...new Set(personIds as string[])]
    if (members.length < PRIVATE_CHANNEL_MINIMUM) return null
    for (const personId of members) {
      const person = this.currentPerson({ churchId, personId })
      if (person === null || person.minor) return null
    }
    return members
  }

  private memberIdsOf(churchId: string, channelId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ person_id: string }>(
        `SELECT person_id FROM memberships WHERE church_id = ? AND channel_id = ?
         ORDER BY person_id`,
        churchId,
        channelId,
      )
      .toArray()
      .map((row) => row.person_id)
  }

  /** Whether a channel of the church already has this name, ignoring case. */
  private nameTaken(churchId: string, name: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          'SELECT 1 FROM channels WHERE church_id = ? AND lower(name) = lower(?)',
          churchId,
          name,
        )
        .toArray().length > 0
    )
  }

  private kindOf(churchId: string, channelId: string): ChannelKind | null {
    if (!this.tablesExist()) return null
    const row = this.ctx.storage.sql
      .exec<{ kind: string }>(
        'SELECT kind FROM channels WHERE church_id = ? AND channel_id = ?',
        churchId,
        channelId,
      )
      .toArray()[0]
    return row === undefined ? null : (row.kind as ChannelKind)
  }

  /** How many current admins the church has. */
  private adminCount(churchId: string): number {
    return this.ctx.storage.sql
      .exec(
        "SELECT 1 FROM people WHERE church_id = ? AND role = 'admin' AND left_at IS NULL",
        churchId,
      )
      .toArray().length
  }

  /**
   * A current person of the church, with their name, their role, whether they serve on a team as
   * the roster sync stored it (`onTeam`), whether they count as serving with that role (`serves`),
   * and whether the birthdate on file, or none, makes them a minor (`minor`), or null.
   */
  private currentPerson(
    identity: Identity,
  ): { name: string; role: Role; onTeam: boolean; serves: boolean; minor: boolean } | null {
    if (!this.tablesExist()) return null
    const row = this.ctx.storage.sql
      .exec<{ name: string; role: string; serves: number; birthdate: string | null }>(
        `SELECT p.name, p.role, p.serves, b.birthdate FROM people p
         LEFT JOIN birthdates b ON b.church_id = p.church_id AND b.person_id = p.person_id
         WHERE p.church_id = ? AND p.person_id = ? AND p.left_at IS NULL`,
        identity.churchId,
        identity.personId,
      )
      .toArray()[0]
    if (row === undefined) return null
    const role = toRole(row.role)
    const onTeam = row.serves === 1
    return {
      name: row.name,
      role,
      onTeam,
      serves: countsAsServing(role, onTeam),
      minor: isMinor(row.birthdate),
    }
  }

  /**
   * Whether the person an identity names is a current person of their church's directory. The
   * device route asks this before it takes a push token from another church.
   */
  knows(identity: Identity): boolean {
    return (
      this.tablesExist() &&
      this.ctx.storage.sql
        .exec(
          'SELECT 1 FROM people WHERE church_id = ? AND person_id = ? AND left_at IS NULL',
          identity.churchId,
          identity.personId,
        )
        .toArray().length > 0
    )
  }

  /**
   * What the grant rule reads about a current person and a channel: whether they are its member,
   * whether they serve, whether they are a minor, and how many current people are its members.
   */
  private standing(
    identity: Identity,
    channelId: string,
    person: { serves: boolean; minor: boolean },
  ): Standing {
    return {
      isMember: this.isMember(identity, channelId),
      serves: person.serves,
      minor: person.minor,
      memberCount: this.memberCountOf(identity.churchId, channelId),
    }
  }

  /** How many current adults are members of a channel (`MEMBER_COUNT`). */
  private memberCountOf(churchId: string, channelId: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ member_count: number }>(
          `SELECT ${MEMBER_COUNT} AS member_count FROM channels c
           WHERE c.church_id = ? AND c.channel_id = ?`,
          adultCutoff(),
          churchId,
          channelId,
        )
        .toArray()[0]?.member_count ?? 0
    )
  }

  /** A person's birthdate on file, or null. */
  private birthdateOf(identity: Identity): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ birthdate: string }>(
          'SELECT birthdate FROM birthdates WHERE church_id = ? AND person_id = ?',
          identity.churchId,
          identity.personId,
        )
        .toArray()[0]?.birthdate ?? null
    )
  }

  /** A person's self-entered 18+ birthdate waiting for approval, or null. */
  private pendingBirthdateOf(identity: Identity): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ birthdate: string }>(
          'SELECT birthdate FROM birthdate_requests WHERE church_id = ? AND person_id = ?',
          identity.churchId,
          identity.personId,
        )
        .toArray()[0]?.birthdate ?? null
    )
  }

  /** Why a caller may not approve or decline a person's pending birthdate, or null when they may. */
  private birthdateDecision(identity: Identity, personId: string): Refusal | null {
    const caller = this.currentPerson(identity)
    if (caller === null) return 'not-known'
    if (!mayManageBirthdates(caller.role) || personId === identity.personId) return 'forbidden'
    const target = { churchId: identity.churchId, personId }
    if (this.currentPerson(target) === null || this.pendingBirthdateOf(target) === null) {
      return 'not-found'
    }
    return null
  }

  /**
   * The devices of these people, sorted by person and token, each with its person's unread mention
   * total as the badge.
   */
  private devicesOf(churchId: string, personIds: string[]): BadgedDevice[] {
    const wanted = new Set(personIds)
    const totals = this.mentionTotalsOf(churchId, personIds)
    return this.ctx.storage.sql
      .exec<{ token: string; person_id: string }>(
        'SELECT token, person_id FROM devices WHERE church_id = ? ORDER BY person_id, token',
        churchId,
      )
      .toArray()
      .filter((device) => wanted.has(device.person_id))
      .map((device) => ({ token: device.token, badge: totals.get(device.person_id) ?? 0 }))
  }

  /**
   * These people's stored photos, by person. A person with no row has none, and so does everyone
   * in a directory made before photos, until its next write creates the table.
   */
  private avatarsOf(churchId: string, personIds: string[]): Map<string, string> {
    if (personIds.length === 0 || !this.tableExists('avatars')) return new Map()
    const wanted = new Set(personIds)
    return new Map(
      this.ctx.storage.sql
        .exec<{ person_id: string; url: string }>(
          'SELECT person_id, url FROM avatars WHERE church_id = ?',
          churchId,
        )
        .toArray()
        .filter((row) => wanted.has(row.person_id))
        .map((row) => [row.person_id, row.url]),
    )
  }

  /** These people's unread mention totals, by person. A person with no row has none. */
  private mentionTotalsOf(churchId: string, personIds: string[]): Map<string, number> {
    if (personIds.length === 0 || !this.tableExists('mention_totals')) return new Map()
    const wanted = new Set(personIds)
    return new Map(
      this.ctx.storage.sql
        .exec<{ person_id: string; total: number }>(
          'SELECT person_id, total FROM mention_totals WHERE church_id = ?',
          churchId,
        )
        .toArray()
        .filter((row) => wanted.has(row.person_id))
        .map((row) => [row.person_id, row.total]),
    )
  }

  /** Adds to a person's unread mention total, or takes away with a negative delta, never below 0. */
  private addMentions(churchId: string, personId: string, delta: number): void {
    const sql = this.ctx.storage.sql
    sql.exec(MENTION_TOTALS_TABLE)
    sql.exec(
      `INSERT INTO mention_totals (church_id, person_id, total) VALUES (?, ?, MAX(?, 0))
       ON CONFLICT (church_id, person_id) DO UPDATE SET total = MAX(mention_totals.total + ?, 0)`,
      churchId,
      personId,
      delta,
      delta,
    )
  }

  /** A channel's name and kind, or null when the church has no such channel. */
  private channelOf(
    churchId: string,
    channelId: string,
  ): { name: string; kind: ChannelKind } | null {
    if (!this.tablesExist()) return null
    const row = this.ctx.storage.sql
      .exec<{ name: string; kind: string }>(
        'SELECT name, kind FROM channels WHERE church_id = ? AND channel_id = ?',
        churchId,
        channelId,
      )
      .toArray()[0]
    return row === undefined ? null : { name: row.name, kind: row.kind as ChannelKind }
  }

  /** Every current admin and chat admin who may open a channel, by the full grant rule. */
  private moderatorsOf(churchId: string, channelId: string, kind: ChannelKind): string[] {
    const memberCount = this.memberCountOf(churchId, channelId)
    return this.ctx.storage.sql
      .exec<{
        person_id: string
        role: string
        is_member: number
        serves: number
        birthdate: string | null
      }>(
        `SELECT p.person_id, p.role, (m.person_id IS NOT NULL) AS is_member, p.serves, b.birthdate
         FROM people p
         LEFT JOIN memberships m
           ON m.church_id = p.church_id AND m.channel_id = ? AND m.person_id = p.person_id
         LEFT JOIN birthdates b ON b.church_id = p.church_id AND b.person_id = p.person_id
         WHERE p.church_id = ? AND p.left_at IS NULL`,
        channelId,
        churchId,
      )
      .toArray()
      .filter((row) => {
        const role = toRole(row.role)
        const standing = {
          isMember: row.is_member === 1,
          serves: countsAsServing(role, row.serves === 1),
          minor: isMinor(row.birthdate),
          memberCount,
        }
        return mayModerate(role) && mayOpen(role, kind, standing)
      })
      .map((row) => row.person_id)
  }

  /** Whether a person leads the team of a team channel. */
  private leads(identity: Identity, channelId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          'SELECT 1 FROM team_leaders WHERE church_id = ? AND channel_id = ? AND person_id = ?',
          identity.churchId,
          channelId,
          identity.personId,
        )
        .toArray().length > 0
    )
  }

  private isMember(identity: Identity, channelId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          'SELECT 1 FROM memberships WHERE church_id = ? AND channel_id = ? AND person_id = ?',
          identity.churchId,
          channelId,
          identity.personId,
        )
        .toArray().length > 0
    )
  }

  /** Whether this object's tables exist, read without writing anything. */
  private tablesExist(): boolean {
    this.hasTables ||=
      this.ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .toArray().length > 0
    return this.hasTables
  }

  /** Whether one table exists, read without writing anything. */
  private tableExists(name: string): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name)
        .toArray().length > 0
    )
  }

  private createTables(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS people (
        church_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        name TEXT NOT NULL,
        -- member, chat-admin or admin: set by admins in Phon, never by the roster sync.
        role TEXT NOT NULL DEFAULT 'member',
        -- 1 when the person is on a live Services team (or was seeded, or connected the church), 0
        -- when synced only from a Group or kept by their role on no team and in no Group. Every
        -- admin and chat admin counts as serving whatever this holds (countsAsServing).
        serves INTEGER NOT NULL DEFAULT 1,
        -- Set when the roster sync finds the person on no team and in no synced Group, unless
        -- their role keeps them, or finds them under 13; a person who left is not known.
        left_at TEXT,
        PRIMARY KEY (church_id, person_id)
      );
      CREATE TABLE IF NOT EXISTS channels (
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (church_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        church_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        person_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (church_id, token_hash)
      );
      CREATE TABLE IF NOT EXISTS memberships (
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        PRIMARY KEY (church_id, channel_id, person_id)
      );
      -- A person's sockets on a channel they lost, kept until they are closed.
      CREATE TABLE IF NOT EXISTS pending_evictions (
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        PRIMARY KEY (church_id, channel_id, person_id)
      );
      -- The church's Planning Center Group types, as the latest sync saw them. Sync starts off.
      CREATE TABLE IF NOT EXISTS group_types (
        church_id TEXT NOT NULL,
        group_type_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sync_enabled INTEGER NOT NULL DEFAULT 0,
        -- 0 once a sync no longer finds the type in Planning Center; its setting is kept.
        present INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (church_id, group_type_id)
      );
      -- One row per time an admin opened a private channel they are not a member of.
      CREATE TABLE IF NOT EXISTS oversight_views (
        church_id TEXT NOT NULL,
        view_id TEXT NOT NULL,
        admin_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        PRIMARY KEY (church_id, view_id)
      );
      -- Who has seen the oversight notice, and when they first saw it.
      CREATE TABLE IF NOT EXISTS oversight_notices_seen (
        church_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (church_id, person_id)
      );
      -- One row per device's Expo push token. A token is one device, so it has one person.
      CREATE TABLE IF NOT EXISTS devices (
        church_id TEXT NOT NULL,
        token TEXT NOT NULL,
        person_id TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (church_id, token)
      );
      -- A person's chosen alert level for a channel. No row means the channel kind's default.
      CREATE TABLE IF NOT EXISTS alert_levels (
        church_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        level TEXT NOT NULL,
        PRIMARY KEY (church_id, person_id, channel_id)
      );
      -- Who leads each team channel's Services team, as the roster sync last found them.
      CREATE TABLE IF NOT EXISTS team_leaders (
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        PRIMARY KEY (church_id, channel_id, person_id)
      );
      -- A person's quiet hours: one daily window on the clock in their own time zone. No row is
      -- no quiet hours.
      CREATE TABLE IF NOT EXISTS quiet_hours (
        church_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        -- HH:MM on a 24-hour clock in time_zone; the end is not in the window.
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        -- An IANA time zone ID, such as America/Los_Angeles.
        time_zone TEXT NOT NULL,
        PRIMARY KEY (church_id, person_id)
      );
      -- A person's birthdate, YYYY-MM-DD, as Planning Center last had it. No row is none on file.
      CREATE TABLE IF NOT EXISTS birthdates (
        church_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        birthdate TEXT NOT NULL,
        PRIMARY KEY (church_id, person_id)
      );
      -- An adult's uploaded Planning Center photo URL, as the roster sync last read it. No row is
      -- no photo.
      CREATE TABLE IF NOT EXISTS avatars (
        church_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        url TEXT NOT NULL,
        PRIMARY KEY (church_id, person_id)
      );
      -- A self-entered 18+ birthdate waiting for an admin's approval, one per person.
      CREATE TABLE IF NOT EXISTS birthdate_requests (
        church_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        birthdate TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        PRIMARY KEY (church_id, person_id)
      );
      -- One row per report of a message. A report is open until a moderator closes it.
      CREATE TABLE IF NOT EXISTS reports (
        church_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        reporter_id TEXT NOT NULL,
        reported_at TEXT NOT NULL,
        closed_at TEXT,
        closed_by TEXT,
        PRIMARY KEY (church_id, report_id)
      );
      -- The live email sign-in code of an address, by the hashes of the address and the code,
      -- and the people it was sent for (a JSON array of person IDs). No address is stored. The
      -- roster sync tick sweeps an expired one that is never checked.
      CREATE TABLE IF NOT EXISTS email_codes (
        church_id TEXT NOT NULL,
        address_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        person_ids TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        wrong_tries INTEGER NOT NULL,
        PRIMARY KEY (church_id, address_hash)
      );
      -- A pending name choice after a right code for an address several known people share, by
      -- its token's hash, and the known people it may pick (a JSON array of person IDs). Once it
      -- signs someone in, it holds only that person, for a minute, so a lost answer can be
      -- retried. The roster sync tick sweeps an expired one.
      CREATE TABLE IF NOT EXISTS email_code_choices (
        church_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        person_ids TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (church_id, token_hash)
      );
      -- One row per sign-in code sent to an address in the last hour, for the send limits. The
      -- roster sync tick sweeps one an hour old, which no longer counts.
      CREATE TABLE IF NOT EXISTS email_code_sends (
        church_id TEXT NOT NULL,
        address_hash TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      -- One row per recent email code lookup in Planning Center, pruned past the budget's period
      -- on the next one, for the lookup budget.
      CREATE TABLE IF NOT EXISTS email_lookups (
        church_id TEXT NOT NULL,
        looked_at INTEGER NOT NULL
      );
      -- One row per wrong email code checked against a live one in the last hour, pruned an hour
      -- old on the next one, for the church-wide limit on wrong codes.
      CREATE TABLE IF NOT EXISTS email_code_misses (
        church_id TEXT NOT NULL,
        missed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_connection (
        church_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        connected_by TEXT NOT NULL,
        connected_at TEXT NOT NULL
      );
      ${MENTION_TOTALS_TABLE}
      ${PENDING_OVERSIGHT_EVICTIONS_TABLE}
    `)
  }
}

/** A person's sockets on a channel they could open only by oversight, kept until they are closed. */
const PENDING_OVERSIGHT_EVICTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS pending_oversight_evictions (
    church_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    PRIMARY KEY (church_id, channel_id, person_id)
  );`

/**
 * One row per person: their unread mention total across every channel they may open as a member,
 * the app icon's badge. A person with no row has none. Created by every write to it as well as by
 * `createTables`, so a directory made before it existed gets it on the first mention.
 */
const MENTION_TOTALS_TABLE = `
  CREATE TABLE IF NOT EXISTS mention_totals (
    church_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    total INTEGER NOT NULL,
    PRIMARY KEY (church_id, person_id)
  );`

/** What the grant rule reads about a person and a channel. */
interface Standing {
  /** Whether the person is one of the channel's members. */
  isMember: boolean
  /**
   * Whether the person counts as serving (`countsAsServing`): they serve on a live Services team,
   * or they hold the admin or chat admin role.
   */
  serves: boolean
  /**
   * Whether the person is a minor: 13 to 17, or with no birthdate on file, a pending 18+ one
   * included (`isMinor`).
   */
  minor: boolean
  /** How many current adults are the channel's members (`MEMBER_COUNT`). */
  memberCount: number
}

/**
 * The one grant rule, shared by channelAccess, openChannel, channelsFor, postAccess and the roster
 * sync so a later rule changes them all: the member rule, or an admin reading any channel of a
 * known kind. Oversight never widens a minor (phon#17): a minor admin opens only what the member
 * rule lets them.
 */
function mayOpen(role: Role, kind: string, standing: Standing): boolean {
  return (
    mayOpenAsMember(kind, standing) ||
    (!standing.minor && KNOWN_KINDS.has(kind) && readsEveryChannel(role))
  )
}

/**
 * The member rule, which tells the roster sync's eviction bookkeeping a member's access from an
 * admin's oversight: an open channel and announcements are open to every current person of the
 * church who serves; a team or team leads channel only to its members; and a private or small
 * group channel only to its members, once it has at least three.
 *
 * The youth rule (phon#17) caps a minor: they open announcements while they serve and the team and
 * team leads channels they are members of, and no open, small group or private channel.
 */
function mayOpenAsMember(kind: string, standing: Standing): boolean {
  if (kind === 'announcements') return standing.serves
  if (kind === 'team' || kind === 'team-leads') return standing.isMember
  if (standing.minor) return false
  if (kind === 'open') return standing.serves
  if (kind === 'private') {
    return standing.isMember && standing.memberCount >= PRIVATE_CHANNEL_MINIMUM
  }
  if (kind === 'small-group') {
    return standing.isMember && standing.memberCount >= SMALL_GROUP_MINIMUM
  }
  return false
}

/**
 * The kinds a person may create: the kinds their role allows, less an open channel when the member
 * rule would not let them open it, so no one makes a channel they cannot see as a member. A minor
 * creates none: they can open neither an open nor a private channel (phon#17).
 */
function creatableFor(person: {
  role: Role
  serves: boolean
  minor: boolean
}): CreatableChannelKind[] {
  if (person.minor) return []
  return creatableKinds(person.role).filter(
    (kind) =>
      kind !== 'open' ||
      mayOpenAsMember(kind, {
        isMember: false,
        serves: person.serves,
        minor: person.minor,
        memberCount: 0,
      }),
  )
}

/**
 * How many current adults are members of the channel `c`, as a SQL expression over a `channels c`
 * row. Only adults count toward the three a small group or private channel needs, since a minor
 * cannot open either (phon#17): two adults and a minor are never a room. It takes one parameter,
 * `adultCutoff()`, so a query that uses it in its select list binds that first.
 */
const MEMBER_COUNT = `(SELECT COUNT(*) FROM memberships mc
  JOIN people pc ON pc.church_id = mc.church_id AND pc.person_id = mc.person_id
    AND pc.left_at IS NULL
  JOIN birthdates bc ON bc.church_id = mc.church_id AND bc.person_id = mc.person_id
    AND bc.birthdate <= ?
  WHERE mc.church_id = c.church_id AND mc.channel_id = c.channel_id)`

const KNOWN_KINDS: ReadonlySet<string> = new Set<ChannelKind>([
  'announcements',
  'open',
  'private',
  'small-group',
  'team',
  'team-leads',
])

/** The most people one message may @mention. */
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/**
 * How long a session works, counted from sign-in and never renewed, so a lost phone can no longer
 * open the church's chat this long after it signed in, and stops alerting once none of its
 * person's sessions is left.
 */
const SESSION_LIFETIME_MS = 90 * DAY_MS
/** How long an email sign-in code works. */
const EMAIL_CODE_LIFETIME_MS = 10 * MINUTE_MS
/** How long a name choice works after the right code for a shared address. */
const EMAIL_CHOICE_LIFETIME_MS = 5 * MINUTE_MS
/** How long a name choice still signs in the person it signed in, for a retry after a lost answer. */
const EMAIL_CHOICE_RETRY_MS = MINUTE_MS
/** How many wrong tries use up an email sign-in code. */
const EMAIL_CODE_TRIES = 5
/** How many email sign-in codes one address may be sent in an hour, and one each minute. */
const EMAIL_SENDS_PER_HOUR = 5
/** How many email code lookups one church may make in Planning Center in each period. */
const EMAIL_LOOKUPS_PER_PERIOD = 20
/** The lookup budget's period: Planning Center's own rate period for the sync account. */
const EMAIL_LOOKUP_PERIOD_MS = 20 * 1000
/**
 * How many wrong email codes, each checked against a live one, one church may have in an hour
 * before it refuses every code check. However many addresses a caller holds, that is at most 100
 * guesses in 1,000,000 an hour per church, where the per-address limits alone allow 25 for each
 * address (5 sends of 5 tries).
 *
 * One caller alone does not reach it: the Worker lets each caller make 1 code check a minute
 * (`EMAIL_CODE_CHECKS` in wrangler.jsonc, phon#176), about 60 an hour. Cloudflare counts that
 * limit approximately, so a burst of checks sent at once can let a few more through.
 *
 * Known limit: only a known person's address holds a live code, so once a church nears the limit a
 * stranger who holds a few known addresses can tell from 503 versus 400 whether a guessed address
 * is held. Bringing a church near it takes checks from two or more callers. Counting every refused
 * check would close that, but would let anyone hold a church's email code sign-in at 503 for an
 * hour with 100 requests and no email sent (kept on 2026-11-17, phon#176).
 */
const EMAIL_CODE_MISSES_PER_HOUR = 100

const MAX_MENTIONS = 50

/** What a post asks to be beyond a plain message. */
export interface PostFlags {
  teamAnnouncement: boolean
  urgent: boolean
}

/**
 * Whether a person may post in a channel right now. A granted post carries the @mentions it keeps
 * and whether it is a team announcement or urgent.
 */
export type PostAccess =
  | { access: 'granted'; mentions: string[]; teamAnnouncement: boolean; urgent: boolean }
  | { access: 'read-only' }
  | { access: 'overseeing' }
  | { access: 'denied' }
  /** It asks to be a team announcement, and the poster does not lead this team channel. */
  | { access: 'not-team-leader' }
  /** It asks to be urgent, and the poster's role may not mark a message urgent. */
  | { access: 'not-urgent-sender' }

/** The longest a channel name may be, after trimming. */
const MAX_CHANNEL_NAME = 80

/** A stored role, read back. A value no rule knows counts as the least role, `member`. */
function toRole(stored: string): Role {
  return isRole(stored) ? stored : 'member'
}

/**
 * One channel as a person with a role sees it in the channel bar. A channel they read only by
 * oversight is marked so, and takes no posts from them. A team channel they lead is marked so,
 * since they may post team announcements there.
 */
function summary(
  id: string,
  name: string,
  kind: ChannelKind,
  role: Role,
  asMember: boolean,
  leads: boolean,
): ChannelSummary {
  if (!asMember) return { id, name, kind, canPost: false, oversight: true }
  const channel: ChannelSummary = { id, name, kind, canPost: mayPost(role, kind) }
  if (leads && kind === 'team') channel.leads = true
  return channel
}

/** The channel kinds whose members the roster sync decides. */
const SYNCED_KINDS: ChannelKind[] = ['team', 'team-leads', 'small-group']

/** A church's sync account connection, kept in its own directory. */
export interface SyncConnection {
  churchId: string
  tokens: PlanningCenterTokens
  /** The Planning Center person ID of the administrator who connected the account. */
  connectedBy: string
  /** ISO 8601. */
  connectedAt: string
}

/**
 * What a person's own birthdate entry does: under 18 it is written to Planning Center now, and 18
 * or older it waits for an admin, alerting the devices named.
 */
export type BirthdateEntry =
  | { outcome: 'write'; birthdate: string; ageGroup: Exclude<AgeGroup, 'adult'> }
  | { outcome: 'pending'; name: string; devices: BadgedDevice[] }

/**
 * A report as `fileReport` answers it: its ID, the channel's name for the push, and the devices
 * to alert, which are none for a repeat of an open report.
 */
export interface FiledReport {
  reportId: string
  channelName: string
  devices: BadgedDevice[]
}

/**
 * The open reports a moderator may see, as `openReports` answers them, without the reported
 * messages, which live in their channels.
 */
export interface OpenReports {
  seesDeleted: boolean
  reports: Array<Omit<Report, 'message'> & { messageId: string }>
}

/** What one roster sync found, ready to apply. */
export interface SyncedRoster {
  /**
   * Everyone on any team or in any synced Group, none under 13, each with whether they serve on a
   * team, their birthdate or null for none on file, and the photo the avatar rule lets them keep
   * (`syncedAvatar`) or null. Anyone else in the directory has left, unless their role keeps them
   * (`staysWithoutRoster`) and they are not among `dropped`.
   */
  people: Array<{
    personId: string
    name: string
    serves: boolean
    birthdate: string | null
    avatar: string | null
  }>
  /**
   * Everyone on a team or in a synced Group whom the age rule dropped: under 13, or marked a child
   * by Groups. Each has left, whatever their role.
   */
  dropped: string[]
  /**
   * Every Group type Planning Center listed, whether or not its sync is on, or null when this sync
   * could not read them, which keeps the list the last sync saw.
   */
  groupTypes: Array<{ groupTypeId: string; name: string }> | null
  /** The channels the sync keeps. `keepName` channels are named once, at creation. */
  channels: Array<{ channelId: string; name: string; kind: ChannelKind; keepName: boolean }>
  /** Every membership of a synced channel. Any other membership of one is removed. */
  memberships: Array<{ channelId: string; personId: string }>
  /** Every leader of a synced team channel. Any other leader of one is removed. */
  leaders: Array<{ channelId: string; personId: string }>
}
