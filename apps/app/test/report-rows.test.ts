import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message, Report } from '@phon/api-types'
import { reportRows } from '../src/report-rows.ts'

/** A fixed clock face, so the reported row does not depend on the machine's locale. */
const formatTime = (iso: string) => `at ${iso}`

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    churchId: 'church',
    channelId: 'c1',
    authorId: 'author',
    body: 'See you Sunday',
    sentAt: '2026-11-01T09:00:00.000Z',
    mentions: [],
    image: null,
    reactions: [],
    ...overrides,
  }
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    reportId: 'r1',
    channelId: 'c1',
    channelName: 'worship-team',
    reporterId: 'reporter',
    reporterName: 'Sam Rivera',
    reportedAt: '2026-11-02T10:30:00.000Z',
    authorId: 'author',
    authorName: 'Jo Park',
    message: message(),
    ...overrides,
  }
}

describe('the rows of a report', () => {
  it('shows the author and the message, with no mark, while the message stands', () => {
    assert.deepEqual(reportRows(report(), formatTime).message, {
      title: 'Jo Park: See you Sunday',
      subtitle: null,
    })
  })

  it('shows the author alone, and says the message has since been deleted, when it is gone', () => {
    assert.deepEqual(reportRows(report({ message: null }), formatTime).message, {
      title: 'Jo Park',
      subtitle: 'This message has since been deleted.',
    })
  })

  it('marks a message its author deleted', () => {
    const deleted = message({ deleted: { at: '2026-11-03T08:00:00.000Z', by: 'author' } })
    assert.deepEqual(reportRows(report({ message: deleted }), formatTime).message, {
      title: 'Jo Park: See you Sunday',
      subtitle: 'Deleted by its author',
    })
  })

  it('marks a message someone else removed', () => {
    const removed = message({ deleted: { at: '2026-11-03T08:00:00.000Z', by: 'moderator' } })
    assert.deepEqual(reportRows(report({ message: removed }), formatTime).message, {
      title: 'Jo Park: See you Sunday',
      subtitle: 'Removed by an admin or chat admin',
    })
  })

  it('says who reported it, and when', () => {
    assert.deepEqual(reportRows(report(), formatTime).reported, {
      title: 'Reported by Sam Rivera',
      subtitle: 'at 2026-11-02T10:30:00.000Z',
    })
  })

  it("tells the time in the phone's locale by default", () => {
    assert.equal(
      reportRows(report()).reported.subtitle,
      new Date('2026-11-02T10:30:00.000Z').toLocaleString(),
    )
  })
})
