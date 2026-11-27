import type { AlertLevel, ChannelKind, QuietHours } from '@phon/api-types'

/**
 * The alert decision: who gets a push for a message, and how. Each alert rule lives here once.
 * The church directory supplies each person's stored level, or none, and asks these functions.
 */

/** Every alert level, as the wire spells it. */
export const ALERT_LEVELS: readonly AlertLevel[] = [
  'every-message',
  'mentions-and-team-announcements',
  'mentions',
  'off',
]

export function isAlertLevel(value: unknown): value is AlertLevel {
  return typeof value === 'string' && (ALERT_LEVELS as readonly string[]).includes(value)
}

/**
 * The level a channel of a kind starts at for everyone: announcements every message, a team
 * channel @mentions and team announcements, a private channel every message, and every other kind
 * (open, team leads, small group, and any kind added later) @mentions only.
 */
export function defaultAlertLevel(kind: ChannelKind | string): AlertLevel {
  switch (kind) {
    case 'announcements':
    case 'private':
      return 'every-message'
    case 'team':
      return 'mentions-and-team-announcements'
    default:
      return 'mentions'
  }
}

/**
 * The levels a person may pick for a channel of a kind. None for announcements, which always
 * alert; team announcements exist only in team channels, so only they offer that level.
 */
export function alertChoices(kind: ChannelKind | string): AlertLevel[] {
  switch (kind) {
    case 'announcements':
      return []
    case 'team':
      return ['every-message', 'mentions-and-team-announcements', 'mentions', 'off']
    default:
      return ['every-message', 'mentions', 'off']
  }
}

/**
 * How a push interrupts the person: `active` for an ordinary alert, `time-sensitive` for an urgent
 * message, which iOS lets through Focus when the person allows it.
 */
export type InterruptionLevel = 'active' | 'time-sensitive'

/** One recipient's facts about one message, for the alert decision. */
export interface AlertCase {
  kind: ChannelKind | string
  /** The recipient's level for the channel: their stored one, or the kind's default. */
  level: AlertLevel
  /** Whether the message @mentions the recipient. */
  mentioned: boolean
  /** Whether the message is a team announcement. */
  teamAnnouncement: boolean
  /** Whether the message is urgent. */
  urgent: boolean
  /** Whether the recipient is inside their quiet hours now. */
  quiet: boolean
}

/**
 * Whether one person gets a push for one message, and how it interrupts them, or null for no
 * push. In order: an urgent message pushes as Time Sensitive at every level, `off` included, and
 * inside quiet hours; quiet hours hold every other push, announcements included; announcements
 * always alert, whatever is stored; and otherwise the person's level decides. The author is never
 * asked about their own message: the caller leaves them out.
 */
export function decideAlert(alert: AlertCase): { interruptionLevel: InterruptionLevel } | null {
  if (alert.urgent) return { interruptionLevel: 'time-sensitive' }
  if (alert.quiet) return null
  const push = { interruptionLevel: 'active' as const }
  if (alert.kind === 'announcements') return push
  switch (alert.level) {
    case 'every-message':
      return push
    case 'mentions-and-team-announcements':
      return alert.mentioned || alert.teamAnnouncement ? push : null
    case 'mentions':
      return alert.mentioned ? push : null
    case 'off':
      return null
  }
}

/** `HH:MM` on a 24-hour clock, 00:00 to 23:59. */
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Whether a time zone ID is one `Intl` knows, so the server can read the clock there. */
function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Whether a value is quiet hours as the wire spells them: a `start` and an `end` in `HH:MM`, not
 * equal, and a time zone `Intl` accepts.
 */
export function isQuietHours(value: unknown): value is QuietHours {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { start, end, timeZone } = value as Record<string, unknown>
  return (
    typeof start === 'string' &&
    typeof end === 'string' &&
    CLOCK_TIME.test(start) &&
    CLOCK_TIME.test(end) &&
    start !== end &&
    isTimeZone(timeZone)
  )
}

/** Minutes since midnight of an `HH:MM` clock time. */
function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number) as [number, number]
  return hours * 60 + minutes
}

/**
 * Whether a moment falls inside quiet hours, on the clock in the person's own time zone: the
 * Worker runs in UTC, so the zone is applied explicitly. The window holds from `start` up to, not
 * including, `end`, and runs past midnight when `end` is before `start`. A stored zone `Intl` no
 * longer accepts counts as not quiet, so a broken zone over-alerts rather than silences someone.
 */
export function inQuietHours(quietHours: QuietHours | null, now: Date): boolean {
  if (quietHours === null) return false
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: quietHours.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
  } catch {
    return false
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false
  const local = hour * 60 + minute
  const start = minutesOf(quietHours.start)
  const end = minutesOf(quietHours.end)
  return start < end ? local >= start && local < end : local >= start || local < end
}
