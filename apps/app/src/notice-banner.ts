import { DISCONNECTED_NOTICE, NOT_CONNECTED_NOTICE, NOT_LOADED_NOTICE } from './channel-close.ts'

/**
 * The look a notice takes. `connection`: the live connection or the channel's read failed, drawn
 * with a dropped-connection icon. `info`: any other notice, such as a send refused or a report
 * taken, drawn with an information icon, so the kind does not rest on colour.
 */
export type NoticeTone = 'connection' | 'info'

/** What the channel screen's banner draws. */
export interface NoticeBanner {
  /** The notice, word for word, or `null` when only Reconnect shows. */
  text: string | null
  tone: NoticeTone
  /** Whether the banner offers Reconnect. */
  reconnect: boolean
}

const CONNECTION_NOTICES: readonly string[] = [
  DISCONNECTED_NOTICE,
  NOT_CONNECTED_NOTICE,
  NOT_LOADED_NOTICE,
]

/**
 * How the channel screen's notice reads as a banner. The rules for when a notice shows, when it
 * goes and when Reconnect is offered stay on the screen (phon#230): this takes the notice and the
 * screen's Reconnect decision as they are, and only says how they read. Nothing is drawn when
 * there is neither.
 */
export function noticeBanner(input: {
  notice: string | null
  reconnect: boolean
}): NoticeBanner | null {
  const { notice, reconnect } = input
  if (notice === null && !reconnect) return null
  const tone: NoticeTone =
    notice === null || CONNECTION_NOTICES.includes(notice) ? 'connection' : 'info'
  return { text: notice, tone, reconnect }
}
