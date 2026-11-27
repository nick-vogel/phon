import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Member, Message, ServerFrame } from '@phon/api-types'
import {
  channelNames,
  emptyFrameRecord,
  type FrameRecord,
  historyFallbackMs,
  historyReads,
  memberReads,
  mergeHistory,
  messageMarks,
  messageMenuActions,
  peopleReads,
  peopleRetryMs,
  recordFrame,
  toChatMessages,
  unnamedAuthors,
} from '../src/channel-messages.ts'

/** The signed-in person, as `/me` answers for each role. */
function signedIn(personId: string, canModerate: boolean): Member {
  return {
    personId,
    name: personId,
    role: canModerate ? 'chat-admin' : 'member',
    canCreate: [],
    canAssignRoles: false,
    canReadOversight: false,
    canMarkUrgent: canModerate,
    canManageBirthdates: false,
    canModerate,
  }
}

/** A stored message by an author, as the server sends it. */
function message(id: string, authorId: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    churchId: 'church',
    channelId: 'general',
    authorId,
    body: `Message ${id}`,
    sentAt: '2026-11-13T10:00:00.000Z',
    mentions: [],
    image: null,
    reactions: [],
    ...extra,
  }
}

/** The long-press menu a person gets on one message. */
function menuFor(me: Member, shown: Message) {
  const [chatMessage] = toChatMessages([shown], me)
  assert.ok(chatMessage !== undefined)
  return messageMenuActions(chatMessage, me)
}

const pin = { at: '2026-11-13T10:05:00.000Z', by: 'fay' }
const deleted = { at: '2026-11-13T10:05:00.000Z', by: 'fay' }

describe('the long-press menu on a message', () => {
  it("offers a member Report on someone else's message, and nothing more", () => {
    assert.deepEqual(menuFor(signedIn('cy', false), message('m1', 'ben')), ['report'])
  })

  it('offers a member Delete on their own message, and no Report', () => {
    assert.deepEqual(menuFor(signedIn('ben', false), message('m1', 'ben')), ['delete'])
  })

  it("offers a moderator Report, Remove and Pin on someone else's message", () => {
    assert.deepEqual(menuFor(signedIn('fay', true), message('m1', 'ben')), [
      'report',
      'remove',
      'pin',
    ])
  })

  it('offers a moderator Unpin in place of Pin on a pinned message', () => {
    assert.deepEqual(menuFor(signedIn('fay', true), message('m1', 'ben', { pinned: pin })), [
      'report',
      'remove',
      'unpin',
    ])
  })

  it('offers a moderator Delete and Pin on their own message', () => {
    assert.deepEqual(menuFor(signedIn('fay', true), message('m1', 'fay')), ['delete', 'pin'])
  })

  it('offers nothing on a message an admin sees marked as deleted', () => {
    assert.deepEqual(menuFor(signedIn('ana', true), message('m1', 'ben', { deleted })), [])
  })
})

describe('the pinned mark', () => {
  it('marks a pinned message, and only a pinned one', () => {
    const me = signedIn('cy', false)
    const [unpinned, pinned] = toChatMessages(
      [message('m1', 'ben', { pinned: pin }), message('m2', 'ben')],
      me,
    )
    assert.equal(pinned?.pinned, true)
    assert.equal(unpinned?.pinned, false)
  })
})

describe('a message that @mentions the reader', () => {
  const me = signedIn('cy', false)

  /** Whether the reader's channel screen marks this message as mentioning them. */
  function mentionsMe(shown: Message): boolean | undefined {
    return toChatMessages([shown], me)[0]?.mentionsMe
  }

  it("marks someone else's message that mentions the reader", () => {
    assert.equal(mentionsMe(message('m1', 'ben', { mentions: ['dee', 'cy'] })), true)
  })

  it('does not mark a message that mentions only someone else', () => {
    assert.equal(mentionsMe(message('m1', 'ben', { mentions: ['dee'] })), false)
  })

  it("does not mark the reader's own message, even when it lists them", () => {
    assert.equal(mentionsMe(message('m1', 'cy', { mentions: ['cy'] })), false)
  })

  it('does not mark a message that mentions nobody', () => {
    assert.equal(mentionsMe(message('m1', 'ben', { mentions: [] })), false)
  })
})

