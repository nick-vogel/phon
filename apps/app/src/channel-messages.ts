import type { IMessage } from '@kesha-antonov/react-native-chat'
import type { Member, Message, Reaction, ServerFrame } from '@phon/api-types'

/**
 * Adds messages to the ones a channel screen already holds, keyed by message ID, so a message that
 * arrives both live and in the history shows once. The result is in send order, oldest first.
 */
export function mergeMessages(
  current: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  // sentAt is the server's ISO 8601 timestamp, so comparing the strings compares the times.
  return [...byId.values()].sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0))
}

/**
 * What the live socket delivered during one opening of a channel screen that the history's copy
 * must not undo: the messages it sent or updated, the messages it took out of view, and each
 * message's latest reactions, by message ID.
 */
export interface FrameRecord {
  readonly live: ReadonlySet<string>
  readonly removed: ReadonlySet<string>
  readonly reactions: ReadonlyMap<string, Reaction[]>
}

/** The record at the start of an opening, before any frame. */
export function emptyFrameRecord(): FrameRecord {
  return { live: new Set(), removed: new Set(), reactions: new Map() }
}

/** Folds one frame from the socket into the record. A frame that changes nothing returns it as is. */
export function recordFrame(record: FrameRecord, frame: ServerFrame): FrameRecord {
  if (frame.type === 'message' || frame.type === 'updated') {
    return { ...record, live: new Set(record.live).add(frame.message.id) }
  }
  if (frame.type === 'removed') {
    return { ...record, removed: new Set(record.removed).add(frame.messageId) }
  }
  if (frame.type === 'reactions') {
    return { ...record, reactions: new Map(record.reactions).set(frame.messageId, frame.reactions) }
  }
  return record
}

/**
 * What a channel screen shows once a history read answers, from what it holds and the record of
 * the socket's frames. The screen holds only the history and the frames, so the latest read
 * replaces an earlier read's copies, and the frames win over the read: a message the socket
 * removed stays off screen, a message gets the reactions the socket sent for it, and a message
 * the socket sent or updated keeps the copy the screen holds.
 */
export function mergeHistory(
  current: readonly Message[],
  history: readonly Message[],
  record: FrameRecord,
): Message[] {
  const kept = history
    .filter((message) => !record.removed.has(message.id))
    .map((message) => {
      const reactions = record.reactions.get(message.id)
      return reactions === undefined ? message : { ...message, reactions }
    })
  return mergeMessages(
    kept,
    current.filter((message) => record.live.has(message.id)),
  )
}

/** How long a channel screen waits for its socket to open before it reads the history anyway. */
export const historyFallbackMs = 5000

/**
 * How far apart two messages from one author may be, on one day, and still be one group: five
 * minutes, measured to the neighbouring message, as the chat library groups its bubbles.
 */
export const groupWindowMs = 5 * 60 * 1000

/** Runs `run` after `ms`, and returns what cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void

/** When a channel screen reads its history, told what its socket does. */
export interface HistoryReads {
  /** The socket opened: read the history, again when the fallback already read it. */
  opened(): void
  /** The socket closed without opening: read the history, unless the fallback already did. */
  neverOpened(): void
  /**
   * The member asked again: read the history again when the latest read failed, since a socket
   * that stays open reads it no more. Nothing while that read is in flight or once it answered.
   */
  retry(): void
  /**
   * The latest read taken failed, and none has been taken since. An older read that answers after
   * it does not change that, since its history is older than the one that failed.
   */
  failing(): boolean
  /**
   * The screen left, or this socket was replaced by a reconnect: read nothing more, and pass on
   * nothing from a read still in flight, which would merge against this socket's frames.
   */
  stop(): void
}

/**
 * Reads a channel screen's history once its socket opens, so no message falls between the read
 * and the frames. A socket whose upgrade is held never opens or closes, so when it has not opened
 * within `historyFallbackMs` the history is read anyway, and read again if it opens later, since
 * the fallback read is older than the socket. A read that answers after a later read was applied
 * is older than what the screen shows, so neither its history nor its failure is passed on. Each
 * socket gets its own reads: a reconnect stops the dropped socket's reads and starts new ones.
 */
