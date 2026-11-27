import { exports } from 'cloudflare:workers'
import type { GifSearchResults } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { asMember, seedChurch } from './support/church.ts'
import { fakeKlipy, KLIPY_SEARCH, KLIPY_TEST_KEY, klipyCalls, klipyItem } from './support/klipy.ts'
import { network } from './support/network.ts'

const ben = { personId: 'ben', name: 'Ben Okafor' }

async function church() {
  return (await seedChurch({ people: [ben], channels: [] })).churchId
}

describe('searching GIFs', () => {
  it('asks KLIPY for G-rated GIFs only, on every search, whatever the app asks for', async () => {
    const churchId = await church()
    fakeKlipy({ pages: [[klipyItem('wave')], [klipyItem('wave-again')]] })

    const searches = [
      '/gifs?q=hello',
      '/gifs?q=praise&page=2',
      '/gifs?q=hello&content_filter=off&format_filter=mp4',
    ]
    for (const path of searches) {
      expect((await asMember(churchId, 'ben', path)).status).toBe(200)
    }

    const calls = klipyCalls()
    expect(calls).toHaveLength(searches.length)
    for (const call of calls) {
      const query = new URL(call.url).searchParams
      expect(query.getAll('content_filter')).toEqual(['high'])
      expect(query.getAll('format_filter')).toEqual(['gif'])
    }
  })

  it('never sends the KLIPY key to the app, whatever KLIPY answers', async () => {
    const churchId = await church()
    const leaky = klipyItem('leaky', { title: `Leaky ${KLIPY_TEST_KEY}`, echo: KLIPY_TEST_KEY })
    const keyInUrl = klipyItem('key-in-url')
    const sm = keyInUrl.file.sm?.gif
    if (sm !== undefined) sm.url = `https://static.klipy.com/ii/${KLIPY_TEST_KEY}/sm.gif`
    const echoed = klipyItem('echoed', { echo: { key: KLIPY_TEST_KEY } })
    fakeKlipy({ pages: [[leaky, keyInUrl, echoed]] })

    const answered = await asMember(churchId, 'ben', '/gifs?q=hello')

    expect(answered.status).toBe(200)
    const text = await answered.text()
    expect(text).not.toContain(KLIPY_TEST_KEY)
    // The key went to KLIPY, so a leak would be visible to this test.
    expect(klipyCalls()[0]?.url).toContain(KLIPY_TEST_KEY)
    // A GIF whose kept strings hold the key is dropped; an unknown field is never sent.
    expect((JSON.parse(text) as GifSearchResults).gifs.map((gif) => gif.id)).toEqual([
      'key-in-url',
      'echoed',
    ])
  })

  it("never sends the KLIPY key to the app when KLIPY refuses, and sends none of KLIPY's body", async () => {
    const churchId = await church()
    fakeKlipy({
      failWith: {
        status: 403,
        body: { result: false, errors: { message: [`The key ${KLIPY_TEST_KEY} is suspended.`] } },
      },
    })

    const answered = await asMember(churchId, 'ben', '/gifs?q=hello')

    expect(answered.status).toBe(502)
    const text = await answered.text()
    expect(text).not.toContain(KLIPY_TEST_KEY)
    expect(text).not.toContain('suspended')
    expect(klipyCalls()[0]?.url).toContain(KLIPY_TEST_KEY)
  })

  it('answers each GIF as its slug, title, a preview and a file to send, and the page', async () => {
    const churchId = await church()
    fakeKlipy({ pages: [[klipyItem('wave'), klipyItem('clap')], [klipyItem('cheer')]] })

    const answered = await asMember(churchId, 'ben', '/gifs?q=%20hello%20')

    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({
      gifs: [
        {
          id: 'wave',
          title: 'A wave GIF',
          preview: { url: 'https://static.klipy.com/ii/wave/sm.gif', width: 220, height: 220 },
          send: { url: 'https://static.klipy.com/ii/wave/md.gif', width: 498, height: 498 },
        },
        {
          id: 'clap',
          title: 'A clap GIF',
          preview: { url: 'https://static.klipy.com/ii/clap/sm.gif', width: 220, height: 220 },
          send: { url: 'https://static.klipy.com/ii/clap/md.gif', width: 498, height: 498 },
        },
      ],
      page: 1,
      hasNext: true,
    } satisfies GifSearchResults)
    const query = new URL(klipyCalls()[0]?.url ?? '').searchParams
    expect(query.get('q')).toBe('hello')
    expect(query.get('page')).toBe('1')
    expect(query.get('per_page')).toBe('24')
    expect(query.get('customer_id')).toMatch(/^[0-9a-f]{64}$/)
    expect(query.get('customer_id')).not.toContain('ben')
  })

  it('asks for the page the app asks for, and says when it is the last', async () => {
    const churchId = await church()
    fakeKlipy({ pages: [[klipyItem('wave')], [klipyItem('cheer')]] })

    const answered = await asMember(churchId, 'ben', '/gifs?q=hello&page=2')

    expect(await answered.json()).toMatchObject({
      gifs: [{ id: 'cheer' }],
      page: 2,
      hasNext: false,
    })
  })

  it('sends the smaller file when the larger one is past the image size limit', async () => {
    const churchId = await church()
    const big = klipyItem('big')
    const md = big.file.md?.gif
    if (md !== undefined) md.size = 10 * 1024 * 1024 + 1
    fakeKlipy({ pages: [[big]] })

    const answered = (await (
      await asMember(churchId, 'ben', '/gifs?q=hello')
    ).json()) as GifSearchResults

    expect(answered.gifs[0]?.send).toEqual({
      url: 'https://static.klipy.com/ii/big/sm.gif',
      width: 220,
      height: 220,
    })
  })

  it('drops a GIF with no file it can send, or a file not on https', async () => {
    const churchId = await church()
    const noGif = klipyItem('no-gif', { file: {} })
    const plain = klipyItem('plain-http')
    for (const tier of [plain.file.md, plain.file.sm]) {
      if (tier?.gif !== undefined) tier.gif.url = tier.gif.url.replace('https:', 'http:')
    }
    fakeKlipy({ pages: [[noGif, plain, klipyItem('wave')]] })

    const answered = (await (
      await asMember(churchId, 'ben', '/gifs?q=hello')
    ).json()) as GifSearchResults

    expect(answered.gifs.map((gif) => gif.id)).toEqual(['wave'])
  })

  it.each([
    ['answers something that is not a search', { status: 200, body: { result: true } }],
    ['answers result false', { status: 200, body: { result: false, data: null } }],
    ['fails', { status: 500, body: 'Internal error' }],
  ])('answers 502 when KLIPY %s', async (_label, failWith) => {
    const churchId = await church()
    fakeKlipy({ failWith })

    const answered = await asMember(churchId, 'ben', '/gifs?q=hello')

    expect(answered.status).toBe(502)
    expect(await answered.text()).toBe('GIF search is unavailable')
  })

  it('answers 502 when KLIPY cannot be reached', async () => {
    const churchId = await church()
    network.stubPath('GET', KLIPY_SEARCH, () => {
      throw new TypeError('Network connection lost')
    })

    const answered = await asMember(churchId, 'ben', '/gifs?q=hello')

    expect(answered.status).toBe(502)
  })

  it.each([
    ['no session', 401, '/gifs?q=hello', 'GET', 'none'],
    ['a person the church does not know', 404, '/gifs?q=hello', 'GET', 'stranger'],
    ['a POST', 405, '/gifs?q=hello', 'POST', 'ben'],
    ['no search text', 400, '/gifs', 'GET', 'ben'],
    ['only spaces', 400, '/gifs?q=%20%20', 'GET', 'ben'],
    ['search text past 100 characters', 400, `/gifs?q=${'a'.repeat(101)}`, 'GET', 'ben'],
    ['page 0', 400, '/gifs?q=hello&page=0', 'GET', 'ben'],
    ['page 51', 400, '/gifs?q=hello&page=51', 'GET', 'ben'],
    ['a page that is not a number', 400, '/gifs?q=hello&page=two', 'GET', 'ben'],
  ])('refuses %s with %i, and asks KLIPY nothing', async (_label, status, path, method, who) => {
    const churchId = await church()
    fakeKlipy({ pages: [[klipyItem('wave')]] })

    const answered =
      who === 'none'
        ? await exports.default.fetch(`https://phon.test${path}`, { method })
        : await asMember(churchId, who, path, { method })

    expect(answered.status).toBe(status)
    expect(klipyCalls()).toEqual([])
  })
})
