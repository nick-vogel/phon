/**
 * This phone's Expo push token, kept across launches, so signing out can name the phone to the
 * server even on a launch that learned no token (offline, Expo down, or still asking). The token
 * belongs to the phone, not the session: the server deletes it only when it is the signing-out
 * person's, so a token left from an earlier session is safe to send.
 */

/** Where the token is kept: SecureStore in the app, a map in tests. */
export interface TokenStore {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
}

const STORAGE_KEY = 'phon.push-token'

export interface PhonePushToken {
  /** Records the token Expo answered, before it is sent to Phon. A failed write is dropped. */
  remember(token: string): Promise<void>
  /** The token this launch learned, else the one an earlier launch kept, else null. */
  current(): Promise<string | null>
}

export function phonePushToken(store: TokenStore): PhonePushToken {
  let known: string | null = null
  return {
    async remember(token) {
      known = token
      try {
        await store.setItemAsync(STORAGE_KEY, token)
      } catch {
        // This launch still knows it; the next launch learns it again from Expo.
      }
    },
    async current() {
      if (known !== null) return known
      try {
        return await store.getItemAsync(STORAGE_KEY)
      } catch {
        return null
      }
    },
  }
}
