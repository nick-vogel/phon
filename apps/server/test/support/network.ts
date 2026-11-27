/**
 * The one network recorder. Every outgoing fetch in a test, from the test itself, the Worker or a
 * Durable Object, goes through it: the Worker and its Durable Objects run in the test isolate, so
 * replacing `globalThis.fetch` reaches them too.
 *
 * A call is answered only by a stub the test registered for its method and URL, or, when no such
 * stub exists, by a path stub for its method and its URL without the query. Any other call is
 * refused, and `verify()` (run after every test by `setup.ts`) fails the test even when the code
 * under test caught the refusal.
 */

export interface RecordedCall {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  /** When the call was made, in milliseconds since the epoch. */
  at: number
}

type Responder = (request: Request) => Response | Promise<Response>

const realFetch = globalThis.fetch
const stubs = new Map<string, Responder>()
const pathStubs = new Map<string, Responder>()
const recorded: RecordedCall[] = []
const refused: RecordedCall[] = []

function key(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`
}

function describeCall(call: RecordedCall): string {
  return `Unstubbed fetch: ${key(call.method, call.url)}`
}

async function recordedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  const body = request.body === null ? null : await request.clone().text()
  const call: RecordedCall = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body,
    at: Date.now(),
  }
  recorded.push(call)

  const url = new URL(call.url)
  const respond =
    stubs.get(key(call.method, call.url)) ??
    pathStubs.get(key(call.method, `${url.origin}${url.pathname}`))
  if (respond === undefined) {
    refused.push(call)
    throw new Error(describeCall(call))
  }
  return respond(request)
}

export const network = {
  /** Replaces `globalThis.fetch` with the recorder. */
  install(): void {
    globalThis.fetch = recordedFetch as typeof fetch
  },

  /** Puts the runtime's own fetch back. */
  uninstall(): void {
    globalThis.fetch = realFetch
  },

  /** Answers every call to `url` with `method` from `respond`. */
  stub(method: string, url: string, respond: Responder): void {
    stubs.set(key(method, url), respond)
  },

  /**
   * Answers every call with `method` to `urlWithoutQuery`, whatever its query, when no exact stub
   * matches the call. For APIs that page with query parameters.
   */
  stubPath(method: string, urlWithoutQuery: string, respond: Responder): void {
    pathStubs.set(key(method, urlWithoutQuery), respond)
  },

  /** Every call made since the last reset, in order, stubbed or not. */
  calls(): RecordedCall[] {
    return [...recorded]
  },

  /** Throws when any call since the last reset had no stub. */
  verify(): void {
    if (refused.length > 0) {
      throw new Error(refused.map(describeCall).join('\n'))
    }
  },

  /** Clears the stubs and the record. */
  reset(): void {
    stubs.clear()
    pathStubs.clear()
    recorded.length = 0
    refused.length = 0
  },
}