describe('the marks line on a message', () => {
  const me = signedIn('cy', false)

  /** The marks the reader's channel screen shows under this message. */
  function marksOn(shown: Message): string[] {
    const [chatMessage] = toChatMessages([shown], me)
    assert.ok(chatMessage !== undefined)
    return messageMarks(chatMessage)
  }

  it('shows no marks on a plain message', () => {
    assert.deepEqual(marksOn(message('m1', 'ben')), [])
  })

  it('shows Pinned on a pinned message', () => {
    assert.deepEqual(marksOn(message('m1', 'ben', { pinned: pin })), ['Pinned'])
  })

  it('shows Mentions you on a message that mentions the reader', () => {
    assert.deepEqual(marksOn(message('m1', 'ben', { mentions: ['cy'] })), ['Mentions you'])
  })

  it('lists Mentions you first, then Pinned, Urgent, Team announcement and Deleted', () => {
    const marked = message('m1', 'ben', {
      mentions: ['cy'],
      pinned: pin,
      urgent: true,
      teamAnnouncement: true,
      deleted,
    })
    assert.deepEqual(marksOn(marked), [
      'Mentions you',
      'Pinned',
      'Urgent',
      'Team announcement',
      'Deleted',
    ])
  })
})

describe("the author's name on a message", () => {
  const me = { ...signedIn('cy', false), name: 'Cy Doe' }
  const names = new Map([
    ['ben', 'Ben Ito'],
    ['cy', 'Cy Doe'],
  ])

  it("shows another member's message under the name the channel's people list gives", () => {
    const [shown] = toChatMessages([message('m1', 'ben')], me, names)
    assert.equal(shown?.user.name, 'Ben Ito')
  })

  it("shows the signed-in member's own message under the name /me gives", () => {
    const [shown] = toChatMessages([message('m1', 'cy')], me, new Map([['cy', 'Cy']]))
    assert.equal(shown?.user.name, 'Cy Doe')
  })

  it('shows a message by an author the loaded list does not name as Former member', () => {
    const [shown] = toChatMessages([message('m1', 'dee')], me, names)
    assert.equal(shown?.user.name, 'Former member')
  })

  it('shows no person ID as a name while the people list has not loaded', () => {
    const shown = toChatMessages([message('m1', 'ben'), message('m2', 'dee')], me, null)
    assert.deepEqual(
      shown.map((chatMessage) => chatMessage.user.name),
      ['', ''],
    )
  })
})

describe("the author's photo on a message", () => {
  const benPhoto = 'https://avatars.planningcenteronline.com/uploads/person/1/ben.jpg'
  const cyPhoto = 'https://avatars.planningcenteronline.com/uploads/person/2/cy.jpg'
  const me = { ...signedIn('cy', false), avatar: cyPhoto }
  const avatars = new Map([
    ['ben', benPhoto],
    ['eli', null],
  ])

  it("carries the photo the history read gave for another member's message", () => {
    const [shown] = toChatMessages([message('m1', 'ben')], me, null, new Map(), avatars)
    assert.equal(shown?.avatar, benPhoto)
  })

  it('carries no photo for an author the history read sent none for, as for a minor', () => {
    const [shown] = toChatMessages([message('m1', 'eli')], me, null, new Map(), avatars)
    assert.equal(shown?.avatar, null)
  })

  it('carries no photo for an author no history read has named, such as a former member', () => {
    const [shown] = toChatMessages([message('m1', 'dee')], me, null, new Map(), avatars)
    assert.equal(shown?.avatar, null)
  })

  it("carries the signed-in member's own photo from /me on their own message", () => {
    const [shown] = toChatMessages([message('m1', 'cy')], me, null, new Map(), avatars)
    assert.equal(shown?.avatar, cyPhoto)
  })
})

