/**
 * Where the server lives. `EXPO_PUBLIC_*` variables are inlined when the app is bundled, so each
 * one is read with dot notation, exactly as written here.
 */
const API_URL = process.env.EXPO_PUBLIC_PHON_API_URL

/** The Worker's origin, such as `https://phon.example.workers.dev`, with no trailing slash. */
export function apiOrigin(): string {
  if (API_URL === undefined || API_URL === '') {
    throw new Error('EXPO_PUBLIC_PHON_API_URL is not set')
  }
  return API_URL.replace(/\/+$/, '')
}

/** The same origin for WebSockets: `https` becomes `wss`, and `http` becomes `ws`. */
export function socketOrigin(): string {
  return apiOrigin().replace(/^http/, 'ws')
}
