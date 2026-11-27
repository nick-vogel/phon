/**
 * What sits in the composer's place on the chat screen: the composer with the send options this
 * person is offered, or the reason they cannot post. The server decides each flag; the area only
 * says why the member cannot post, and the screen only draws the answer.
 */

export type ComposerArea =
  | { kind: 'compose'; offerTeamAnnouncement: boolean; offerUrgent: boolean }
  | { kind: 'oversight' | 'read-only'; reason: string }

export interface ComposerAreaInput {
  /** An admin reads this channel by oversight, which is read only. */
  overseeing: boolean
  /** The server says this person may not post here. */
  readOnly: boolean
  /** The server says this person leads the channel's team. */
  leadsTeam: boolean
  /** The server says this person's role may mark a message urgent. */
  canMarkUrgent: boolean
}

const OVERSIGHT_REASON =
  'You read this channel as an admin. When you open a private channel you are not in, the other admins can see that you did.'
const READ_ONLY_REASON = 'Only admins and chat admins post here.'

/** Decides the composer area. Oversight beats read-only. */
export function composerArea({
  overseeing,
  readOnly,
  leadsTeam,
  canMarkUrgent,
}: ComposerAreaInput): ComposerArea {
  if (overseeing) return { kind: 'oversight', reason: OVERSIGHT_REASON }
  if (readOnly) return { kind: 'read-only', reason: READ_ONLY_REASON }
  return { kind: 'compose', offerTeamAnnouncement: leadsTeam, offerUrgent: canMarkUrgent }
}