describe('the layout of the bubbles', () => {
  const me = { ...signedIn('cy', false), name: 'Cy Doe' }
  const names = new Map([
    ['ben', 'Ben Ito'],
    ['ana', 'Ana Ortiz'],
  ])

  /** A message sent at a local time on 24 November 2026, or on the day given. */
  function at(id: string, authorId: string, hour: number, minute: number, day = 24): Message {
    return message(id, authorId, { sentAt: new Date(2026, 10, day, hour, minute).toISOString() })
  }

  /** Each message's layout, by ID. */
  function layouts(shown: readonly Message[]) {
    return Object.fromEntries(
      toChatMessages(shown, me, names).map((chatMessage) => [chatMessage._id, chatMessage.layout]),
    )
  }

  const lone = { side: 'left', showName: true, showAvatar: true, showTime: true }

  it('groups two messages from one author four minutes apart', () => {
    assert.deepEqual(layouts([at('m1', 'ben', 10, 0), at('m2', 'ben', 10, 4)]), {
      m1: { side: 'left', showName: true, showAvatar: false, showTime: false },
      m2: { side: 'left', showName: false, showAvatar: true, showTime: true },
    })
  })

  it('still groups two messages exactly five minutes apart', () => {
    assert.deepEqual(layouts([at('m1', 'ben', 10, 0), at('m2', 'ben', 10, 5)]), {
      m1: { side: 'left', showName: true, showAvatar: false, showTime: false },
      m2: { side: 'left', showName: false, showAvatar: true, showTime: true },
    })
  })

  it('starts a new group six minutes later, each with its name, avatar and time', () => {
    assert.deepEqual(layouts([at('m1', 'ben', 10, 0), at('m2', 'ben', 10, 6)]), {
      m1: lone,
      m2: lone,
    })
  })

  it('measures the window to the neighbouring message, so three messages over eight minutes stay one group', () => {
    assert.deepEqual(
      layouts([at('m1', 'ben', 10, 0), at('m2', 'ben', 10, 4), at('m3', 'ben', 10, 8)]),
      {
        m1: { side: 'left', showName: true, showAvatar: false, showTime: false },
        m2: { side: 'left', showName: false, showAvatar: false, showTime: false },
        m3: { side: 'left', showName: false, showAvatar: true, showTime: true },
      },
    )
  })

  it('ends a group and starts a new one when another author writes inside the window', () => {
    assert.deepEqual(
      layouts([at('m1', 'ben', 10, 0), at('m2', 'ben', 10, 1), at('m3', 'ana', 10, 2)]),
      {
        m1: { side: 'left', showName: true, showAvatar: false, showTime: false },
        m2: { side: 'left', showName: false, showAvatar: true, showTime: true },
        m3: lone,
      },
    )
  })

  it('starts a new group on a new local day, even three minutes later', () => {
    assert.deepEqual(layouts([at('m1', 'ben', 23, 58), at('m2', 'ben', 0, 1, 25)]), {
      m1: lone,
      m2: lone,
    })
  })

  it("puts the member's own messages on the right with no name or avatar, and the time on the last", () => {
    assert.deepEqual(layouts([at('m1', 'cy', 10, 0), at('m2', 'cy', 10, 2)]), {
      m1: { side: 'right', showName: false, showAvatar: false, showTime: false },
      m2: { side: 'right', showName: false, showAvatar: false, showTime: true },
    })
  })

  it("puts another person's lone message on the left with its name, avatar and time", () => {
    assert.deepEqual(layouts([at('m1', 'ana', 10, 0)]), { m1: lone })
  })

  it('shows a former member on the left as Former member, with a name, avatar and time', () => {
    const [shown] = toChatMessages([at('m1', 'dee', 10, 0)], me, names)
    assert.equal(shown?.user.name, 'Former member')
    assert.deepEqual(shown?.layout, lone)
  })
})

describe("the names from the channel's people list and its history", () => {
  const me = signedIn('cy', false)
  const people = new Map([['ana', 'Ana Ortiz']])
  const history = new Map([['ben', 'Ben Ito']])

  it('names an author the history names whom the people list leaves out, not as Former member', () => {
    const [shown] = toChatMessages([message('m1', 'ben')], me, channelNames(people, history))
    assert.equal(shown?.user.name, 'Ben Ito')
  })

  it('names an author the people list names, and calls one neither names a Former member', () => {
    const shown = toChatMessages(
      [message('m1', 'ana'), message('m2', 'dee')],
      me,
      channelNames(people, history),
    )
    assert.deepEqual(
      shown.map((chatMessage) => chatMessage.user.name),
      ['Former member', 'Ana Ortiz'],
    )
  })

  it('gives no names before the people list loads', () => {
    assert.equal(channelNames(null, history), null)
  })
})

