import type { LastMessage } from '@phon/api-types'
import { showClock } from './clock.ts'

/** What a channel row shows of its newest message: one line of text, and its time on the right. */
export interface ChannelPreview {
  text: string
  time: string
}

/**
 * A channel row's preview of its newest message, or null when there is none to show (no messages
 * yet, or an oversight channel). The text is the author's first name, then the text, or `Photo` or
 * `GIF` with any caption, on one line. The time reads as a messages app's list does: the clock time
 * today, on the phone's 12 or 24 hour clock, then `Yesterday`, then the weekday for the rest of the
 * week, then the date. Both dates read on the phone's own clock. Pure, so a test runs it without a
 * phone.
 */
export function channelPreview(
  lastMessage: LastMessage | null | undefined,
  now: Date,
  uses24hourClock: boolean | null,
): ChannelPreview | null {
  if (lastMessage === null || lastMessage === undefined) return null
  const name = lastMessage.authorFirstName
  const line = oneLine(name === null ? content(lastMessage) : `${name}: ${content(lastMessage)}`)
  return { text: line, time: sentTime(new Date(lastMessage.sentAt), now, uses24hourClock) }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 24 * 60 * 60 * 1000

/** When a message was sent, against now. A time after now, from a skewed clock, reads as today. */
function sentTime(sent: Date, now: Date, uses24hourClock: boolean | null): string {
  const days = Math.round((midnight(now) - midnight(sent)) / DAY_MS)
  if (days <= 0) {
    const hours = String(sent.getHours()).padStart(2, '0')
    const minutes = String(sent.getMinutes()).padStart(2, '0')
    return showClock(`${hours}:${minutes}`, uses24hourClock)
  }
  if (days === 1) return 'Yesterday'
  if (days < 7) return WEEKDAYS[sent.getDay()] ?? ''
  const date = `${MONTHS[sent.getMonth()] ?? ''} ${sent.getDate()}`
  return sent.getFullYear() === now.getFullYear() ? date : `${date}, ${sent.getFullYear()}`
}

/** The start of a date's day on the phone's clock, so a day boundary is the calendar's. */
function midnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** The most of the line a row's preview keeps, so its VoiceOver label stays short. */
const PREVIEW_LENGTH = 100

/** Every run of whitespace, newlines included, as one space, cut to `PREVIEW_LENGTH`. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}…` : line
}

const IMAGE_LABELS = { photo: 'Photo', gif: 'GIF' } as const

/** The text, or for an image its label followed by any caption. */
function content(lastMessage: LastMessage): string {
  if (lastMessage.image === null) return lastMessage.body
  const label = IMAGE_LABELS[lastMessage.image]
  return lastMessage.body.trim() === '' ? label : `${label}, ${lastMessage.body}`
}