export function historyReads<T>({
  read,
  apply,
  failed,
  schedule,
}: {
  read(): Promise<T>
  apply(history: T): void
  failed(error: unknown): void
  schedule: Schedule
}): HistoryReads {
  let taken = 0
  let applied = 0
  let opened = false
  let stopped = false
  // The latest read taken failed, and none has been taken since.
  let latestFailed = false
  const take = () => {
    taken += 1
    latestFailed = false
    const order = taken
    read().then(
      (history) => {
        if (stopped || order < applied) return
        applied = order
        apply(history)
      },
      (error: unknown) => {
        if (stopped || order < applied) return
        if (order === taken) latestFailed = true
        failed(error)
      },
    )
  }
  const cancel = schedule(() => {
    if (!opened && taken === 0) take()
  }, historyFallbackMs)
  return {
    opened() {
      if (opened) return
      opened = true
      cancel()
      take()
    },
    neverOpened() {
      cancel()
      if (taken === 0) take()
    },
    retry() {
      if (!stopped && latestFailed) take()
    },
    failing() {
      return latestFailed
    },
    stop() {
      stopped = true
      cancel()
    },
  }
}

/** A channel screen's read of the signed-in member, told when its socket opens. */
export interface MemberReads {
  /** A socket opened, or the member asked again: read the member again when no read has landed. */
  retry(): void
  /** No read has landed, the latest read taken failed, and none has been taken since. */
  failing(): boolean
}

/**
 * Reads the signed-in member for a channel screen at once. A failed read shows the same notice a
 * failed history read does, which a socket opening takes off the screen, so each open, and each
 * time the member asks again, reads the member again until a read lands: without the member the
 * screen shows no messages.
 */
export function memberReads<T>({
  read,
  apply,
  failed,
}: {
  read(): Promise<T>
  apply(member: T): void
  failed(error: unknown): void
}): MemberReads {
  let loaded = false
  // The latest read taken failed, and none has been taken since.
  let latestFailed = false
  const take = () => {
    latestFailed = false
    read().then(
      (member) => {
        loaded = true
        apply(member)
      },
      (error: unknown) => {
        latestFailed = true
        failed(error)
      },
    )
  }
  take()
  return {
    retry() {
      if (!loaded) take()
    },
    failing() {
      return !loaded && latestFailed
    },
  }
}

/**
 * How long a channel screen waits to read its people list again after `failures` reads in a row
 * have failed: two seconds after the first, doubling up to a minute.
 */
export function peopleRetryMs(failures: number): number {
  return Math.min(2000 * 2 ** (failures - 1), 60_000)
}

/** When a channel screen reads its people list. */
export interface PeopleReads {
  /** Read the list again, as for an author it did not name. */
  again(): void
  /** The screen left: read nothing more, and apply nothing a read still in flight answers. */
  stop(): void
}

/**
 * Reads a channel screen's people list when the screen opens, and again when asked. A read that
 * fails is taken again after `peopleRetryMs`, until one answers, so one failed read does not leave
 * every author unnamed for the rest of the opening. `failed` hears each failure.
 */
export function peopleReads<T>({
  read,
  apply,
  failed,
  schedule,
}: {
  read(): Promise<T>
  apply(list: T): void
  failed(): void
  schedule: Schedule
}): PeopleReads {
  let stopped = false
  let failures = 0
  let cancelRetry: (() => void) | null = null
  const clearRetry = () => {
    cancelRetry?.()
    cancelRetry = null
  }
  const take = () => {
    clearRetry()
    read().then(
      (list) => {
        if (stopped) return
        failures = 0
        clearRetry()
        apply(list)
      },
      () => {
        if (stopped) return
        failed()
        if (cancelRetry !== null) return
        failures += 1
        cancelRetry = schedule(() => {
          cancelRetry = null
          take()
        }, peopleRetryMs(failures))
      },
    )
  }
  take()
  return {
    again: take,
    stop() {
      stopped = true
      clearRetry()
    },
  }
}

/** Takes a message out of the ones a channel screen holds, once the server says it was deleted. */
export function removeMessage(current: readonly Message[], messageId: string): Message[] {
  return current.filter((message) => message.id !== messageId)
}

