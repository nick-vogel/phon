import { DurableObject } from 'cloudflare:workers'
import type {
  ChannelHistory,
  ChannelSummary,
  LastMessage,
  Message,
  MessageImage,
  Reaction,
  ServerFrame,
} from '@phon/api-types'
import type { PostAccess, PostFlags } from './church-directory.ts'
import { pushMessages, sendPushes } from './expo-push.ts'

/**
 * A channel's newest live message as this object knows it: the author's ID in place of their first
 * name, which only the church directory holds.
 */
export type LastPost = Omit<LastMessage, 'authorFirstName'> & { authorId: string }

/** Who holds a socket, kept on the socket so it survives hibernation. */
export interface SocketHolder {
  churchId: string
  channelId: string
  personId: string
}

interface MessageRow extends Record<string, SqlStorageValue> {
  seq: number
  id: string
  church_id: string
  channel_id: string
  author_id: string
  body: string
  sent_at: string
  mentions: string
  deleted_at: string | null
  deleted_by: string | null
  image_id: string | null
  image_type: string | null
  team_announcement: number
  urgent: number
}

/** The headers the Worker uses to hand a verified socket holder to the channel. */
export const HOLDER_HEADERS = {
  churchId: 'x-phon-church-id',
  channelId: 'x-phon-channel-id',
  personId: 'x-phon-person-id',
} as const

/** Two churches' channels never share an object, even when their channel IDs match. */
export function channelObjectName(churchId: string, channelId: string): string {
  return `${churchId}:${channelId}`
}

/** The close code a socket gets when its holder may no longer open the channel. */
export const NO_LONGER_A_MEMBER = 4403

/**
 * One church channel: its stored messages and its open sockets. One object per church channel,
 * named `<churchId>:<channelId>`. Sockets use the Hibernation API, so an idle channel sleeps
 * without dropping anyone.
 */
export class Channel extends DurableObject<Env> {
  /**
   * The sends still being handled, in arrival order. Each send waits for the church directory's
   * post check, so they are chained to keep two quick sends from being stored out of order.
   */
  private sending: Promise<void> = Promise.resolve()