describe('the authors the channel screen asks the people list again for', () => {
  const me = signedIn('cy', false)
  const names = new Map([
    ['ben', 'Ben Ito'],
    ['cy', 'Cy Doe'],
  ])

  it('asks once for an author the loaded list does not name, however many messages they sent', () => {
    const messages = [message('m1', 'dee'), message('m2', 'dee'), message('m3', 'ben')]
    assert.deepEqual(unnamedAuthors(messages, names, me, new Set()), ['dee'])
  })

  it('does not ask for the signed-in member, whom the list need not name', () => {
    const messages = [message('m1', 'cy'), message('m2', 'ben')]
    assert.deepEqual(unnamedAuthors(messages, new Map([['ben', 'Ben Ito']]), me, new Set()), [])
  })

  it('does not ask again for an author already asked for in this opening', () => {
    const messages = [message('m1', 'dee'), message('m2', 'eli')]
    assert.deepEqual(unnamedAuthors(messages, names, me, new Set(['dee'])), ['eli'])
  })

  it('asks for nobody before the people list loads', () => {
    assert.deepEqual(unnamedAuthors([message('m1', 'dee')], null, me, new Set()), [])
  })
})

/** What the socket delivered before the history answered, folded frame by frame. */
function delivered(...frames: ServerFrame[]): FrameRecord {
  return frames.reduce(recordFrame, emptyFrameRecord())
}

describe('the history arriving after live frames', () => {
  it('leaves off screen a message whose removed frame beat the history', () => {
    const shown = mergeHistory(
      [],
      [message('m1', 'ben')],
      delivered({ type: 'removed', messageId: 'm1' }),
    )
    assert.deepEqual(shown, [])
  })

  it('keeps the live copy of a message whose updated frame beat the history', () => {
    const live = message('m1', 'ben', { pinned: pin })
    const shown = mergeHistory(
      [live],
      [message('m1', 'ben')],
      delivered({ type: 'updated', message: live }),
    )
    assert.deepEqual(shown, [live])
  })

  it('gives a message the reactions whose frame beat the history that brings the message in', () => {
    const reactions = [{ emoji: '🙏', personIds: ['cy'] }]
    const shown = mergeHistory(
      [],
      [message('m1', 'ben')],
      delivered({ type: 'reactions', messageId: 'm1', reactions }),
    )
    assert.deepEqual(shown, [message('m1', 'ben', { reactions })])
  })

  it('shows a message both live and in the history once, oldest first', () => {
    const first = message('m1', 'ben', { sentAt: '2026-11-13T10:00:00.000Z' })
    const second = message('m2', 'ben', { sentAt: '2026-11-13T10:01:00.000Z' })
    const liveSecond = message('m2', 'ben', { sentAt: '2026-11-13T10:01:00.000Z', pinned: pin })
    const third = message('m3', 'cy', { sentAt: '2026-11-13T10:02:00.000Z' })
    const shown = mergeHistory(
      [liveSecond, third],
      [first, second],
      delivered({ type: 'updated', message: liveSecond }, { type: 'message', message: third }),
    )
    assert.deepEqual(shown, [first, liveSecond, third])
  })

  it('shows the history as the server sent it when no frame came first', () => {
    const first = message('m1', 'ben', { sentAt: '2026-11-13T10:00:00.000Z' })
    const second = message('m2', 'cy', { sentAt: '2026-11-13T10:01:00.000Z' })
    assert.deepEqual(mergeHistory([], [first, second], emptyFrameRecord()), [first, second])
  })
})

describe('the history read again once the socket opens', () => {
  it("replaces the copy an earlier read brought in with the later read's copy", () => {
    const stale = message('m1', 'ben')
    const fresh = message('m1', 'ben', { pinned: pin })
    assert.deepEqual(mergeHistory([stale], [fresh], emptyFrameRecord()), [fresh])
  })

  it('takes off screen a message an earlier read brought in that the later read no longer has', () => {
    const kept = message('m2', 'ben', { sentAt: '2026-11-13T10:01:00.000Z' })
    assert.deepEqual(mergeHistory([message('m1', 'ben'), kept], [kept], emptyFrameRecord()), [kept])
  })

  it('keeps a message the socket delivered that the later read does not have yet', () => {
    const live = message('m2', 'cy', { sentAt: '2026-11-13T10:01:00.000Z' })
    const shown = mergeHistory(
      [message('m1', 'ben'), live],
      [message('m1', 'ben')],
      delivered({ type: 'message', message: live }),
    )
    assert.deepEqual(shown, [message('m1', 'ben'), live])
  })
})

