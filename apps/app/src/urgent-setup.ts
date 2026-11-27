import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'

/**
 * Whether this device has shown the urgent setup screen. The phone settings it explains (Time
 * Sensitive on iPhone, Override Do Not Disturb on Android) belong to the device, so the seen state
 * lives on the device too, and a new phone shows the screen again. The layout shows it once, after
 * the oversight notice, and the channel bar keeps it reachable.
 */

export interface UrgentSetupState {
  /** False until the device's stored answer has been read. */
  loaded: boolean
  seen: boolean
}

const STORAGE_KEY = 'phon.urgent-setup-seen'

let state: UrgentSetupState = { loaded: false, seen: false }
let loading = false
const listeners = new Set<() => void>()

function set(next: UrgentSetupState): void {
  state = next
  for (const listener of listeners) listener()
}

/**
 * Reads once whether this device has shown the screen. A read that fails shows it, which is the
 * safe side: seeing it twice costs a tap.
 */
export function loadUrgentSetup(): void {
  if (loading || state.loaded) return
  loading = true
  SecureStore.getItemAsync(STORAGE_KEY)
    .then((stored) => set({ loaded: true, seen: stored === 'seen' }))
    .catch(() => set({ loaded: true, seen: false }))
}

/** Records on this device that the person went through the screen. */
export async function markUrgentSetupSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, 'seen')
  } finally {
    // Even when the write fails, the person is let on: the screen shows again next launch.
    set({ loaded: true, seen: true })
  }
}

/** The setup state, for the layout that shows the screen once. */
export function useUrgentSetup(): UrgentSetupState {
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
