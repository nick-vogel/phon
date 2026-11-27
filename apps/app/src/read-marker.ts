/** A message row of the chat list, as the list reports it on screen: its ID and send time. */
export interface ShownRow {
  readonly _id: string | number
  readonly createdAt: Date | number
}

/** The read marker of one opening of the chat screen. */
export interface ReadMarks {
  /** The message rows now on screen. */
  seen(onScreen: readonly ShownRow[]): void
  /** Whether the app is in the foreground. */
  active(isActive: boolean): void
  /** The screen closed: nothing sends from here on, and an answer in flight changes nothing. */
  stop(): void
}

/**
 * The chat screen's read marker for one opening: sends the newest message on screen as the
 * member's read marker, and each newest message at most once, so an older one coming back on
 * screen, or the same one seen again, sends nothing. Each row's send time comes from the row
 * itself: the list reports a new message on screen before the screen's own state catches up. While the app is in the background it only notes the newest seen, and sends
 * it when the app is active again: a message on a locked phone's screen has not been read. A failed
 * send is dropped quietly and forgotten, so the next sighting sends it again; the server keeps the
 * marker only moving forward, so a repeat is harmless. Each marker the server took is passed to
 * `read`, even once the screen has closed, so the app can reload what a read changes (the icon's
 * badge). Pure apart from the injected `send` and `read`, so a test runs it without a phone.
 */
export function readMarks({
  send,
  read,
}: {
  send: (messageId: string) => Promise<void>
  read: (messageId: string) => void
}): ReadMarks {
  // The newest message the server took, and the newest sent or in flight.
  let confirmed: Seen | null = null
  let marked: Seen | null = null
  // The newest seen while the app was in the background, sent when it is active again.
  let waiting: Seen | null = null
  let isActive = true
  let stopped = false

  const mark = (message: Seen) => {
    marked = message
    send(message.id).then(
      () => {
        read(message.id)
        if (stopped) return
        if (newer(message, confirmed)) confirmed = message
      },
      () => {
        // Forget it, unless a newer one went since, so the next sighting sends it again.
        if (stopped || marked !== message) return
        marked = confirmed
      },
    )
  }

  return {
    seen(onScreen) {
      if (stopped) return
      let newest: Seen | null = null
      for (const row of onScreen) {
        const message = { id: String(row._id), at: Number(row.createdAt) }
        if (newer(message, newest)) newest = message
      }
      if (newest === null || !newer(newest, marked)) return
      if (isActive) mark(newest)
      else if (newer(newest, waiting)) waiting = newest
    },
    active(nowActive) {
      isActive = nowActive
      if (stopped || !isActive || waiting === null) return
      const held = waiting
      waiting = null
      if (newer(held, marked)) mark(held)
    },
    stop() {
      stopped = true
      waiting = null
    },
  }
}

/** A message seen on screen: its ID, and when it was sent, in milliseconds. */
interface Seen {
  readonly id: string
  readonly at: number
}

/** Whether a message was sent after another, or there is no other. */
function newer(message: Seen, than: Seen | null): boolean {
  return than === null || message.at > than.at
}

/**
 * The read marker's viewability config for the chat list. The chat library hands Legend List its
 * own viewability pair beside this one, and Legend List 3.7.2 keeps each pair's last viewable rows
 * under its config's `id`. Two pairs with no `id` share one record, so the library's pair reports
 * first, this one never sees a change, and no read marker is ever sent. Any pixel on screen counts.
 */
export const READ_MARKER_VIEWABILITY = { id: 'read-marker', viewAreaCoveragePercentThreshold: 0 }
