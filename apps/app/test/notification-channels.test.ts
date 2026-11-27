import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '@phon/api-types'
import {
  ANDROID_MESSAGES_CHANNEL,
  ANDROID_URGENT_CHANNEL,
  pushMessages,
} from '../../server/src/expo-push.ts'
import { MESSAGES_CHANNEL, URGENT_CHANNEL } from '../src/notification-channels.ts'

const message: Message = {
  id: 'm1',
  churchId: 'c1',
  channelId: 'general',
  authorId: 'ana',
  body: 'Doors open at nine',
  sentAt: '2026-11-13T09:00:00.000Z',
  mentions: [],
  image: null,
  reactions: [],
}

const context = { channelName: 'general', authorName: 'Ana' }

describe('the Android channels a push names', () => {
  it('sends a Time Sensitive push to the urgent channel the app declares', () => {
    const [push] = pushMessages({ ...message, urgent: true }, context, [
      { token: 'ExponentPushToken[a]', interruptionLevel: 'time-sensitive' },
    ])
    assert.equal(push?.channelId, URGENT_CHANNEL)
    assert.equal(URGENT_CHANNEL, 'urgent')
  })

  it('sends an ordinary push to the messages channel the app declares', () => {
    const [push] = pushMessages(message, context, [
      { token: 'ExponentPushToken[b]', interruptionLevel: 'active' },
    ])
    assert.equal(push?.channelId, MESSAGES_CHANNEL)
    assert.equal(MESSAGES_CHANNEL, 'messages')
  })

  it('names the same two channels on the server and in the app', () => {
    assert.equal(ANDROID_URGENT_CHANNEL, URGENT_CHANNEL)
    assert.equal(ANDROID_MESSAGES_CHANNEL, MESSAGES_CHANNEL)
  })
})
