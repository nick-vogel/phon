/**
 * The app icon badge's decisions, observed through a fake badge that keeps the last number set.
 * The wiring (`src/push.ts` calling `setBadgeCountAsync` and the permission prompt, and the home
 * screen calling `showMentionBadge` on each list load) imports Expo and React Native, which this
 * runner cannot load: the type check and the build cover it, and a hand check on the iOS Simulator
 * covers the real badge (after a list load, after a foreground push, and 0 after the mentions are
 * read).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChannelSummary } from '@phon/api-types'
import { mentionBadge, NOTIFICATION_PERMISSIONS, showMentionBadge } from '../src/app-badge.ts'

function channel(id: string, extra: Partial<ChannelSummary> = {}): ChannelSummary {
  return { id, name: id, kind: 'open', canPost: true, ...extra }
}

/** The icon's badge, as the phone shows it. `failNext` makes the next set reject once. */
function fakeBadge(start = 0) {
  const badge = {
    count: start,
    sets: 0,
    failNext: false,
    set: async (count: number) => {
      badge.sets += 1
      if (badge.failNext) {
        badge.failNext = false
        throw new Error('badge unavailable')
      }
      badge.count = count
      return true
    },
  }
  return badge
}

describe('the app icon badge', () => {
  it("is set on a list load to the sum of the list's mention counts", async () => {
    const badge = fakeBadge()

    await showMentionBadge(
      [
        channel('general', { unread: true, mentions: 2 }),
        channel('worship', { unread: true, mentions: 5 }),
        channel('youth'),
      ],
      badge.set,
      'ios',
    )

    assert.equal(badge.count, 7)
  })

  it('is cleared to 0 by a list with no unread mentions, even when a push left a number', async () => {
    const badge = fakeBadge(4)

    await showMentionBadge(
      [channel('general', { unread: true, mentions: 0 }), channel('youth', { unread: false })],
      badge.set,
      'ios',
    )

    assert.equal(badge.count, 0)
  })

  it('is 0 for a member with no channels', async () => {
    const badge = fakeBadge(3)

    await showMentionBadge([], badge.set, 'ios')

    assert.equal(badge.count, 0)
  })

  it('counts nothing for an oversight channel, even when its summary carries mentions', () => {
    assert.equal(
      mentionBadge([
        channel('general', { mentions: 1 }),
        channel('elders', { oversight: true, mentions: 6 }),
      ]),
      1,
    )
  })

  it("counts a channel's real mentions above 99, not the row's 99+", () => {
    assert.equal(
      mentionBadge([channel('general', { mentions: 120 }), channel('youth', { mentions: 3 })]),
      123,
    )
  })

  it('drops a failed set without failing the load, and the next load sets it', async () => {
    const badge = fakeBadge(2)
    badge.failNext = true

    await showMentionBadge([channel('general', { mentions: 5 })], badge.set, 'ios')
    assert.equal(badge.count, 2)

    await showMentionBadge([channel('general', { mentions: 5 })], badge.set, 'ios')
    assert.equal(badge.count, 5)
  })

  it('is never set on Android, where setting 0 dismisses every notification in the shade', async () => {
    const badge = fakeBadge(3)

    await showMentionBadge(
      [channel('general', { unread: true, mentions: 0 })],
      badge.set,
      'android',
    )
    await showMentionBadge([channel('general', { mentions: 2 })], badge.set, 'android')

    assert.equal(badge.sets, 0)
  })
})

describe('the notification permission prompt', () => {
  it('asks iOS for the badge, with alerts and sounds', () => {
    assert.deepEqual(NOTIFICATION_PERMISSIONS, {
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    })
  })
})
