import type { ServerFrame } from '@phon/api-types'
import type { ChannelSocketHandlers } from './channel-socket'

/** What a channel socket's platform events do, and the app's own close. */
export interface ChannelSocketEvents {
  opened(): void
  message(data: unknown): void
  closed(code: number | undefined): void
  /** The app closes the socket: no event of it is passed on from now. */
  close(): void
}

/**
 * Turns one channel socket's platform events into the screen's handlers. `closeSocket` closes the
 * platform socket. Once the app closes the socket, nothing of it reaches the screen: Android cannot
 * cancel an upgrade still connecting, so a socket the app closed then can still open, and that
 * socket is closed again as it opens rather than taken for the live one.
 */
export function channelSocketEvents(
  handlers: ChannelSocketHandlers,
  closeSocket: () => void,
): ChannelSocketEvents {
  let opened = false
  let closedByApp = false
  return {
    opened() {
      if (closedByApp) {
        closeSocket()
        return
      }
      opened = true
      handlers.onOpen()
    },
    message(data) {
      if (closedByApp || typeof data !== 'string') return
      let frame: ServerFrame
      try {
        frame = JSON.parse(data) as ServerFrame
      } catch {
        return
      }
      handlers.onFrame(frame)
    },
    closed(code) {
      if (!closedByApp) handlers.onClose(opened, code)
    },
    close() {
      closedByApp = true
      closeSocket()
    },
  }
}
