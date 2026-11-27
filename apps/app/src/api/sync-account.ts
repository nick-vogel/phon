import type { ConnectRefusal, ConnectRequest } from '@phon/api-types'
import type { Fetch } from './email-sign-in'

/**
 * The server call that connects a church's sync account: the dedicated Planning Center account
 * the roster sync reads with. It takes the fetch to call with and the API origin, so a test runs
 * it with a stub.
 */

/**
 * How a sync account connect ended: connected, refused because the account is not a Planning
 * Center organization administrator, or anything else that went wrong.
 */
export type SyncConnectOutcome = 'connected' | 'not-administrator' | 'failed'

/**
 * Sends a finished Planning Center authorization to `POST /connect`, which stores the account's
 * tokens on the server. Saves no session: a sync connect signs no one in.
 */
export async function connectSync(
  fetch: Fetch,
  origin: string,
  request: ConnectRequest,
): Promise<SyncConnectOutcome> {
  try {
    const response = await fetch(`${origin}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (response.status === 204) return 'connected'
    if (response.status === 403) {
      const body = (await response.json()) as Partial<ConnectRefusal> | null
      if (body?.problem === 'not-administrator') return 'not-administrator'
    }
    return 'failed'
  } catch {
    return 'failed'
  }
}
