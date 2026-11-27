import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LastMessage } from '@phon/api-types'
import { channelPreview } from '../src/channel-preview.ts'

/** Noon on Wednesday 25 November 2026, on the phone's own clock. */
const NOW = new Date(2026, 10, 25, 12, 0)

function last(extra: Partial<LastMessage> = {}): LastMessage {
  return {
    authorFirstName: 'Ana',
    body: 'See you Sunday',
    image: null,
    sentAt: new Date(2026, 10, 25, 9, 5).toISOString(),
    ...extra,
  }
}

function text(lastMessage: LastMessage | null | undefined): string | undefined {
  return channelPreview(lastMessage, NOW, true)?.text
}

describe("a channel row's preview text", () => {
  it("reads a text message as the author's first name, then the text", () => {
    assert.equal(text(last()), 'Ana: See you Sunday')
  })

  it('reads a photo with no caption as Photo', () => {
    assert.equal(text(last({ image: 'photo', body: '' })), 'Ana: Photo')
  })

  it('reads a photo with a caption as Photo, then the caption', () => {
    assert.equal(text(last({ image: 'photo', body: 'Setup crew' })), 'Ana: Photo, Setup crew')
  })

  it('reads a GIF with no caption as GIF', () => {
    assert.equal(text(last({ image: 'gif', body: '' })), 'Ana: GIF')
  })

  it('reads a GIF with a caption as GIF, then the caption', () => {
    assert.equal(text(last({ image: 'gif', body: 'Yes!' })), 'Ana: GIF, Yes!')
  })

  it('reads with no name when the author is no longer in the church', () => {
    assert.equal(text(last({ authorFirstName: null })), 'See you Sunday')
  })

  it('brings a message of several lines onto one line', () => {
    assert.equal(
      text(last({ body: 'Rehearsal moved\n\n  to   7pm\ttonight ' })),
      'Ana: Rehearsal moved to 7pm tonight',
    )
  })

  it('cuts a long line to its first 100 characters and ends it with an ellipsis', () => {
    const body = 'word '.repeat(40).trim()
    const preview = text(last({ body }))
    assert.equal(preview, `${`Ana: ${body}`.slice(0, 100)}…`)
    assert.equal(preview?.length, 101)
  })

  it('keeps a line of exactly 100 characters whole', () => {
    const body = 'a'.repeat(95)
    assert.equal(text(last({ body })), `Ana: ${body}`)
  })

  it('shows no preview for a channel with no messages yet', () => {
    assert.equal(channelPreview(null, NOW, true), null)
  })

  it('shows no preview for a channel the server sent no last message for', () => {
    assert.equal(channelPreview(undefined, NOW, true), null)
  })
})

function time(sentAt: Date, uses24hourClock: boolean | null = true): string | undefined {
  return channelPreview(last({ sentAt: sentAt.toISOString() }), NOW, uses24hourClock)?.time
}

describe("a channel row's preview time", () => {
  it('shows the clock time for a message sent today, on a 24 hour clock', () => {
    assert.equal(time(new Date(2026, 10, 25, 9, 5), true), '09:05')
  })

  it('shows the clock time for a message sent today, on a 12 hour clock', () => {
    assert.equal(time(new Date(2026, 10, 25, 9, 5), false), '9:05 AM')
    assert.equal(time(new Date(2026, 10, 25, 0, 30), null), '12:30 AM')
  })

  it('shows Yesterday for a message sent the day before, even late at night', () => {
    assert.equal(time(new Date(2026, 10, 24, 23, 59)), 'Yesterday')
    assert.equal(time(new Date(2026, 10, 24, 0, 1)), 'Yesterday')
  })

  it('shows the weekday for a message sent two to six days before', () => {
    assert.equal(time(new Date(2026, 10, 23, 8, 0)), 'Monday')
    assert.equal(time(new Date(2026, 10, 22, 8, 0)), 'Sunday')
    assert.equal(time(new Date(2026, 10, 19, 8, 0)), 'Thursday')
  })

  it('shows the month and day for a message sent a week or more before', () => {
    assert.equal(time(new Date(2026, 10, 18, 8, 0)), 'Nov 18')
    assert.equal(time(new Date(2026, 0, 3, 8, 0)), 'Jan 3')
  })

  it('adds the year for a message sent in another year', () => {
    assert.equal(time(new Date(2025, 11, 30, 8, 0)), 'Dec 30, 2025')
  })

  it('shows the clock time for a message dated after now by a skewed clock', () => {
    assert.equal(time(new Date(2026, 10, 26, 8, 0)), '08:00')
  })
})
