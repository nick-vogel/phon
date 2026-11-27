import type { Message } from '@phon/api-types'
import type { InterruptionLevel } from './alerts.ts'
import { REGISTRY_NAME } from './registry-name.ts'

/** Expo's push service. Every push Phon sends goes here. */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/** The most messages Expo takes in one request. */
const EXPO_BATCH_LIMIT = 100

/** The longest a push body's message text may be before it is cut. */
const MAX_PUSH_TEXT = 180

/** The Android notification channel the app creates for message alerts. */
export const ANDROID_MESSAGES_CHANNEL = 'messages'

/**
 * The Android notification channel the app creates for urgent messages, at the highest importance,
 * which the person may let through Do Not Disturb.
 */
export const ANDROID_URGENT_CHANNEL = 'urgent'

/**
 * One device to push to, with its person's unread mention total across every channel, which the
 * push carries as the app icon's badge.
 */
export interface BadgedDevice {
  token: string
  badge: number
}

/** One device to alert for a message, as the alert decision answered for its person. */
export type PushTarget = BadgedDevice & { interruptionLevel: InterruptionLevel }

/** Who and where a message came from, named for the push's title and body. */
export interface PushContext {
  channelName: string
  authorName: string
}

/** What a channel message's push carries for the app: the message it is for. */
export interface MessagePushData {
  channelId: string
  messageId: string
}

/** What a birthdate request's push carries for the app: the person who entered the birthdate. */
export interface BirthdateRequestPushData {
  birthdateRequestFor: string
}

/** What a report's push carries for the app: the report, and the message it is about. */
export interface ReportPushData {
  type: 'report'
  reportId: string
  channelId: string
  messageId: string
}

/**
 * One message in Expo's push request format, carrying a message's data unless it says otherwise.
 * `badge` is the recipient's unread mention total, the number iOS shows on the app icon; zero
 * clears it.
 */
export interface ExpoPushMessage<Data extends object = MessagePushData> {
  to: string
  title: string
  body: string
  data: Data
  sound: 'default'
  priority: 'high'
  interruptionLevel: InterruptionLevel
  channelId: string
  badge: number
}

/**
 * One Expo push message per device: `#<channel>` as the title, `<author>: <text>` as the body. An
 * image with no caption reads `<author> posted an image`. An urgent message is titled
 * `Urgent in #<channel>` and a team announcement `Team announcement in #<channel>`. A Time
 * Sensitive push goes to the Android urgent channel, and every other to the messages channel.
 */
export function pushMessages(
  message: Message,
  context: PushContext,
  targets: PushTarget[],
): ExpoPushMessage[] {
  const text =
    message.body.length > MAX_PUSH_TEXT ? `${message.body.slice(0, MAX_PUSH_TEXT)}…` : message.body
  const body =
    message.image !== null && message.body === ''
      ? `${context.authorName} posted an image`
      : `${context.authorName}: ${text}`
  const title =
    message.urgent === true
      ? `Urgent in #${context.channelName}`
      : message.teamAnnouncement === true
        ? `Team announcement in #${context.channelName}`
        : `#${context.channelName}`
  return targets.map((target) => ({
    to: target.token,
    title,
    body,
    data: { channelId: message.channelId, messageId: message.id },
    sound: 'default',
    priority: 'high',
    interruptionLevel: target.interruptionLevel,
    channelId:
      target.interruptionLevel === 'time-sensitive'
        ? ANDROID_URGENT_CHANNEL
        : ANDROID_MESSAGES_CHANNEL,
    badge: target.badge,
  }))
}

/**
 * One Expo push message per device of an admin or team leader, telling them a person entered an
 * 18+ birthdate that an admin approves in Phon. It is not a channel message, so it alerts as an
 * ordinary message alert does.
 */
export function birthdateRequestPushes(
  name: string,
  personId: string,
  devices: BadgedDevice[],
): ExpoPushMessage<BirthdateRequestPushData>[] {
  return devices.map((device) => ({
    to: device.token,
    title: 'Birthdate to approve',
    body: `${name} entered a birthdate that makes them 18 or older. An admin approves it in Phon.`,
    data: { birthdateRequestFor: personId },
    sound: 'default',
    priority: 'high',
    interruptionLevel: 'active',
    channelId: ANDROID_MESSAGES_CHANNEL,
    badge: device.badge,
  }))
}

/**
 * One Expo push message per device of a moderator, telling them a message in a channel was
 * reported. It names neither the reporter nor the author and carries no text, so a lock screen
 * never shows who reported whom. It is addressed to them as moderators, not a channel message, so
 * it alerts as an ordinary message alert does.
 */
export function reportPushMessages(
  channelName: string,
  report: { reportId: string; channelId: string; messageId: string },
  devices: BadgedDevice[],
): ExpoPushMessage<ReportPushData>[] {
  return devices.map((device) => ({
    to: device.token,
    title: 'Message reported',
    body: `A message in #${channelName} was reported.`,
    data: {
      type: 'report',
      reportId: report.reportId,
      channelId: report.channelId,
      messageId: report.messageId,
    },
    sound: 'default',
    priority: 'high',
    interruptionLevel: 'active',
    channelId: ANDROID_MESSAGES_CHANNEL,
    badge: device.badge,
  }))
}

/**
 * Sends a church's pushes to Expo, only to the devices the registry lists for that church: a row a
 * church still holds for a device that moved on reaches no one. When the registry cannot answer,
 * nothing is sent and the failure is logged, which keeps message text in its church.
 */
export async function sendPushes(
  env: Env,
  churchId: string,
  messages: ExpoPushMessage<object>[],
): Promise<void> {
  if (messages.length === 0) return
  let owned: Set<string>
  try {
    const tokens = [...new Set(messages.map((message) => message.to))]
    owned = new Set(await env.CHURCH_REGISTRY.getByName(REGISTRY_NAME).ownedBy(churchId, tokens))
  } catch (error) {
    console.error(`Reading ${churchId}'s devices from the registry failed; no push sent`, error)
    return
  }
  await sendToExpo(messages.filter((message) => owned.has(message.to)))
}

/**
 * Sends pushes to Expo, at most 100 to a request. A refused request or a ticket Expo answers with
 * an error is logged and dropped: no retry and no receipts yet.
 */
async function sendToExpo(messages: ExpoPushMessage<object>[]): Promise<void> {
  for (let start = 0; start < messages.length; start += EXPO_BATCH_LIMIT) {
    const batch = messages.slice(start, start + EXPO_BATCH_LIMIT)
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    })
    if (!response.ok) {
      console.error(`Expo push refused ${batch.length} messages with ${response.status}`)
      continue
    }
    const answer = (await response.json().catch(() => null)) as {
      data?: Array<{ status?: string; message?: string }>
    } | null
    for (const ticket of answer?.data ?? []) {
      if (ticket.status === 'error') console.error(`Expo push ticket error: ${ticket.message}`)
    }
  }
}