describe('the history read once a dropped socket connects again', () => {
  // The new socket starts a fresh record: what the dropped socket delivered is in the screen's
  // messages, and the new read is newer than all of it.
  const first = message('m1', 'ben', { sentAt: '2026-11-13T10:00:00.000Z' })
  const second = message('m2', 'cy', { sentAt: '2026-11-13T10:01:00.000Z' })
  const third = message('m3', 'cy', { sentAt: '2026-11-13T10:02:00.000Z' })

  it('brings in a message sent while the socket was down', () => {
    assert.deepEqual(mergeHistory([first], [first, second], emptyFrameRecord()), [first, second])
  })

  it('takes off screen a message deleted or removed while the socket was down', () => {
    assert.deepEqual(mergeHistory([first, second], [second], emptyFrameRecord()), [second])
  })

  it('shows a message as marked deleted when an admin sees it was deleted while down', () => {
    const markedDeleted = message('m1', 'ben', { sentAt: first.sentAt, deleted })
    assert.deepEqual(mergeHistory([first], [markedDeleted], emptyFrameRecord()), [markedDeleted])
  })

  it('takes the reactions changed while the socket was down', () => {
    const reacted = message('m1', 'ben', {
      sentAt: first.sentAt,
      reactions: [{ emoji: '🙏', personIds: ['cy'] }],
    })
    assert.deepEqual(mergeHistory([first], [reacted], emptyFrameRecord()), [reacted])
  })

  it("replaces a copy the dropped socket delivered with the new read's copy", () => {
    const pinnedBefore = message('m2', 'cy', { sentAt: second.sentAt, pinned: pin })
    assert.deepEqual(mergeHistory([first, pinnedBefore], [first, second], emptyFrameRecord()), [
      first,
      second,
    ])
  })

  it('keeps a message the new socket delivered before its history answered', () => {
    const shown = mergeHistory(
      [first, third],
      [first, second],
      delivered({ type: 'message', message: third }),
    )
    assert.deepEqual(shown, [first, second, third])
  })
})

