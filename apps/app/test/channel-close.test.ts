import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  channelClosed,
  clearedOnOpen,
  NO_LONGER_A_MEMBER,
  NOT_LOADED_NOTICE,
} from '../src/channel-close.ts'

describe('what the channel screen does when its live socket closes on its own', () => {
  it('uses the close code the server sends a person taken out of the channel', () => {
    assert.equal(NO_LONGER_A_MEMBER, 4403)
  })

  it('treats a 4403 on an open socket as the person being taken out', () => {
    assert.deepEqual(channelClosed(true, 4403), { outcome: 'evicted' })
  })

  it('treats a 4403 on a socket that never opened as the person being taken out', () => {
    assert.deepEqual(channelClosed(false, 4403), { outcome: 'evicted' })
  })

  it('reconnects when an open socket drops', () => {
    assert.deepEqual(channelClosed(true, 1006), {
      outcome: 'dropped',
      notice: 'Disconnected from live messages',
    })
  })

  it('reconnects when the socket never connected', () => {
    assert.deepEqual(channelClosed(false, 1006), {
      outcome: 'dropped',
      notice: 'Live messages could not connect',
    })
  })

  it('reconnects when the close carries no code', () => {
    assert.deepEqual(channelClosed(true, undefined), {
      outcome: 'dropped',
      notice: 'Disconnected from live messages',
    })
    assert.deepEqual(channelClosed(false, undefined), {
      outcome: 'dropped',
      notice: 'Live messages could not connect',
    })
  })

  it('reconnects when the server closes normally', () => {
    assert.deepEqual(channelClosed(true, 1000), {
      outcome: 'dropped',
      notice: 'Disconnected from live messages',
    })
  })
})

describe('which notices go once the channel socket opens again', () => {
  it("takes off a drop's notice", () => {
    for (const opened of [true, false]) {
      const closed = channelClosed(opened, 1006)
      assert.equal(closed.outcome, 'dropped')
      if (closed.outcome === 'dropped') assert.equal(clearedOnOpen(closed.notice), true)
    }
  })

  it('takes off the notice of a read that failed while the socket was down', () => {
    assert.equal(clearedOnOpen(NOT_LOADED_NOTICE), true)
  })

  it('leaves a notice the socket opening does not answer', () => {
    assert.equal(clearedOnOpen('Not connected. The message was not sent.'), false)
    assert.equal(clearedOnOpen('Not connected. The reaction was not sent.'), false)
    assert.equal(clearedOnOpen('Only team leads can send a team announcement'), false)
  })
})
