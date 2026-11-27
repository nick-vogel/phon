/** The Android channel the server's pushes name. It must exist before the permission prompt. */
export const MESSAGES_CHANNEL = 'messages'

/**
 * The Android channel the server's urgent pushes name. A channel's importance cannot change once it
 * exists, so urgent messages have their own, at the highest importance, which the person may let
 * through Do Not Disturb (the urgent setup screen explains how).
 */
export const URGENT_CHANNEL = 'urgent'

/** The urgent channel's name, as Android's notification settings show it. */
export const URGENT_CHANNEL_NAME = 'Urgent messages'