/** A history read the test answers by hand, and a fallback timer the test fires by hand. */
function harness() {
  const reads: { answer(history: string): void; fail(error: unknown): void }[] = []
  const applied: string[] = []
  const failures: unknown[] = []
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const controller = historyReads<string>({
    read: () =>
      new Promise<string>((resolve, reject) => {
        reads.push({ answer: resolve, fail: reject })
      }),
    apply: (history) => applied.push(history),
    failed: (error) => failures.push(error),
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  /** Fires every fallback timer that is still set, as the clock passing its time would. */
  const elapse = () => {
    for (const timer of timers) if (!timer.cancelled) timer.run()
  }
  return { controller, reads, applied, failures, timers, elapse }
}

/** Lets each answered read's `then` run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("the channel screen's history reads", () => {
  it('reads the history when the socket neither opens nor closes within the fallback time', () => {
    const { reads, timers, elapse } = harness()
    assert.deepEqual(
      timers.map(({ ms }) => ms),
      [historyFallbackMs],
    )
    assert.equal(reads.length, 0)
    elapse()
    assert.equal(reads.length, 1)
  })

  it('reads the history once when the socket opens before the fallback time', () => {
    const { controller, reads, elapse } = harness()
    controller.opened()
    elapse()
    assert.equal(reads.length, 1)
  })

  it('reads the history again when the socket opens after the fallback read', () => {
    const { controller, reads, elapse } = harness()
    elapse()
    controller.opened()
    assert.equal(reads.length, 2)
  })

  it('reads the history once when the socket never opens, with or without the fallback read', () => {
    const before = harness()
    before.controller.neverOpened()
    before.elapse()
    assert.equal(before.reads.length, 1)

    const after = harness()
    after.elapse()
    after.controller.neverOpened()
    assert.equal(after.reads.length, 1)
  })

  it('does not read once the screen has left', () => {
    const { controller, reads, elapse } = harness()
    controller.stop()
    elapse()
    assert.equal(reads.length, 0)
  })

  it('ignores the fallback read when it answers after the read taken once the socket opened', async () => {
    const { controller, reads, applied, elapse } = harness()
    elapse()
    controller.opened()
    reads[1]?.answer('after open')
    await settle()
    reads[0]?.answer('fallback')
    await settle()
    assert.deepEqual(applied, ['after open'])

    const failing = harness()
    failing.elapse()
    failing.controller.opened()
    failing.reads[1]?.answer('after open')
    await settle()
    failing.reads[0]?.fail(new Error('late'))
    await settle()
    assert.deepEqual(failing.failures, [])
  })

  it('applies both reads when each answers in the order it was taken', async () => {
    const { controller, reads, applied, elapse } = harness()
    elapse()
    reads[0]?.answer('fallback')
    await settle()
    controller.opened()
    reads[1]?.answer('after open')
    await settle()
    assert.deepEqual(applied, ['fallback', 'after open'])
  })

  it('passes on nothing from a read still in flight once stopped', async () => {
    const { controller, reads, applied, failures } = harness()
    controller.opened()
    controller.stop()
    reads[0]?.answer('from a socket that dropped')
    await settle()
    assert.deepEqual(applied, [])

    const failing = harness()
    failing.controller.opened()
    failing.controller.stop()
    failing.reads[0]?.fail(new Error('late'))
    await settle()
    assert.deepEqual(failing.failures, [])
    assert.deepEqual(failures, [])
  })

  it('reports a read that fails', async () => {
    const { controller, reads, failures } = harness()
    controller.opened()
    const error = new Error('down')
    reads[0]?.fail(error)
    await settle()
    assert.deepEqual(failures, [error])
  })

  // The socket stays open, so no open reads it again: the member asking again is the only way.
  it('reads the history again when asked after the read failed, and again after that one fails', async () => {
    const { controller, reads, applied, failures } = harness()
    controller.opened()
    const first = new Error('down')
    reads[0]?.fail(first)
    await settle()
    controller.retry()
    assert.equal(reads.length, 2)
    const second = new Error('still down')
    reads[1]?.fail(second)
    await settle()
    assert.deepEqual(failures, [first, second])
    controller.retry()
    assert.equal(reads.length, 3)
    reads[2]?.answer('caught up')
    await settle()
    assert.deepEqual(applied, ['caught up'])
  })

  it('does not read again when asked while the read is in flight, after it answered, or once stopped', async () => {
    const { controller, reads } = harness()
    controller.retry()
    assert.equal(reads.length, 0)
    controller.opened()
    controller.retry()
    assert.equal(reads.length, 1)
    reads[0]?.answer('read')
    await settle()
    controller.retry()
    assert.equal(reads.length, 1)

    const stopped = harness()
    stopped.controller.opened()
    stopped.reads[0]?.fail(new Error('down'))
    await settle()
    stopped.controller.stop()
    stopped.controller.retry()
    assert.equal(stopped.reads.length, 1)
  })

  // The screen keeps "could not be loaded" up while this is true, and takes it off once it is not.
  it('is failing from a failed read until a read is taken again, and not once that one lands', async () => {
    const { controller, reads } = harness()
    controller.opened()
    assert.equal(controller.failing(), false)
    reads[0]?.fail(new Error('down'))
    await settle()
    assert.equal(controller.failing(), true)
    controller.retry()
    assert.equal(controller.failing(), false)
    reads[1]?.answer('caught up')
    await settle()
    assert.equal(controller.failing(), false)
  })

  // The fallback read is older than the socket, so its answer does not make up for the read the
  // open took.
  it('stays failing when an older read answers after the latest read failed', async () => {
    const { controller, reads, applied, elapse } = harness()
    elapse()
    controller.opened()
    reads[1]?.fail(new Error('down'))
    await settle()
    reads[0]?.answer('fallback')
    await settle()
    assert.deepEqual(applied, ['fallback'])
    assert.equal(controller.failing(), true)
  })
})

/** A member read the test answers by hand. */
function memberHarness() {
  const reads: { answer(member: string): void; fail(error: unknown): void }[] = []
  const applied: string[] = []
  const failures: unknown[] = []
  const controller = memberReads<string>({
    read: () =>
      new Promise<string>((resolve, reject) => {
        reads.push({ answer: resolve, fail: reject })
      }),
    apply: (member) => applied.push(member),
    failed: (error) => failures.push(error),
  })
  return { controller, reads, applied, failures }
}

describe("the channel screen's member read", () => {
  it('reads the member at once, and not again when asked after it landed', async () => {
    const { controller, reads, applied } = memberHarness()
    assert.equal(reads.length, 1)
    reads[0]?.answer('me')
    await settle()
    controller.retry()
    assert.equal(reads.length, 1)
    assert.deepEqual(applied, ['me'])
  })

  // The open takes the failed read's notice off the screen, so the read has to be taken again.
  it('reads the member again when a socket opens after the read failed', async () => {
    const { controller, reads, applied, failures } = memberHarness()
    const error = new Error('offline')
    reads[0]?.fail(error)
    await settle()
    assert.deepEqual(failures, [error])
    controller.retry()
    assert.equal(reads.length, 2)
    reads[1]?.answer('me')
    await settle()
    controller.retry()
    assert.equal(reads.length, 2)
    assert.deepEqual(applied, ['me'])
  })

  // With the socket already open, the member asking again is what takes the read again.
  it('reads the member again each time it is asked while every read fails', async () => {
    const { controller, reads, applied, failures } = memberHarness()
    const first = new Error('offline')
    reads[0]?.fail(first)
    await settle()
    controller.retry()
    const second = new Error('still offline')
    reads[1]?.fail(second)
    await settle()
    assert.deepEqual(failures, [first, second])
    controller.retry()
    assert.equal(reads.length, 3)
    reads[2]?.answer('me')
    await settle()
    assert.deepEqual(applied, ['me'])
  })

  // The screen keeps "could not be loaded" up while this is true, and takes it off once it is not.
  it('is failing from a failed read until the member is read again, and not once a read lands', async () => {
    const { controller, reads } = memberHarness()
    assert.equal(controller.failing(), false)
    reads[0]?.fail(new Error('offline'))
    await settle()
    assert.equal(controller.failing(), true)
    controller.retry()
    assert.equal(controller.failing(), false)
    reads[1]?.answer('me')
    await settle()
    assert.equal(controller.failing(), false)
  })
})

/** A people list read the test answers by hand, and a retry timer the test fires by hand. */
function peopleHarness() {
  const reads: { answer(list: string): void; fail(error: unknown): void }[] = []
  const applied: string[] = []
  let failures = 0
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const controller = peopleReads<string>({
    read: () =>
      new Promise<string>((resolve, reject) => {
        reads.push({ answer: resolve, fail: reject })
      }),
    apply: (list) => applied.push(list),
    failed: () => {
      failures += 1
    },
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  /** Fires every retry timer that is still set, as the clock passing its time would. */
  const elapse = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run()
  }
  return { controller, reads, applied, failures: () => failures, timers, elapse }
}

describe("the channel screen's people list reads", () => {
  it('reads the list once when the screen opens', () => {
    const { reads, timers } = peopleHarness()
    assert.equal(reads.length, 1)
    assert.deepEqual(timers, [])
  })

  it('reads the list again after a read fails, and applies the answer that read gets', async () => {
    const { reads, applied, failures, timers, elapse } = peopleHarness()
    reads[0]?.fail(new Error('down'))
    await settle()
    assert.equal(failures(), 1)
    assert.deepEqual(
      timers.map(({ ms }) => ms),
      [peopleRetryMs(1)],
    )
    elapse()
    assert.equal(reads.length, 2)
    reads[1]?.answer('list')
    await settle()
    assert.deepEqual(applied, ['list'])
  })

  it('keeps reading while reads fail, waiting longer after each failure in a row', async () => {
    const { reads, timers, elapse } = peopleHarness()
    const waits: number[] = []
    for (let read = 0; read < 3; read += 1) {
      reads[read]?.fail(new Error('down'))
      await settle()
      waits.push(...timers.map(({ ms }) => ms))
      elapse()
    }
    assert.equal(reads.length, 4)
    assert.deepEqual(waits, [peopleRetryMs(1), peopleRetryMs(2), peopleRetryMs(3)])
    assert.ok(peopleRetryMs(1) < peopleRetryMs(2) && peopleRetryMs(2) < peopleRetryMs(3))
  })

  it('reads the list again when asked, as for an author it did not name', () => {
    const { controller, reads } = peopleHarness()
    controller.again()
    assert.equal(reads.length, 2)
  })

  it('reads and applies nothing once the screen has left, a retry already set included', async () => {
    const { controller, reads, applied, timers, elapse } = peopleHarness()
    reads[0]?.fail(new Error('down'))
    await settle()
    assert.equal(timers.length, 1)
    controller.stop()
    elapse()
    assert.equal(reads.length, 1)

    const answering = peopleHarness()
    answering.controller.stop()
    answering.reads[0]?.answer('late')
    await settle()
    assert.deepEqual(answering.applied, [])
    assert.deepEqual(applied, [])
  })
})