/**
 * Replaces one message's reactions with the set the server sent, its whole set after a change. A
 * message the screen does not hold is left alone.
 */
export function applyReactions(
  current: readonly Message[],
  messageId: string,
  reactions: Reaction[],
): Message[] {
  return current.map((message) => (message.id === messageId ? { ...message, reactions } : message))
}

/**
 * How one message's bubble is drawn: on the left for other people and on the right for the
 * member's own, with the author's name above the first bubble of a group, the avatar beside the
 * last, and the time under the last.
 */
export interface BubbleLayout {
  side: 'left' | 'right'
  showName: boolean
  showAvatar: boolean
  showTime: boolean
}

/**
 * A message as the channel screen hands it to the chat library. It carries its bubble's layout,
 * which `toChatMessages` decides; the screen's render props only draw it.
 */
export interface ChannelChatMessage extends IMessage {
  /** Its side, and whether its name, avatar and time show. */
  layout: BubbleLayout
  /** The server sent it marked as deleted, which it does for admins only. */
  deleted: boolean
  /** The server marked it urgent. */
  urgent: boolean
  /** The server marked it a team announcement. */
  teamAnnouncement: boolean
  /** The server marked it pinned. */
  pinned: boolean
  /** Someone else wrote it and @mentioned the reader. The reader's own message never counts. */
  mentionsMe: boolean
  /**
   * The author's photo URL, or null for initials. Its own field, not the library's `user.avatar`,
   * so the library never draws or loads it: the screen's `renderAvatar` does.
   */
  avatar: string | null
}

/**
 * The marks the channel screen shows under a message, in this order: Mentions you, Pinned, Urgent,
 * Team announcement, and Deleted, which the server sends to admins only.
 */
export function messageMarks(message: ChannelChatMessage): string[] {
  return [
    message.mentionsMe ? 'Mentions you' : null,
    message.pinned ? 'Pinned' : null,
    message.urgent ? 'Urgent' : null,
    message.teamAnnouncement ? 'Team announcement' : null,
    message.deleted ? 'Deleted' : null,
  ].filter((mark) => mark !== null)
}

/**
 * The names a channel screen shows its authors by, by person ID: the channel's people list, and
 * the names its history reads gave for the authors the list leaves out, such as the members of a
 * private channel below its minimum, whom the list does not hold though they are still members.
 * Null until the people list loads, so an author no name is known for yet shows no name rather
 * than "Former member".
 */
