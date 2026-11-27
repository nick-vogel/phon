import type { ClientFrame, ServerFrame } from '@phon/api-types'
import { channelSocketEvents } from './channel-socket-events'
import { socketOrigin } from './config'
import { authorizationHeader } from './session'

export interface ChannelSocketHandlers {
  /** The server accepted the socket, so every message stored from now on comes as a frame. */
  onOpen(): void
  onFrame(frame: ServerFrame): void
  /**
   * The socket closed without the app asking. `opened` is false when it never connected at all.
   * `code` is the close code, when the platform reports one: the server sends `NO_LONGER_A_MEMBER`
   * when it takes the person out of the channel, which `channelClosed` tells apart from a drop.
   */
  onClose(opened: boolean, code: number | undefined): void
}

/** What a send carries beyond its text. */
export interface SendOptions {
  mentions?: readonly string[]
  teamAnnouncement?: boolean
  urgent?: boolean
}

export interface ChannelSocket {
  /** Whether a message sent now would go out. */
  isOpen(): boolean
  /**
   * Sends one message, with the person IDs it @mentions, and whether the person asked for a team
   * announcement or an urgent message. The server decides whether either is allowed. Returns
   * false, and sends nothing, when the socket is not open.
   */
  send(body: string, options?: SendOptions): boolean
  /** Adds the signed-in person's reaction to a message. False, and nothing sent, when not open. */
  react(messageId: string, emoji: string): boolean
  /** Takes the signed-in person's reaction off a message. False, and nothing sent, when not open. */
  unreact(messageId: string, emoji: string): boolean
  close(): void
}

/**
 * Opens a channel's live socket. The identity travels in the `Authorization` header of the
 * upgrade, through React Native's three-argument WebSocket constructor.
 */
export function openChannelSocket(
  channelId: string,
  handlers: ChannelSocketHandlers,
): ChannelSocket {
  const socket = new WebSocket(
    `${socketOrigin()}/channels/${encodeURIComponent(channelId)}/socket`,
    null,
    { headers: authorizationHeader() },
  )
  const events = channelSocketEvents(handlers, () => socket.close(1000, 'left the channel'))
  socket.onopen = () => events.opened()
  socket.onmessage = (event) => events.message(event.data)
  socket.onclose = (event) => events.closed(event.code)

  const sendFrame = (frame: ClientFrame): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  return {
    isOpen() {
      return socket.readyState === WebSocket.OPEN
    },
    send(body, { mentions = [], teamAnnouncement = false, urgent = false } = {}) {
      // Each optional field goes on the frame only when it says something.
      const frame: ClientFrame = { type: 'send', body }
      if (mentions.length > 0) frame.mentions = [...mentions]
      if (teamAnnouncement) frame.teamAnnouncement = true
      if (urgent) frame.urgent = true
      return sendFrame(frame)
    },
    react(messageId, emoji) {
      return sendFrame({ type: 'react', messageId, emoji })
    },
    unreact(messageId, emoji) {
      return sendFrame({ type: 'unreact', messageId, emoji })
    },
    close() {
      events.close()
    },
  }
}
