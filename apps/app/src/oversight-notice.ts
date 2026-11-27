import { useSyncExternalStore } from 'react'
import { acknowledgeOversightNotice, getOversightNotice } from './api/client'
import { bearerToken, subscribeSession } from './api/session'

/**
 * Whether the signed-in person has seen the oversight notice, as the server says. The layout keeps
 * every channel behind it, so a person who has not seen it sees the notice first.
 */

export interface OversightNoticeState {
  /** False until the server has answered for the current session. */
  loaded: boolean
  seen: boolean
}

let state: OversightNoticeState = { loaded: false, seen: false }
let loadingFor: string | null = null
const listeners = new Set<() => void>()

function set(next: OversightNoticeState): void {
  state = next
  for (const listener of listeners) listener()
}

// A new session is a new person, so what the last one saw goes with it.
subscribeSession(() => {
  if (bearerToken() === loadingFor) return
  loadingFor = null
  set({ loaded: false, seen: false })
})

/**
 * Asks the server once per session whether the person has seen the notice. A load that fails
 * shows the notice, which is the safe side: seeing it twice costs a tap.
 */
export function loadOversightNotice(): void {
  const token = bearerToken()
  if (token === null || loadingFor === token) return
  loadingFor = token
  getOversightNotice()
    .then((notice) => {
      if (bearerToken() === token) set({ loaded: true, seen: notice.seen })
    })
    .catch(() => {
      if (bearerToken() === token) set({ loaded: true, seen: false })
    })
}

/** Records with the server that the person saw the notice, then lets them on to their channels. */
export async function acknowledgeNotice(): Promise<void> {
  const token = bearerToken()
  await acknowledgeOversightNotice()
  if (bearerToken() === token) set({ loaded: true, seen: true })
}

/** The notice state, for the layout that guards the channel screens by it. */
export function useOversightNotice(): OversightNoticeState {
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
