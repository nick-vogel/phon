import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectSync } from '../src/api/sync-account.ts'

const ORIGIN = 'https://phon.example'

interface Sent {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: unknown
}

/** A fetch that answers every call with `answer`, and records what it was sent. */
function stubFetch(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    sent.push({
      url,
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    return answer()
  }
  return { fetch, sent }
}

const request = { code: 'pco-code', codeVerifier: 'verifier-hex', nonce: 'nonce-hex' }

describe("connecting the church's sync account", () => {
  it('posts the code, the verifier and the nonce as JSON to /connect, and a 204 is connected', async () => {
    const { fetch, sent } = stubFetch(() => new Response(null, { status: 204 }))

    assert.equal(await connectSync(fetch, ORIGIN, request), 'connected')
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.url, `${ORIGIN}/connect`)
    assert.equal(sent[0]?.method, 'POST')
    assert.equal(sent[0]?.headers['content-type'], 'application/json')
    assert.deepEqual(sent[0]?.body, request)
  })

  it('answers not-administrator when the server refuses an account that is not an administrator', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ problem: 'not-administrator' }, { status: 403 }),
    )

    assert.equal(await connectSync(fetch, ORIGIN, request), 'not-administrator')
  })

  it('answers failed for a failed connect, a server error, any other refusal or body, or no network', async () => {
    for (const answer of [
      () => Response.json({ problem: 'connect-failed' }, { status: 400 }),
      () => new Response('down', { status: 503 }),
      () => Response.json({ problem: 'connect-failed' }, { status: 403 }),
      () => new Response('not json', { status: 403 }),
      () => new Response(null, { status: 200 }),
      (): never => {
        throw new TypeError('Network request failed')
      },
    ]) {
      const { fetch } = stubFetch(answer)
      assert.equal(await connectSync(fetch, ORIGIN, request), 'failed')
    }
  })
})
