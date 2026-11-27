/**
 * The app icon's badge: the member's unread mentions across their own channels, the same number
 * the server keeps as their total and sends on every push as `badge`. Each channel list load sets
 * it; a push sets it in between. `src/push.ts` holds the Expo calls.
 */
import type { ChannelSummary } from '@phon/api-types'
import type { NotificationPermissionsRequest } from 'expo-notifications'

/**
 * What the notification prompt asks iOS for: alerts, sounds and the badge, named here so the
 * badge does not rest on the library's default. Android asks for what it always has.
 */
export const NOTIFICATION_PERMISSIONS: NotificationPermissionsRequest = {
  ios: { allowAlert: true, allowBadge: true, allowSound: true },
}

/**
 * The badge for a list: the sum of its mention counts, each one's real value (120, not the row's
 * 99+). An oversight channel shows no count on its row, so it adds none here.
 */
export function mentionBadge(channels: readonly ChannelSummary[]): number {
  let total = 0
  for (const channel of channels) {
    if (channel.oversight !== true) total += channel.mentions ?? 0
  }
  return total
}

/**
 * Sets the icon's badge to the list's mentions, 0 included, so a list with none clears the number
 * a push left. A failed set is dropped: the next load sets it again. Never on Android (`os` is
 * React Native's `Platform.OS`): there Expo's set of 0 dismisses every notification in the shade,
 * and the launcher counts the notifications on its own.
 */
export async function showMentionBadge(
  channels: readonly ChannelSummary[],
  setBadgeCount: (count: number) => Promise<unknown>,
  os: string,
): Promise<void> {
  if (os === 'android') return
  try {
    await setBadgeCount(mentionBadge(channels))
  } catch {
    // The badge could not be set; the next list load tries again.
  }
}
