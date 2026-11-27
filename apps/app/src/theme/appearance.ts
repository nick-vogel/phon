import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'
import { Appearance } from 'react-native'
import { colorSchemeOverride, parseAppearanceChoice } from './appearance-choices.ts'
import type { AppearanceChoice } from './theme.ts'

/**
 * The member's appearance choice, System, Light or Dark, stored on this device. System is the
 * default, so a phone that has stored nothing follows its own scheme. The layout reads it once at
 * startup and waits for it, so a member who chose Dark never sees a light first frame.
 *
 * A choice of Light or Dark also sets the app's interface style, so native chrome that reads the
 * phone's scheme and not the tokens (alerts, switches, refresh spinners, the Appearance control,
 * the root view) follows it too; System hands the style back to the phone. The style is set
 * before the store changes, so `useColorScheme()` already reports it when screens re-render.
 */

export interface AppearanceState {
  /** False until the device's stored choice has been read. */
  loaded: boolean
  choice: AppearanceChoice
}

const STORAGE_KEY = 'phon.appearance'

let state: AppearanceState = { loaded: false, choice: 'system' }
let loading = false
const listeners = new Set<() => void>()

function set(next: AppearanceState): void {
  Appearance.setColorScheme(colorSchemeOverride(next.choice))
  state = next
  for (const listener of listeners) listener()
}

/** Reads the stored choice once. A missing, unknown or unreadable value is System. */
export function loadAppearance(): void {
  if (loading || state.loaded) return
  loading = true
  SecureStore.getItemAsync(STORAGE_KEY)
    .then((stored) => set({ loaded: true, choice: parseAppearanceChoice(stored) }))
    .catch(() => set({ loaded: true, choice: 'system' }))
}

/**
 * Changes the choice. The app follows at once, and the device keeps it for the next launch; a
 * write that fails keeps the choice for this launch only.
 */
export async function setAppearance(choice: AppearanceChoice): Promise<void> {
  set({ loaded: true, choice })
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, choice)
  } catch {
    // The choice holds until the app closes; the next launch reads what the device last kept.
  }
}

/** The stored choice, re-rendering when it changes. */
export function useAppearance(): AppearanceState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => state,
  )
}