  /**
   * The pushes still to be sent, in message order. They run after each message is broadcast, on
   * their own chain, so a slow push service never holds up the next message.
   */
  private alerting: Promise<void> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        -- The person IDs it @mentions, as a JSON array.
        mentions TEXT NOT NULL DEFAULT '[]',
        -- Set when the author deletes it. The row is kept: admins still see it, marked.
        deleted_at TEXT,
        deleted_by TEXT,
        -- The image posted with it, kept in R2 under <churchId>/<channelId>/<image_id>. Both are
        -- NULL on a text message.
        image_id TEXT UNIQUE,
        image_type TEXT,
        -- 1 on a team announcement or an urgent message, as the post gate allowed it.
        team_announcement INTEGER NOT NULL DEFAULT 0,
        urgent INTEGER NOT NULL DEFAULT 0
      );
      -- One row per person, emoji and message. seq keeps the order people reacted in.
      CREATE TABLE IF NOT EXISTS reactions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        reacted_at TEXT NOT NULL,
        UNIQUE (message_id, person_id, emoji)
      );
      -- One row per pinned message: who pinned it and when. Removing the message drops its row.
      CREATE TABLE IF NOT EXISTS pins (
        message_id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        pinned_at TEXT NOT NULL,
        pinned_by TEXT NOT NULL
      );
      -- One row per person: the newest message they have seen here, by its seq, so a message
      -- deleted since keeps the marker's place. A marker only moves forward.
      CREATE TABLE IF NOT EXISTS read_markers (
        church_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (church_id, channel_id, person_id)
      );
    `)
  }

  /**
   * Accepts a socket for a holder the Worker has already authenticated and checked. Only the
   * Worker can reach this object, so the holder headers are trusted here. Access is checked again
   * once the socket is accepted: a roster sync that takes the channel from the holder after the
   * Worker's check either lands before this check or finds the socket to close.
   */
  override async fetch(request: Request): Promise<Response> {
    const holder: SocketHolder = {
      churchId: request.headers.get(HOLDER_HEADERS.churchId) ?? '',
      channelId: request.headers.get(HOLDER_HEADERS.channelId) ?? '',
      personId: request.headers.get(HOLDER_HEADERS.personId) ?? '',
    }
    if (request.headers.get('upgrade') !== 'websocket' || Object.values(holder).includes('')) {
      return new Response('Expected a WebSocket upgrade from the Worker', { status: 400 })
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(holder)
    const access = await this.env.CHURCH_DIRECTORY.getByName(holder.churchId).channelAccess(
      { churchId: holder.churchId, personId: holder.personId },
      holder.channelId,
    )
    if (access !== 'granted') {
      server.close(NO_LONGER_A_MEMBER, 'No longer a member')
      return new Response('Not found', { status: 404 })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * The channel's messages, oldest first. A deleted message is left out, unless the reader sees
   * deleted messages, who gets it marked as deleted. The Worker adds the authors' names, which the
   * church directory holds.
   */
  history(
    churchId: string,
    channelId: string,
    { withDeleted = false }: { withDeleted?: boolean } = {},
  ): Pick<ChannelHistory, 'messages'> {
    const rows = this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT seq, id, church_id, channel_id, author_id, body, sent_at, mentions, deleted_at,
                deleted_by,
                image_id, image_type, team_announcement, urgent
         FROM messages
         WHERE church_id = ? AND channel_id = ? ${withDeleted ? '' : 'AND deleted_at IS NULL'}
         ORDER BY seq`,
        churchId,
        channelId,
      )
      .toArray()
    const reactions = this.reactionsByMessage(churchId, channelId)
    const pins = this.pinsByMessage(churchId, channelId)
    return {
      messages: rows.map((row) => toMessage(row, reactions.get(row.id) ?? [], pins.get(row.id))),
    }
  }

  /**
   * Moves a person's read marker to a message of this channel, deleted or not, as the Worker has
   * already checked they read it as a member. A message older than the marker answers `marked` and
   * leaves the marker where it is. A message not in this channel is `not-found`. The @mentions of
   * them the move passes, in messages someone else wrote that are not deleted, are taken out of
   * their unread mention total in the church directory; a failed take is logged, and the next
   * channel list load corrects the total.
   */
  async markRead(
    churchId: string,
    channelId: string,
    personId: string,
    messageId: string,
  ): Promise<'marked' | 'not-found'> {
    const sql = this.ctx.storage.sql
    const row = sql
      .exec<{ seq: number }>(
        'SELECT seq FROM messages WHERE church_id = ? AND channel_id = ? AND id = ?',
        churchId,
        channelId,
        messageId,
      )
      .toArray()[0]
    if (row === undefined) return 'not-found'
    const before =
      sql
        .exec<{ seq: number }>(
          'SELECT seq FROM read_markers WHERE church_id = ? AND channel_id = ? AND person_id = ?',
          churchId,
          channelId,
          personId,
        )
        .toArray()[0]?.seq ?? 0
    const passed =
      row.seq > before
        ? sql
            .exec<{ mentions: number }>(
              `SELECT COUNT(*) AS mentions FROM messages m
               WHERE m.church_id = ? AND m.channel_id = ? AND m.deleted_at IS NULL
                 AND m.author_id != ? AND m.seq > ? AND m.seq <= ?
                 AND EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?)`,
              churchId,
              channelId,
              personId,
              before,
              row.seq,
              personId,
            )
            .one().mentions
        : 0
    sql.exec(
      `INSERT INTO read_markers (church_id, channel_id, person_id, seq, message_id, read_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (church_id, channel_id, person_id) DO UPDATE
         SET seq = excluded.seq, message_id = excluded.message_id, read_at = excluded.read_at
         WHERE excluded.seq > read_markers.seq`,
      churchId,
      channelId,
      personId,
      row.seq,
      messageId,
      new Date().toISOString(),
    )
    if (passed > 0) await this.takeMentions(churchId, channelId, [{ personId, count: passed }])
    return 'marked'
  }

  /**
   * Takes unread mentions out of people's totals in the church directory. A failed call is logged
   * and never fails the caller: the next channel list load corrects the totals.
   */
  private async takeMentions(
    churchId: string,
    channelId: string,
    taken: Array<{ personId: string; count: number }>,
  ): Promise<void> {
    try {
      await this.env.CHURCH_DIRECTORY.getByName(churchId).takeMentions(churchId, channelId, taken)
    } catch (error) {
      console.error(`Taking unread mentions in ${channelId} of ${churchId} failed`, error)
    }
  }

  /**
   * A member's summary here: whether any message after their read marker is someone else's and not
   * deleted, how many of those @mention them, and the newest message that is not deleted, whoever
   * wrote it, or null when there is none. With no marker, every such message is unread.
   */
  summaryFor(
    churchId: string,
    channelId: string,
    personId: string,
  ): Required<Pick<ChannelSummary, 'unread' | 'mentions'>> & { lastMessage: LastPost | null } {
    const sql = this.ctx.storage.sql
    const row = sql
      .exec<{ unread: number; mentions: number }>(
        `SELECT COUNT(*) AS unread,
                COALESCE(SUM(EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?)), 0)
                  AS mentions
         FROM messages m
         WHERE m.church_id = ? AND m.channel_id = ? AND m.deleted_at IS NULL
           AND m.author_id != ?
           AND m.seq > COALESCE(
             (SELECT seq FROM read_markers
              WHERE church_id = ? AND channel_id = ? AND person_id = ?),
             0)`,
        personId,
        churchId,
        channelId,
        personId,
        churchId,
        channelId,
        personId,
      )
      .one()
    const last = sql
      .exec<{
        author_id: string
        body: string
        sent_at: string
        image_id: string | null
        image_type: string | null
      }>(
        `SELECT author_id, body, sent_at, image_id, image_type FROM messages
         WHERE church_id = ? AND channel_id = ? AND deleted_at IS NULL
         ORDER BY seq DESC LIMIT 1`,
        churchId,
        channelId,
      )
      .toArray()[0]
    return {
      unread: row.unread > 0,
      mentions: row.mentions,
      lastMessage:
        last === undefined
          ? null
          : {
              authorId: last.author_id,
              body: last.body,
              image: imageKind(last.image_id, last.image_type),
              sentAt: last.sent_at,
            },
    }
  }

  /**
   * Deletes a message, as its author: the row is marked and kept. Every open socket is told at
   * once: an admin's gets the marked message, and everyone else's is told to take it out of view.
   * An unknown or already deleted message is `not-found`, and anyone but its author `forbidden`.
   */
  async deleteMessage(
    churchId: string,
    channelId: string,
    messageId: string,
    personId: string,
  ): Promise<'deleted' | 'not-found' | 'forbidden'> {
    const row = this.liveRow(churchId, channelId, messageId)
    if (row === null) return 'not-found'
    if (row.author_id !== personId) return 'forbidden'
    await this.markDeleted(row, personId)
    return 'deleted'
  }

  /**
   * Removes a message, as a moderator the Worker has already checked: marked and kept, and sent to
   * every open socket as a delete is, with the remover as `deleted.by`. An unknown or already
   * deleted message is `not-found`.
   */
  async removeMessage(
    churchId: string,
    channelId: string,
    messageId: string,
    personId: string,
  ): Promise<'removed' | 'not-found'> {
    const row = this.liveRow(churchId, channelId, messageId)
    if (row === null) return 'not-found'
    await this.markDeleted(row, personId)
    return 'removed'
  }

  /**
   * Pins a message, as a moderator the Worker has already checked, and sends it to every open
   * socket as an update. A message already pinned keeps its first pin. An unknown or deleted message
   * is `not-found`.
   */
  pin(
    churchId: string,
    channelId: string,
    messageId: string,
    personId: string,
  ): 'done' | 'not-found' {
    const row = this.liveRow(churchId, channelId, messageId)
    if (row === null) return 'not-found'
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO pins (message_id, church_id, channel_id, pinned_at, pinned_by)
       VALUES (?, ?, ?, ?, ?)`,
      messageId,
      churchId,
      channelId,
      new Date().toISOString(),
      personId,
    )
    this.broadcastUpdate(row)
    return 'done'
  }

  /**
   * Unpins a message, as a moderator the Worker has already checked, and sends it to every open
   * socket as an update. Unpinning a message that is not pinned changes nothing and is `done`. An
   * unknown or deleted message is `not-found`.
   */
  unpin(churchId: string, channelId: string, messageId: string): 'done' | 'not-found' {
    const row = this.liveRow(churchId, channelId, messageId)
    if (row === null) return 'not-found'
    this.ctx.storage.sql.exec('DELETE FROM pins WHERE message_id = ?', messageId)
    this.broadcastUpdate(row)
    return 'done'
  }

  /** Sends a live message, as it now stands, to every open socket as an update. */
  private broadcastUpdate(row: MessageRow): void {
    const message = toMessage(
      row,
      this.reactionsByMessage(row.church_id, row.channel_id).get(row.id) ?? [],
      this.pinsByMessage(row.church_id, row.channel_id).get(row.id),
    )
    for (const socket of this.ctx.getWebSockets()) send(socket, { type: 'updated', message })
  }

  /** Every pinned message's pin in a channel, by message ID. */
  private pinsByMessage(churchId: string, channelId: string): Map<string, Pin> {
    const rows = this.ctx.storage.sql
      .exec<{ message_id: string; pinned_at: string; pinned_by: string }>(
        'SELECT message_id, pinned_at, pinned_by FROM pins WHERE church_id = ? AND channel_id = ?',
        churchId,
        channelId,
      )
      .toArray()
    return new Map(rows.map((row) => [row.message_id, { at: row.pinned_at, by: row.pinned_by }]))
  }

  /** A message of this channel that is not deleted, or null, as a report reads it. */
  message(churchId: string, channelId: string, messageId: string): Message | null {
    const row = this.liveRow(churchId, channelId, messageId)
    if (row === null) return null
    return toMessage(
      row,
      this.reactionsByMessage(churchId, channelId).get(row.id) ?? [],
      this.pinsByMessage(churchId, channelId).get(row.id),
    )
  }

  /**
   * The listed messages of this channel, by ID, for the reports list. A deleted message is left
   * out, unless the reader sees deleted messages, who gets it marked as deleted.
   */
  messagesById(
    churchId: string,
    channelId: string,
    messageIds: string[],
    { withDeleted = false }: { withDeleted?: boolean } = {},
  ): Record<string, Message> {
    const wanted = new Set(messageIds)
    const byId: Record<string, Message> = {}
    for (const message of this.history(churchId, channelId, { withDeleted }).messages) {
      if (wanted.has(message.id)) byId[message.id] = message
    }
    return byId
  }

  /** A message of this channel that is not deleted, as stored, or null. */
  private liveRow(churchId: string, channelId: string, messageId: string): MessageRow | null {
    const row = this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT seq, id, church_id, channel_id, author_id, body, sent_at, mentions, deleted_at,
                deleted_by,
                image_id, image_type, team_announcement, urgent
         FROM messages WHERE church_id = ? AND channel_id = ? AND id = ?`,
        churchId,
        channelId,
        messageId,
      )
      .toArray()[0]
    return row === undefined || row.deleted_at !== null ? null : row
  }

  /**
   * Marks a message deleted by a person, clears any pin it had, so no one sees a pin on a message
   * they cannot see, and tells every open socket at once: an admin's gets the marked message, and
   * everyone else's is told to take it out of view. Each person it @mentions who had not read it
   * yet has the mention taken out of their unread mention total.
   */
  private async markDeleted(row: MessageRow, personId: string): Promise<void> {
    const deletedAt = new Date().toISOString()
    const sql = this.ctx.storage.sql
    const readers = new Map(
      sql
        .exec<{ person_id: string; seq: number }>(
          'SELECT person_id, seq FROM read_markers WHERE church_id = ? AND channel_id = ?',
          row.church_id,
          row.channel_id,
        )
        .toArray()
        .map((marker) => [marker.person_id, marker.seq]),
    )
    const unreadBy = [...new Set(readMentions(row.mentions))].filter(
      (mentioned) => mentioned !== row.author_id && (readers.get(mentioned) ?? 0) < row.seq,
    )
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        'UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?',
        deletedAt,
        personId,
        row.id,
      )
      sql.exec('DELETE FROM pins WHERE message_id = ?', row.id)
    })
    const marked = toMessage(
      { ...row, deleted_at: deletedAt, deleted_by: personId },
      this.reactionsByMessage(row.church_id, row.channel_id).get(row.id) ?? [],
    )

    const sockets = this.ctx.getWebSockets().map((socket) => ({
      socket,
      holder: socket.deserializeAttachment() as SocketHolder,
    }))
    // Asked once per delete, so a role changed while a socket was open is the current one.
    const [overseerIds] = await Promise.all([
      this.env.CHURCH_DIRECTORY.getByName(row.church_id).overseers(
        row.church_id,
        sockets.map(({ holder }) => holder.personId),
      ),
      unreadBy.length === 0
        ? undefined
        : this.takeMentions(
            row.church_id,
            row.channel_id,
            unreadBy.map((mentioned) => ({ personId: mentioned, count: 1 })),
          ),
    ])
    const overseers = new Set(overseerIds)
    for (const { socket, holder } of sockets) {
      send(
        socket,
        overseers.has(holder.personId)
          ? { type: 'updated', message: marked }
          : { type: 'removed', messageId: row.id },
      )
    }
  }

  /** Closes every socket a person holds on this channel, once they may no longer open it. */
  evict(personId: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const holder = socket.deserializeAttachment() as SocketHolder
      if (holder.personId !== personId) continue
      try {
        socket.close(NO_LONGER_A_MEMBER, 'No longer a member')
      } catch {
        // Already closed.
      }
    }
  }

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const frame = readClientFrame(data)
    const handled = this.sending.then(() => {
      if (frame?.type === 'react' || frame?.type === 'unreact')
        return this.handleReaction(ws, frame)
      return this.handleSend(ws, frame)
    })
    this.sending = handled.catch(() => {})
    return handled
  }

  /**
   * Adds or takes off the holder's reaction, then sends the message's whole set to everyone. Anyone
   * who may open the channel as a member reacts, in announcements too, where only some may post. An
   * admin who reads it only by oversight may not: oversight is read only. The directory is asked on
   * every reaction, so a role change takes effect on the next one.
   */
  private async handleReaction(ws: WebSocket, frame: ReactionFrame): Promise<void> {
    const holder = ws.deserializeAttachment() as SocketHolder
    if (!isSingleEmoji(frame.emoji)) {
      send(ws, { type: 'error', reason: 'A reaction is a single emoji.' })
      return
    }
    const sql = this.ctx.storage.sql
    const shown = sql
      .exec(
        `SELECT 1 FROM messages
         WHERE church_id = ? AND channel_id = ? AND id = ? AND deleted_at IS NULL`,
        holder.churchId,
        holder.channelId,
        frame.messageId,
      )
      .toArray()
    if (shown.length === 0) {
      send(ws, { type: 'error', reason: 'That message is not in this channel.' })
      return
    }
    const post = await this.env.CHURCH_DIRECTORY.getByName(holder.churchId).postAccess(
      { churchId: holder.churchId, personId: holder.personId },
      holder.channelId,
    )
    if (post.access === 'overseeing') {
      send(ws, {
        type: 'error',
        reason: 'You read this channel as an admin. Only its members react here.',
      })
      return
    }
    if (post.access === 'denied') {
      send(ws, { type: 'error', reason: 'You can no longer react in this channel.' })
      return
    }
    if (frame.type === 'react') {
      sql.exec(
        `INSERT OR IGNORE INTO reactions
           (church_id, channel_id, message_id, person_id, emoji, reacted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        holder.churchId,
        holder.channelId,
        frame.messageId,
        holder.personId,
        frame.emoji,
        new Date().toISOString(),
      )
    } else {
      sql.exec(
        'DELETE FROM reactions WHERE message_id = ? AND person_id = ? AND emoji = ?',
        frame.messageId,
        holder.personId,
        frame.emoji,
      )
    }
    const reactions = this.reactionsByMessage(holder.churchId, holder.channelId).get(
      frame.messageId,
    )
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, { type: 'reactions', messageId: frame.messageId, reactions: reactions ?? [] })
    }
  }

  /** Every message's reactions in a channel, by message ID. A message with none is left out. */
  private reactionsByMessage(churchId: string, channelId: string): Map<string, Reaction[]> {
    const rows = this.ctx.storage.sql
      .exec<{ message_id: string; person_id: string; emoji: string }>(
        `SELECT message_id, person_id, emoji FROM reactions
         WHERE church_id = ? AND channel_id = ? ORDER BY seq`,
        churchId,
        channelId,
      )
      .toArray()
    const byMessage = new Map<string, Reaction[]>()
    for (const row of rows) {
      const reactions = byMessage.get(row.message_id) ?? []
      byMessage.set(row.message_id, reactions)
      const reaction = reactions.find(({ emoji }) => emoji === row.emoji)
      if (reaction === undefined) reactions.push({ emoji: row.emoji, personIds: [row.person_id] })
      else reaction.personIds.push(row.person_id)
    }
    return byMessage
  }

  /**
   * Stores and broadcasts one send, once the church directory says its holder may post here, then
   * hands it to the alerts. The directory is asked on every send, so a role change takes effect on
   * the next message, and it keeps only the @mentions the channel's members can receive. A send
   * that asks to be a team announcement or urgent, and may not be, is refused whole.
   */
  private async handleSend(ws: WebSocket, frame: ClientFrameRead): Promise<void> {
    const holder = ws.deserializeAttachment() as SocketHolder
    if (frame?.type !== 'send') {
      send(ws, { type: 'error', reason: 'A message needs a non-empty text body.' })
      return
    }
    const posted = await this.post(holder, {
      body: frame.body,
      mentions: frame.mentions,
      image: null,
      flags: { teamAnnouncement: frame.teamAnnouncement, urgent: frame.urgent },
    })
    if (posted.access !== 'granted')
      send(ws, { type: 'error', reason: POST_REFUSALS[posted.access] })
  }

  /**
   * Posts a message with an image the Worker has already checked and stored in R2, in turn with the
   * channel's text sends. The body is its caption, and may be empty. The post gate is asked again
   * here, as for a send, so a role changed since the Worker's check is the one that counts.
   */
  postImage(
    holder: SocketHolder,
    caption: string,
    image: MessageImage,
    flags: PostFlags,
  ): Promise<{ access: 'granted'; message: Message } | { access: PostRefusal }> {
    const posted = this.sending.then(() =>
      this.post(holder, {
        body: caption.trim() === '' ? '' : caption,
        mentions: [],
        image,
        flags,
      }),
    )
    this.sending = posted.then(
      () => {},
      () => {},
    )
    return posted
  }

  /**
   * The one way a message is posted, a text send's and an image's alike: once the church directory
   * says its holder may post here, it is stored, broadcast to every socket, and handed to the
   * alerts. The directory is asked on every post, so a role change takes effect on the next
   * message, and it keeps only the @mentions the channel's members can receive.
   */
  private async post(
    holder: SocketHolder,
    content: { body: string; mentions: unknown; image: MessageImage | null; flags: PostFlags },
  ): Promise<{ access: 'granted'; message: Message } | { access: PostRefusal }> {
    const post = await this.env.CHURCH_DIRECTORY.getByName(holder.churchId).postAccess(
      { churchId: holder.churchId, personId: holder.personId },
      holder.channelId,
      content.mentions,
      content.flags,
    )
    if (post.access !== 'granted') return { access: post.access }

    const message: Message = {
      id: crypto.randomUUID(),
      churchId: holder.churchId,
      channelId: holder.channelId,
      authorId: holder.personId,
      body: content.body,
      sentAt: new Date().toISOString(),
      mentions: post.mentions,
      image: content.image,
      reactions: [],
    }
    if (post.teamAnnouncement) message.teamAnnouncement = true
    if (post.urgent) message.urgent = true
    // Stored before it is broadcast, so a member who sees it live also finds it in history.
    this.ctx.storage.sql.exec(
      `INSERT INTO messages
         (id, church_id, channel_id, author_id, body, sent_at, mentions, image_id, image_type,
          team_announcement, urgent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      message.churchId,
      message.channelId,
      message.authorId,
      message.body,
      message.sentAt,
      JSON.stringify(message.mentions),
      message.image?.id ?? null,
      message.image?.contentType ?? null,
      post.teamAnnouncement ? 1 : 0,
      post.urgent ? 1 : 0,
    )

    for (const socket of this.ctx.getWebSockets()) {
      send(socket, { type: 'message', message })
    }

    // A pending fetch keeps this object running, so the pushes need no waitUntil.
    this.alerting = this.alerting
      .then(() => this.alert(message))
      .catch((error: unknown) => {
        console.error(`Alerting for message ${message.id} failed`, error)
      })
    return { access: 'granted', message }
  }

  /**
   * The type of an image posted on a message of this channel, or null when no message here has
   * it. A deleted message's image is null too, unless the reader sees deleted messages.
   */
  image(
    churchId: string,
    channelId: string,
    imageId: string,
    { withDeleted = false }: { withDeleted?: boolean } = {},
  ): { contentType: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ image_type: string }>(
        `SELECT image_type FROM messages
         WHERE church_id = ? AND channel_id = ? AND image_id = ? AND image_type IS NOT NULL
           ${withDeleted ? '' : 'AND deleted_at IS NULL'}`,
        churchId,
        channelId,
        imageId,
      )
      .toArray()[0]
    return row === undefined ? null : { contentType: row.image_type }
  }

  /**
   * Sends the pushes the church directory's alert decision answers for one stored message. A
   * message deleted or removed before its pushes leave, while it waits in the queue or while the
   * directory answers, is not pushed. One deleted while it waits is not handed to the directory
   * either.
   */
  private async alert(message: Message): Promise<void> {
    if (this.liveRow(message.churchId, message.channelId, message.id) === null) return
    const targets = await this.env.CHURCH_DIRECTORY.getByName(message.churchId).alertTargets(
      message.churchId,
      message.channelId,
      {
        authorId: message.authorId,
        mentions: message.mentions,
        teamAnnouncement: message.teamAnnouncement === true,
        urgent: message.urgent === true,
      },
    )
    if (targets.pushes.length === 0) return
    if (this.liveRow(message.churchId, message.channelId, message.id) === null) return
    await sendPushes(this.env, message.churchId, pushMessages(message, targets, targets.pushes))
  }
}

