import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { READ_MARKER_VIEWABILITY, readMarks, type ShownRow } from '../src/read-marker.ts'

/** A chat row for a message sent the given number of minutes after nine on 25 November 2026. */
function row(id: string, minute: number): ShownRow {
  return { _id: id, createdAt: new Date(Date.UTC(2026, 10, 25, 9, minute)) }
}

const [M1, M2, M3, M4] = [row('m1', 1), row('m2', 2), row('m3', 3), row('m4', 4)]

/** Answers the next sends in turn, then succeeds; a turn of `fail` rejects. */
function marker(answers: ('ok' | 'fail')[] = []) {
  const sent: string[] = []
  const settled: Promise<void>[] = []
  // The messages the app heard the server took, in turn.
  const told: string[] = []
  const marks = readMarks({
    read: (messageId) => {
      told.push(messageId)
    },
    send: (messageId) => {
      sent.push(messageId)
      const answer = answers.shift() ?? 'ok'
      const result = answer === 'ok' ? Promise.resolve() : Promise.reject(new Error('offline'))
      settled.push(result.catch(() => undefined))
      return result
    },
  })
  const settle = async () => {
    await Promise.all(settled)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { marks, sent, told, settle }
}

describe('the read marker', () => {
  it('sends the newest message on screen', () => {
    const { marks, sent } = marker()
    marks.seen([M2, M3, M1])
    assert.deepEqual(sent, ['m3'])
  })

  it('does not send an older message that comes on screen after a newer one', () => {
    const { marks, sent } = marker()
    marks.seen([M3])
    marks.seen([M1, M2])
    assert.deepEqual(sent, ['m3'])
  })

  it('sends the same newest message once, however often it is on screen', () => {
    const { marks, sent } = marker()
    marks.seen([M2, M3])
    marks.seen([M3])
    marks.seen([M2, M3])
    assert.deepEqual(sent, ['m3'])
  })

  it('sends a newer message when it comes on screen', () => {
    const { marks, sent } = marker()
    marks.seen([M2])
    marks.seen([M3, M4])
    assert.deepEqual(sent, ['m2', 'm4'])
  })

  it('sends nothing while the app is in the background, then the newest seen on coming back', () => {
    const { marks, sent } = marker()
    marks.active(false)
    marks.seen([M2])
    marks.seen([M3])
    assert.deepEqual(sent, [])
    marks.active(true)
    assert.deepEqual(sent, ['m3'])
    marks.active(true)
    assert.deepEqual(sent, ['m3'])
  })

  it('sends a message again on its next sighting when its send failed, without throwing', async () => {
    const { marks, sent, settle } = marker(['fail'])
    marks.seen([M3])
    await settle()
    marks.seen([M3])
    assert.deepEqual(sent, ['m3', 'm3'])
  })

  it('does not send an older message again when its send failed after a newer one went', async () => {
    const { marks, sent, settle } = marker(['fail', 'ok'])
    marks.seen([M2])
    marks.seen([M3])
    await settle()
    marks.seen([M2])
    assert.deepEqual(sent, ['m2', 'm3'])
  })

  it('sends the newest that went through before a later one failed, but no older one', async () => {
    const { marks, sent, settle } = marker(['ok', 'fail'])
    marks.seen([M2])
    await settle()
    marks.seen([M3])
    await settle()
    marks.seen([M2])
    assert.deepEqual(sent, ['m2', 'm3'])
  })

  it('sends nothing once stopped, even what it held for the foreground', () => {
    const { marks, sent } = marker()
    marks.active(false)
    marks.seen([M2])
    marks.stop()
    marks.active(true)
    marks.seen([M4])
    assert.deepEqual(sent, [])
  })

  // The list reports the rows on screen in the same commit that adds a new message, before the
  // screen's own effects run, so the marker takes each row's send time from the row itself.
  it('sends a message that has just arrived, from the row on screen alone', () => {
    const { marks, sent } = marker()
    marks.seen([M1, M2])
    marks.seen([M1, M2, row('m5', 5)])
    assert.deepEqual(sent, ['m2', 'm5'])
  })

  it('reads a send time the list gives as a number of milliseconds', () => {
    const { marks, sent } = marker()
    marks.seen([M3])
    marks.seen([{ _id: 'm4', createdAt: Date.UTC(2026, 10, 25, 9, 4) }, M1])
    assert.deepEqual(sent, ['m3', 'm4'])
  })

  // The icon badge counts unread mentions, so the app reloads it once the server took a marker,
  // whichever screen the member then leaves the app from.
  it('tells the app each marker the server took, even once the screen has closed', async () => {
    const { marks, told, settle } = marker()
    marks.seen([M2])
    await settle()
    assert.deepEqual(told, ['m2'])
    marks.seen([M3])
    marks.stop()
    await settle()
    assert.deepEqual(told, ['m2', 'm3'])
  })

  it('tells the app nothing of a marker the server did not take', async () => {
    const { marks, told, settle } = marker(['fail'])
    marks.seen([M3])
    await settle()
    assert.deepEqual(told, [])
  })

  it('sends nothing when no message is on screen', () => {
    const { marks, sent } = marker()
    marks.seen([])
    assert.deepEqual(sent, [])
  })
})

describe('the read marker viewability config', () => {
  it('has an id of its own, so the list does not share its viewable rows with the library pair', () => {
    assert.equal(typeof READ_MARKER_VIEWABILITY.id, 'string')
    assert.notEqual(READ_MARKER_VIEWABILITY.id, '')
  })
})
