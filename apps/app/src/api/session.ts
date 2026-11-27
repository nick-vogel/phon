import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'

/**
 * The one place the app keeps its Phon session. Every server call reads the token from here.
 *
 * The token lives in the platform's secure storage (the Keychain on iOS, the Keystore on Android)
 * and in memory. `loadSession()` reads it once at startup; after that every read is synchronous.
 */

const STORAGE_KEY = 'phon.session'

export interface SessionState {
  /** False until the stored session has been read at startup. */
  loaded: boolean
  token: string | null
}

let state: SessionState = { loaded: false, token: null }
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(next: SessionState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Reads the stored session once. A store that cannot be read counts as signed out. */
export function loadSession(): Promise<void> {
  if (loading === null) {
    loading = SecureStore.getItemAsync(STORAGE_KEY)
      .catch(() => null)
      .then((stored) => {
        // A sign-in that finished while the store was being read wins over what was stored.
        if (state.loaded) return
        set({ loaded: true, token: stored === '' ? null : stored })
      })
  }
  return loading
}

/** Keeps a new session, in memory now and in secure storage. */
export async function saveSession(token: string): Promise<void> {
  set({ loaded: true, token })
  await SecureStore.setItemAsync(STORAGE_KEY, token)
}

/**
 * Forgets the session. With a token, it forgets the session only while that is still the current
 * one, so a refusal of an old session never signs out a newer one.
 */
export async function clearSession(token?: string): Promise<void> {
  if (token !== undefined && token !== state.token) return
  set({ loaded: true, token: null })
  await SecureStore.deleteItemAsync(STORAGE_KEY)
}

/** Calls `listener` whenever the session changes. Returns the unsubscribe. */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current session, for a component that shows or hides screens by it. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, () => state)
}

/** The current bearer token, or null when signed out. */
export function bearerToken(): string | null {
  return state.token
}

/** The `Authorization` header for the current token, or no header when there is none. */
export function authorizationHeader(): Record<string, string> {
  const token = bearerToken()
  return token === null ? {} : { Authorization: `Bearer ${token}` }
}