/** Exactly one emoji, such as 👍, 👍🏽, 🇬🇭 or 👨‍👩‍👧: never text, and never two. */
const SINGLE_EMOJI = /^\p{RGI_Emoji}$/v

function isSingleEmoji(text: string): boolean {
  return SINGLE_EMOJI.test(text)
}

/** Why the post gate refused a post. */
export type PostRefusal = Exclude<PostAccess['access'], 'granted'>

/** The error frame each refused post gets. */
const POST_REFUSALS: Record<PostRefusal, string> = {
  'read-only': 'Only admins and chat admins post in this channel.',
  overseeing: 'You read this channel as an admin. Only its members post here.',
  denied: 'You can no longer post in this channel.',
  'not-team-leader': "Only this team's leaders post team announcements here.",
  'not-urgent-sender': 'Only admins and chat admins mark a message urgent.',
}

/** A well-formed `react` or `unreact` frame. */
interface ReactionFrame {
  type: 'react' | 'unreact'
  messageId: string
  emoji: string
}

/** A well-formed client frame, as read, or null for anything else. */
type ClientFrameRead =
  | { type: 'send'; body: string; mentions: unknown; teamAnnouncement: boolean; urgent: boolean }
  | ReactionFrame
  | null

/**
 * A well-formed `send`, `react` or `unreact` frame, or null for anything else. A send's mentions
 * are left for the church directory to check. Only `true` asks for a team announcement or an
 * urgent message; any other value is a plain send.
 */
