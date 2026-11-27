import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ServerFrame } from '@phon/api-types'
import { channelSocketEvents } from '../src/api/channel-socket-events.ts'

/** A socket's events wired to handlers that record what reaches the screen. */
function harness() {
  const seen: string[] = []
  let platformCloses = 0
  const events = channelSocketEvents(
    {
      onOpen: () => seen.push('open'),
      onFrame: (frame) => seen.push(`frame ${frame.type}`),
      onClose: (opened, code) => seen.push(`close ${opened} ${code}`),
    },
    () => {
      platformCloses += 1
    },
  )
  return { events, seen, closes: () => platformCloses }
}

const frame: ServerFrame = { type: 'removed', messageId: 'm1' }

describe("a channel socket's events", () => {
  it('passes on the open, each frame, and a close the app did not ask for', () => {
    const { events, seen } = harness()
    events.opened()
    events.message(JSON.stringify(frame))
    events.closed(1006)
    assert.deepEqual(seen, ['open', 'frame removed', 'close true 1006'])
  })

  // Android cannot cancel an upgrade still connecting, so a socket the app closed then can open
  // after all. It must not tell the screen it is live, and it must not stay connected.
  it('closes, and passes on nothing from, a socket that opens after the app closed it', () => {
    const { events, seen, closes } = harness()
    events.close()
    events.opened()
    events.message(JSON.stringify(frame))
    events.closed(1000)
    assert.deepEqual(seen, [])
    assert.equal(closes(), 2)
  })

  it('passes on no frame once the app closed an open socket', () => {
    const { events, seen } = harness()
    events.opened()
    events.close()
    events.message(JSON.stringify(frame))
    assert.deepEqual(seen, ['open'])
  })
})
