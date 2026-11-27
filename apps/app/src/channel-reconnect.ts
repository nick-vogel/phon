import type { Schedule } from './channel-messages'

/** The wait before the first reconnect after a drop. */
const firstDelayMs = 1000
/** The longest a dropped socket waits between tries. */
const longestDelayMs = 30_000

/**
 * How long a dropped channel socket waits before its next try, by how many tries have gone since
 * a socket last opened: 1 s, then twice as long each try, up to 30 s.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(firstDelayMs * 2 ** attempt, longestDelayMs)
}

/** When a channel screen opens its live socket again, told what its sockets do. */
export interface Reconnects {
  /** A socket closed on its own: connect again after the wait, unless a wait is already set. */
  dropped(): void
  /** A socket opened: the next drop waits 1 s again. */
  opened(): void
  /**
   * Connect now instead of waiting out the wait that is set, or in place of a retry still
   * connecting, which can hang until the platform gives up on it. Nothing when neither is so.
   */
  now(): void
  /** The screen left, or the channel refused the person: connect nothing more. */
  stop(): void
}

/**
 * Opens a dropped channel socket again by itself. Each drop sets one wait, which grows with each
 * try that drops again and starts over once a socket opens, so a long outage does not hammer the
 * server. A wait can be cut short, when the member taps Reconnect or the app comes back to the
 * foreground.
 */
export function reconnects({
  connect,
  schedule,
}: {
  connect(): void
  schedule: Schedule
}): Reconnects {
  let attempt = 0
  let stopped = false
  let cancel: (() => void) | null = null
  // A retry connected and its socket has neither opened nor dropped yet.
  let connecting = false
  const reconnect = () => {
    cancel = null
    connecting = true
    connect()
  }
  return {
    dropped() {
      connecting = false
      if (stopped || cancel !== null) return
      cancel = schedule(reconnect, reconnectDelayMs(attempt))
      attempt += 1
    },
    opened() {
      attempt = 0
      connecting = false
    },
    now() {
      if (stopped || (cancel === null && !connecting)) return
      cancel?.()
      reconnect()
    },
    stop() {
      stopped = true
      cancel?.()
      cancel = null
    },
  }
}
