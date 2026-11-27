import type { ChannelKind, ChannelSummary, Member } from '@phon/api-types'
import { type ChannelPreview, channelPreview } from './channel-preview.ts'

/** Where the channel list's load stands. */
export type ChannelListLoad =
  | { state: 'loading' }
  | { state: 'loaded'; channels: ChannelSummary[] }
  | { state: 'failed'; message: string }

/** What the channel list draws. */
export type ChannelListView =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'empty'; title: string; body: string }
  | { kind: 'channels'; sections: ChannelSection[] }

/** One channel's row. */
export interface ChannelRow {
  channel: ChannelSummary
  /** Spoken after the name: "team channel", "small group", ... */
  kindLabel: string
  /** Whether the member leads this team in Planning Center Services. */
  leads: boolean
  /** Whether the channel has a message the member has not read: the name draws bold. */
  unread: boolean
  /** Whether the member set the channel's alerts off: the name draws in muted text. */
  muted: boolean
  /** The mention badge's text, `1` to `99` then `99+`, or null when no unread message mentions them. */
  mentions: string | null
  /** The newest message on one line and its time, or null when the row shows none. */
  preview: ChannelPreview | null
  /**
   * The name, the kind, the unread state, the mention count, alerts off, the lead mark, then the
   * preview and its time, each when there is one.
   */
  accessibilityLabel: string
}

/** The clock a row's preview reads its time on. */
export interface ChannelListClock {
  now: Date
  uses24hourClock: boolean | null
}

/** Each kind as VoiceOver says it, since the row's kind icon is not an accessibility element. */
export const KIND_LABELS: Record<ChannelKind, string> = {
  announcements: 'announcements channel',
  open: 'open channel',
  private: 'private channel',
  'small-group': 'small group',
  team: 'team channel',
  'team-leads': 'team leads channel',
}

/** A group of rows: the member's own channels untitled, then the overseen ones. */
export interface ChannelSection {
  key: 'own' | 'oversight'
  title: string | null
  rows: ChannelRow[]
}

const EMPTY_TITLE = 'No channels yet'
const EMPTY_BODY =
  'Phon shows the channels of the teams and groups you serve with in Planning Center, and none include you yet. Ask your team leader or a church admin to add you, then pull down to check again.'
const EMPTY_COMPOSE = 'You can also start a channel with the New channel button.'

/**
 * The channel list's decisions, the home screen's, moved here from the drawer's channel bar so they
 * run in Node: exactly the channels the server returned for the signed-in member, in the server's
 * order. The server decides every flag, and the list hides and reorders nothing: the channels it
 * marks as oversight, which an admin reads without being in them, go under their own heading after
 * the member's own. A list with no channels says why, and offers New channel only to a member the
 * server lets create one. A row of the member's own shows its unread state, its mention badge, its
 * alerts off style and a preview of its newest message; an oversight row shows only its name.
 */
export function channelListView(
  load: ChannelListLoad,
  me: Member | null,
  at: ChannelListClock,
): ChannelListView {
  if (load.state === 'loading') return { kind: 'loading' }
  if (load.state === 'failed') return { kind: 'failed', message: load.message }
  if (load.channels.length === 0) {
    const body = mayCompose(me) ? `${EMPTY_BODY} ${EMPTY_COMPOSE}` : EMPTY_BODY
    return { kind: 'empty', title: EMPTY_TITLE, body }
  }
  const own = load.channels.filter((channel) => channel.oversight !== true)
  const overseen = load.channels.filter((channel) => channel.oversight === true)
  const sections: ChannelSection[] = []
  if (own.length > 0) {
    sections.push({ key: 'own', title: null, rows: own.map((channel) => row(channel, at)) })
  }
  if (overseen.length > 0) {
    const rows = overseen.map((channel) => row(channel, at))
    sections.push({ key: 'oversight', title: 'Oversight', rows })
  }
  return { kind: 'channels', sections }
}

/** The highest mention count the badge shows as a number. */
const MENTIONS_SHOWN = 99

function row(channel: ChannelSummary, at: ChannelListClock): ChannelRow {
  const kindLabel = KIND_LABELS[channel.kind]
  const leads = channel.leads === true
  // An oversight row shows only its name, whatever the summary carries.
  const own = channel.oversight !== true
  const unread = own && channel.unread === true
  const muted = own && channel.alertLevel === 'off'
  const count = own ? (channel.mentions ?? 0) : 0
  const mentions = count <= 0 ? null : count > MENTIONS_SHOWN ? `${MENTIONS_SHOWN}+` : String(count)
  const preview = own ? channelPreview(channel.lastMessage, at.now, at.uses24hourClock) : null
  const spoken = [channel.name, kindLabel]
  if (unread) spoken.push('unread')
  if (count > 0) spoken.push(`${count} unread ${count === 1 ? 'mention' : 'mentions'}`)
  if (muted) spoken.push('alerts off')
  if (leads) spoken.push('you lead this team')
  if (preview !== null) spoken.push(preview.text, preview.time)
  const accessibilityLabel = spoken.join(', ')
  return { channel, kindLabel, leads, unread, muted, mentions, preview, accessibilityLabel }
}

/** Whether the server lets this member create a channel of any kind. */
export function mayCompose(me: Member | null): boolean {
  return me !== null && me.canCreate.length > 0
}
