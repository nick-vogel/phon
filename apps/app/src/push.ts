import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { registerDevice } from './api/client'
import { NOTIFICATION_PERMISSIONS } from './app-badge'
import { MESSAGES_CHANNEL, URGENT_CHANNEL, URGENT_CHANNEL_NAME } from './notification-channels'
import { phonePushToken } from './push-token'

// A push that arrives while the app is open shows as a banner and in the list, with no sound: the
// person is already looking at the phone. It sets the icon's badge to the total it carries, as it
// does in the background.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
})

/**
 * The EAS project the Expo push token belongs to, or null until the app has one (phon#20 and
 * phon#21 set it). Without it Expo issues no token.
 */
function easProjectId(): string | null {
  const fromEas = Constants.easConfig?.projectId
  if (typeof fromEas === 'string' && fromEas !== '') return fromEas
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined
  const fromExtra = extra?.eas?.projectId
  return typeof fromExtra === 'string' && fromExtra !== '' ? fromExtra : null
}

/** This phone's Expo push token, kept on the device across launches. */
const pushToken = phonePushToken(SecureStore)

/**
 * This phone's Expo push token, from this launch or an earlier one, or null when it never had
 * one, so signing out can ask the server to stop alerting this phone even when this launch's
 * registration failed or is still under way.
 */
export function registeredPushToken(): Promise<string | null> {
  return pushToken.current()
}

/**
 * Registers this device for the signed-in person's alerts: makes the Android channels, asks for
 * permission for alerts, sounds and the icon's badge when it has not been answered, gets the Expo
 * push token and sends it to the server. The server decides who is alerted for what. Every failure is dropped: the next launch, or the
 * next token change, tries again.
 */
export async function registerForPush(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
      })
      await Notifications.setNotificationChannelAsync(URGENT_CHANNEL, {
        name: URGENT_CHANNEL_NAME,
        importance: Notifications.AndroidImportance.MAX,
        bypassDnd: true,
      })
    }
    let permission = await Notifications.getPermissionsAsync()
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync(NOTIFICATION_PERMISSIONS)
    }
    if (!permission.granted) return

    const projectId = easProjectId()
    if (projectId === null) return
    const token = await Notifications.getExpoPushTokenAsync({ projectId })
    await pushToken.remember(token.data)
    await registerDevice(token.data)
  } catch {
    // Expo's servers or Phon's could not be reached; the next launch tries again.
  }
}

/**
 * Registers this device now and again whenever its push token changes, for as long as the
 * session lasts. Answers the stop, for when the session ends. The stop keeps the token: it is the
 * phone's, and the next session's sign-out needs it.
 */
export function keepRegisteredForPush(): () => void {
  void registerForPush()
  const subscription = Notifications.addPushTokenListener(() => {
    void registerForPush()
  })
  return () => {
    subscription.remove()
  }
}

/**
 * Calls the listener whenever a push arrives while the app is open, so a screen can reload what
 * the push says changed. Answers the stop.
 */
export function subscribePushReceived(listener: () => void): () => void {
  const subscription = Notifications.addNotificationReceivedListener(() => {
    listener()
  })
  return () => {
    subscription.remove()
  }
}

/**
 * Sets the app icon's badge to the count, 0 clearing it. Answers false when the phone has no
 * badge to set: iOS without the badge permission, or an Android launcher with no badges. On
 * Android a count of 0 also dismisses every notification in the shade, so `showMentionBadge`
 * never calls it there.
 */
export function setAppBadgeCount(count: number): Promise<boolean> {
  return Notifications.setBadgeCountAsync(count)
}