export function channelNames(
  people: ReadonlyMap<string, string> | null,
  historyAuthors: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> | null {
  if (people === null) return null
  return new Map([...historyAuthors, ...people])
}

/**
 * The name a message shows for its author: the signed-in member's own from `/me`, anyone else's
 * from `names` (`channelNames`). Before the people list loads no name is shown, so no person ID
 * shows as one. An author neither names has left the church: the history names each of its authors
 * still in the church, and the people list each person who may post in the channel now.
 */
function authorName(
  authorId: string,
  me: Member,
  names: ReadonlyMap<string, string> | null,
): string {
  if (authorId === me.personId) return me.name
  if (names === null) return ''
  return names.get(authorId) ?? 'Former member'
}

/**
 * Whether two neighbouring messages are one group: one author, one local calendar day, and at
 * most `groupWindowMs` apart. The chat library's own grouping uses the same rule for its spacing.
 */
function grouped(a: Message | undefined, b: Message | undefined): boolean {
  if (a === undefined || b === undefined || a.authorId !== b.authorId) return false
  const [first, second] = [new Date(a.sentAt), new Date(b.sentAt)]
  const sameDay =
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  return sameDay && Math.abs(second.getTime() - first.getTime()) <= groupWindowMs
}

/**
 * The chat library's messages for a channel, newest first (the library's list is inverted). This
 * module decides each bubble's layout (`BubbleLayout`) over the messages in send order: the
 * member's own on the right with no name or avatar, everyone else's on the left, the name on the
 * first of a group, the avatar and the time on the last. Each
 * author shows by name, from `/me` or from `names` (`channelNames`), which is null until the
 * people list loads (`authorName`). A message someone else wrote that @mentions the reader is
 * marked `mentionsMe`, so the screen can make it stand out. A message's image shows once it is in `localImages`, by image
 * ID: the library opens it with no headers, so it gets the downloaded file, never the server's URL.
 * Until then the bubble shows the caption, or "Image" when it has none. Each message carries its
 * author's photo: the member's own from `/me`, anyone else's from `avatars`, by person ID, which
 * the history reads fill. An author none of them named, or one sent with no photo, as a minor is,
 * carries null and shows initials.
 */
export function toChatMessages(
  messages: readonly Message[],
  me: Member,
  names: ReadonlyMap<string, string> | null = null,
  localImages: ReadonlyMap<string, string> = new Map(),
  avatars: ReadonlyMap<string, string | null> = new Map(),
): ChannelChatMessage[] {
  return messages
    .map((message, index) => {
      const own = message.authorId === me.personId
      const afterPrevious = grouped(messages[index - 1], message)
      const beforeNext = grouped(message, messages[index + 1])
      const chatMessage: ChannelChatMessage = {
        _id: message.id,
        layout: {
          side: own ? 'right' : 'left',
          showName: !own && !afterPrevious,
          showAvatar: !own && !beforeNext,
          showTime: !beforeNext,
        },
        text: message.body,
        createdAt: new Date(message.sentAt),
        user: { _id: message.authorId, name: authorName(message.authorId, me, names) },
        deleted: message.deleted !== undefined,
        urgent: message.urgent === true,
        teamAnnouncement: message.teamAnnouncement === true,
        pinned: message.pinned !== undefined,
        mentionsMe: message.authorId !== me.personId && message.mentions.includes(me.personId),
        avatar: own ? (me.avatar ?? null) : (avatars.get(message.authorId) ?? null),
        reactions: message.reactions.map(({ emoji, personIds }) => ({
          emoji,
          userIds: personIds,
        })),
      }
      const image = message.image === null ? undefined : localImages.get(message.image.id)
      if (image !== undefined) chatMessage.image = image
      // Until its image is on the device, a message with no caption reads "Image", not blank.
      else if (message.image !== null && message.body === '') chatMessage.text = 'Image'
      return chatMessage
    })
    .reverse()
}

/**
 * The authors a channel screen reads its people list again for: each one a loaded list does not
 * name, once, so a person the roster sync added after the list was read gets their name rather
 * than "Former member". The signed-in member is named by `/me`, an author already asked for in this
 * opening is not asked for again, and nobody is asked for before the first list loads.
 */
export function unnamedAuthors(
  messages: readonly Message[],
  names: ReadonlyMap<string, string> | null,
  me: Member,
  asked: ReadonlySet<string>,
): string[] {
  if (names === null) return []
  const unnamed = new Set<string>()
  for (const { authorId } of messages) {
    if (authorId === me.personId || names.has(authorId) || asked.has(authorId)) continue
    unnamed.add(authorId)
  }
  return [...unnamed]
}

/**
 * Whether the server's current reactions on a message list this person under this emoji, so a tap
 * on it takes theirs off rather than adding it.
 */
export function hasReacted(message: Message, personId: string, emoji: string): boolean {
  return message.reactions.some(
    (reaction) => reaction.emoji === emoji && reaction.personIds.includes(personId),
  )
}

/** An action the long-press menu offers on a message. */
export type MessageMenuAction = 'delete' | 'report' | 'remove' | 'pin' | 'unpin'

/**
 * The actions the long-press menu offers a person on a message, from what the server said: Delete
 * on their own, Report on anyone else's, and, when `/me` says they moderate, Remove on anyone
 * else's and Pin or Unpin on any. A message marked as deleted offers nothing. The server decides
 * each action again when it arrives.
 */
export function messageMenuActions(message: ChannelChatMessage, me: Member): MessageMenuAction[] {
  if (message.deleted) return []
  const own = message.user._id === me.personId
  const actions: MessageMenuAction[] = own ? ['delete'] : ['report']
  if (me.canModerate) {
    if (!own) actions.push('remove')
    actions.push(message.pinned ? 'unpin' : 'pin')
  }
  return actions
}
