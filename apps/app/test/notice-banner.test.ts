import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DISCONNECTED_NOTICE,
  NOT_CONNECTED_NOTICE,
  NOT_LOADED_NOTICE,
} from '../src/channel-close.ts'
import { noticeBanner } from '../src/notice-banner.ts'

describe('how a notice reads as a banner', () => {
  it('draws nothing when there is no notice and no Reconnect', () => {
    assert.equal(noticeBanner({ notice: null, reconnect: false }), null)
  })

  it('keeps the three drop notices word for word', () => {
    assert.equal(DISCONNECTED_NOTICE, 'Disconnected from live messages')
    assert.equal(NOT_CONNECTED_NOTICE, 'Live messages could not connect')
    assert.equal(NOT_LOADED_NOTICE, 'This channel could not be loaded')
  })

  for (const notice of [
    'Disconnected from live messages',
    'Live messages could not connect',
    'This channel could not be loaded',
  ]) {
    it(`reads "${notice}" as a connection banner with Reconnect`, () => {
      assert.deepEqual(noticeBanner({ notice, reconnect: true }), {
        text: notice,
        tone: 'connection',
        reconnect: true,
      })
    })
  }

  it('passes Reconnect through rather than deciding it again', () => {
    assert.deepEqual(
      noticeBanner({ notice: 'Live messages could not connect', reconnect: false }),
      {
        text: 'Live messages could not connect',
        tone: 'connection',
        reconnect: false,
      },
    )
  })

  for (const notice of [
    'Not connected. The message was not sent.',
    'Reported. The admins and chat admins have been told.',
  ]) {
    it(`reads "${notice}" as an info banner with no Reconnect`, () => {
      assert.deepEqual(noticeBanner({ notice, reconnect: false }), {
        text: notice,
        tone: 'info',
        reconnect: false,
      })
    })
  }

  it('keeps the info look for another notice while Reconnect shows', () => {
    assert.deepEqual(
      noticeBanner({ notice: 'Not connected. The message was not sent.', reconnect: true }),
      { text: 'Not connected. The message was not sent.', tone: 'info', reconnect: true },
    )
  })

  it('draws a Reconnect with no text as a connection banner', () => {
    assert.deepEqual(noticeBanner({ notice: null, reconnect: true }), {
      text: null,
      tone: 'connection',
      reconnect: true,
    })
  })
})