function readClientFrame(data: string | ArrayBuffer): ClientFrameRead {
  if (typeof data !== 'string') return null
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof frame !== 'object' || frame === null) return null
  const { type, body, mentions, messageId, emoji, teamAnnouncement, urgent } = frame as Record<
    string,
    unknown
  >
  if (type === 'send') {
    if (typeof body !== 'string' || body.trim() === '') return null
    return {
      type,
      body,
      mentions: mentions ?? [],
      teamAnnouncement: teamAnnouncement === true,
      urgent: urgent === true,
    }
  }
  if (type === 'react' || type === 'unreact') {
    if (typeof messageId !== 'string' || typeof emoji !== 'string') return null
    return { type, messageId, emoji }
  }
  return null
}

function send(ws: WebSocket, frame: ServerFrame): void {
  try {
    ws.send(JSON.stringify(frame))
  } catch {
    // The socket closed between getWebSockets() and send(); it gets nothing more.
  }
}

/** Who pinned a message, and when. */
type Pin = NonNullable<Message['pinned']>

function toMessage(row: MessageRow, reactions: Reaction[], pin?: Pin): Message {
  const message: Message = {
    id: row.id,
    churchId: row.church_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    body: row.body,
    sentAt: row.sent_at,
    mentions: readMentions(row.mentions),
    image:
      row.image_id !== null && row.image_type !== null
        ? { id: row.image_id, contentType: row.image_type }
        : null,
    reactions,
  }
  if (row.deleted_at !== null && row.deleted_by !== null) {
    message.deleted = { at: row.deleted_at, by: row.deleted_by }
  }
  if (row.team_announcement === 1) message.teamAnnouncement = true
  if (row.urgent === 1) message.urgent = true
  if (pin !== undefined) message.pinned = pin
  return message
}

/** How the channel bar previews a stored image: `gif` for `image/gif`, `photo` for any other. */
function imageKind(id: string | null, type: string | null): LastMessage['image'] {
  if (id === null || type === null) return null
  return type === 'image/gif' ? 'gif' : 'photo'
}

/** A stored mentions column, read back. Anything but a JSON array of strings is no mentions. */
function readMentions(stored: string): string[] {
  try {
    const mentions: unknown = JSON.parse(stored)
    return Array.isArray(mentions) && mentions.every((id) => typeof id === 'string') ? mentions : []
  } catch {
    return []
  }
}
