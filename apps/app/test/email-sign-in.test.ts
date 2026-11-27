import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkCode, choosePerson, listChurches, requestCode } from '../src/api/email-sign-in.ts'

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

function failing(): never {
  throw new TypeError('Network request failed')
}

const churches = [{ churchId: 'pco-1', name: 'Example Fellowship' }]

describe('listing the churches to sign in to', () => {
  it('reads GET /churches and answers its list', async () => {
    const { fetch, sent } = stubFetch(() => Response.json({ churches }))

    assert.deepEqual(await listChurches(fetch, ORIGIN), { outcome: 'listed', churches })
    assert.equal(sent[0]?.url, `${ORIGIN}/churches`)
    assert.equal(sent[0]?.method, 'GET')
  })

  it('answers wait for the 429 a caller past its limit gets', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ problem: 'try-again' }, { status: 429, headers: { 'retry-after': '60' } }),
    )

    assert.deepEqual(await listChurches(fetch, ORIGIN), { outcome: 'wait' })
  })

  it('answers try-again for a server error, a body that is not a list, or no network', async () => {
    for (const answer of [
      () => new Response('down', { status: 503 }),
      () => Response.json({ nope: true }),
      failing,
    ]) {
      const { fetch } = stubFetch(answer)
      assert.deepEqual(await listChurches(fetch, ORIGIN), { outcome: 'try-again' })
    }
  })
})

describe('asking for an email code', () => {
  const request = { churchId: 'pco-1', address: 'ada@example.org' }

  it('posts the church and the address as JSON, and a 204 is sent', async () => {
    const { fetch, sent } = stubFetch(() => new Response(null, { status: 204 }))

    assert.deepEqual(await requestCode(fetch, ORIGIN, request), { outcome: 'sent' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.url, `${ORIGIN}/auth/email/code`)
    assert.equal(sent[0]?.method, 'POST')
    assert.equal(sent[0]?.headers['content-type'], 'application/json')
    assert.deepEqual(sent[0]?.body, request)
  })

  it('answers wait for the 429 a caller past its limit gets', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ problem: 'try-again' }, { status: 429, headers: { 'retry-after': '60' } }),
    )

    assert.deepEqual(await requestCode(fetch, ORIGIN, request), { outcome: 'wait' })
  })

  it('answers try-again for a 503, any other status, or no network', async () => {
    for (const answer of [
      () => Response.json({ problem: 'try-again' }, { status: 503 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 200 }),
      failing,
    ]) {
      const { fetch } = stubFetch(answer)
      assert.deepEqual(await requestCode(fetch, ORIGIN, request), { outcome: 'try-again' })
    }
  })
})

describe('checking an email code', () => {
  const check = { churchId: 'pco-1', address: 'ada@example.org', code: '042137' }

  it('posts the church, the address and the code as JSON, and a 200 with a token signs in', async () => {
    const { fetch, sent } = stubFetch(() => Response.json({ token: 'pco-1.secret' }))

    assert.deepEqual(await checkCode(fetch, ORIGIN, check), {
      outcome: 'signed-in',
      token: 'pco-1.secret',
    })
    assert.equal(sent[0]?.url, `${ORIGIN}/auth/email/session`)
    assert.equal(sent[0]?.method, 'POST')
    assert.equal(sent[0]?.headers['content-type'], 'application/json')
    assert.deepEqual(sent[0]?.body, check)
  })

  it('answers wrong-code for a 400', async () => {
    const { fetch } = stubFetch(() => Response.json({ problem: 'wrong-code' }, { status: 400 }))

    assert.deepEqual(await checkCode(fetch, ORIGIN, check), { outcome: 'wrong-code' })
  })

  it('answers wait for the 429 a caller past its limit gets', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ problem: 'try-again' }, { status: 429, headers: { 'retry-after': '60' } }),
    )

    assert.deepEqual(await checkCode(fetch, ORIGIN, check), { outcome: 'wait' })
  })

  it('answers try-again for the 503 a church past its limit on wrong codes answers', async () => {
    const { fetch } = stubFetch(() => Response.json({ problem: 'try-again' }, { status: 503 }))

    assert.deepEqual(await checkCode(fetch, ORIGIN, check), { outcome: 'try-again' })
  })

  it('answers try-again for a 200 with no token, any other status, or no network', async () => {
    for (const answer of [
      () => Response.json({}),
      () => Response.json({ token: '' }),
      () => new Response('down', { status: 503 }),
      () => new Response(null, { status: 404 }),
      failing,
    ]) {
      const { fetch } = stubFetch(answer)
      assert.deepEqual(await checkCode(fetch, ORIGIN, check), { outcome: 'try-again' })
    }
  })
})

describe('a code for an address several people share', () => {
  const check = { churchId: 'pco-1', address: 'brandts@example.org', code: '042137' }
  const people = [
    { personId: 'ada', name: 'Ada Brandt' },
    { personId: 'tess', name: 'Tess Brandt' },
  ]

  it('answers choose with the choice token and the names, in the order the server sent', async () => {
    const { fetch } = stubFetch(() => Response.json({ choiceToken: 'choice-secret', people }))

    assert.deepEqual(await checkCode(fetch, ORIGIN, check), {
      outcome: 'choose',
      choiceToken: 'choice-secret',
      people,
    })
  })

  it('answers try-again for a choice with no people, one person, or a person with no name', async () => {
    for (const body of [
      { choiceToken: 'choice-secret' },
      { choiceToken: 'choice-secret', people: [people[0]] },
      { choiceToken: 'choice-secret', people: [people[0], { personId: 'tess' }] },
      { choiceToken: '', people },
    ]) {
      const { fetch } = stubFetch(() => Response.json(body))
      assert.deepEqual(await checkCode(fetch, ORIGIN, check), { outcome: 'try-again' })
    }
  })
})

describe('picking a name', () => {
  const choice = { churchId: 'pco-1', choiceToken: 'choice-secret', personId: 'tess' }

  it('posts the church, the choice token and the person as JSON, and a 200 with a token signs in', async () => {
    const { fetch, sent } = stubFetch(() => Response.json({ token: 'pco-1.secret' }))

    assert.deepEqual(await choosePerson(fetch, ORIGIN, choice), {
      outcome: 'signed-in',
      token: 'pco-1.secret',
    })
    assert.equal(sent[0]?.url, `${ORIGIN}/auth/email/choice`)
    assert.equal(sent[0]?.method, 'POST')
    assert.equal(sent[0]?.headers['content-type'], 'application/json')
    assert.deepEqual(sent[0]?.body, choice)
  })

  it('answers wait for the 429 a caller past its limit gets', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ problem: 'try-again' }, { status: 429, headers: { 'retry-after': '60' } }),
    )

    assert.deepEqual(await choosePerson(fetch, ORIGIN, choice), { outcome: 'wait' })
  })

  it('answers start-over for a 400', async () => {
    const { fetch } = stubFetch(() => Response.json({ problem: 'start-over' }, { status: 400 }))

    assert.deepEqual(await choosePerson(fetch, ORIGIN, choice), { outcome: 'start-over' })
  })

  it('answers try-again for a 200 with no token, any other status, or no network', async () => {
    for (const answer of [
      () => Response.json({}),
      () => new Response('down', { status: 503 }),
      failing,
    ]) {
      const { fetch } = stubFetch(answer)
      assert.deepEqual(await choosePerson(fetch, ORIGIN, choice), { outcome: 'try-again' })
    }
  })
})
