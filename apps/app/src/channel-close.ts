/**
 * The close code the server sends a socket whose holder may no longer open the channel. It is
 * `NO_LONGER_A_MEMBER` in `apps/server/src/channel.ts`, and the two must stay the same number.
 */
export const NO_LONGER_A_MEMBER = 4403

/**
 * What the channel screen does when its live socket closes without the app asking. `evicted`: the
 * server took the person out of the channel, so the screen empties and tries no more. `dropped`:
 * the connection went, so the screen keeps what it shows, shows the notice, and opens the socket
 * again by itself after a wait, which the Reconnect button skips.
 */
export type ChannelClose = { outcome: 'evicted' } | { outcome: 'dropped'; notice: string }

/** The notice a dropped socket that had connected shows. */
export const DISCONNECTED_NOTICE = 'Disconnected from live messages'
/** The notice a socket that never connected shows. */
export const NOT_CONNECTED_NOTICE = 'Live messages could not connect'
/** The notice the channel screen shows when it could not read the channel. */
export const NOT_LOADED_NOTICE = 'This channel could not be loaded'

/**
 * Whether a socket opening again takes a notice off the channel screen. A drop's notice goes, and
 * so does a failed read's, since the socket that opens reads the channel again, and the member when
 * that read failed, and shows its own failure if a read fails again. Any other notice, such as a
 * send refused while the socket was down, stays.
 */
export function clearedOnOpen(notice: string): boolean {
  return (
    notice === DISCONNECTED_NOTICE ||
    notice === NOT_CONNECTED_NOTICE ||
    notice === NOT_LOADED_NOTICE
  )
}

/**
 * Decides what an unasked close means. `opened` is whether the socket ever connected, and `code`
 * is the close code, when the platform reports one.
 */
export function channelClosed(opened: boolean, code: number | undefined): ChannelClose {
  if (code === NO_LONGER_A_MEMBER) return { outcome: 'evicted' }
  return {
    outcome: 'dropped',
    notice: opened ? DISCONNECTED_NOTICE : NOT_CONNECTED_NOTICE,
  }
}
