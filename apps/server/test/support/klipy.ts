import { network } from './network.ts'

/** The KLIPY API key vitest.config.ts binds as `KLIPY_API_KEY`. */
export const KLIPY_TEST_KEY = 'phon-test-klipy-key'

/**
 * KLIPY's GIF search endpoint as KLIPY documents it (docs.klipy.com/gifs-api/gifs-search-api.md),
 * the app key a path segment, for the test key. Written out rather than imported from `src/`, so a
 * wrong production URL leaves the search unstubbed and fails the test.
 */
export const KLIPY_SEARCH = `https://api.klipy.com/api/v1/${KLIPY_TEST_KEY}/gifs/search`

/** One file of an item, as KLIPY answers it. */
export interface KlipyFile {
  url: string
  width: number
  height: number
  size: number
}

type Formats = Record<'gif' | 'webp' | 'jpg' | 'mp4' | 'webm', KlipyFile>

/** One search result, as KLIPY answers it. Extra keys stand for fields Phon does not know. */
export interface KlipyItem {
  id: number
  slug: string
  title: string
  type: 'gif'
  tags: string[]
  blur_preview: string
  file: Partial<Record<'hd' | 'md' | 'sm' | 'xs', Partial<Formats>>>
  [unknown: string]: unknown
}

const TIERS = { hd: 640, md: 498, sm: 220, xs: 90 } as const

let nextId = 1

/** A KLIPY item with all four tiers in all five formats, each on `static.klipy.com`. */
export function klipyItem(slug: string, overrides: Partial<KlipyItem> = {}): KlipyItem {
  const file: KlipyItem['file'] = {}
  for (const [tier, side] of Object.entries(TIERS)) {
    const formats: Partial<Formats> = {}
    for (const format of ['gif', 'webp', 'jpg', 'mp4', 'webm'] as const) {
      formats[format] = {
        url: `https://static.klipy.com/ii/${slug}/${tier}.${format}`,
        width: side,
        height: side,
        size: side * 1000,
      }
    }
    file[tier as keyof typeof TIERS] = formats
  }
  return {
    id: nextId++,
    slug,
    title: `A ${slug} GIF`,
    type: 'gif',
    tags: [slug],
    blur_preview: 'data:image/jpeg;base64,AAAA',
    file,
    ...overrides,
  }
}

export interface FakeKlipyOptions {
  /** The items of each page, page 1 first. Default one empty page. */
  pages?: KlipyItem[][]
  /** Answers every search with this status and body instead, as KLIPY does an error. */
  failWith?: { status: number; body: unknown }
}

/**
 * A fake KLIPY GIF search over the network recorder. It stubs `GET KLIPY_SEARCH` whatever its
 * query, answers KLIPY's documented shape with the page the query asks for, and records each call's
 * query.
 */
export function fakeKlipy(options: FakeKlipyOptions = {}) {
  const pages = options.pages ?? [[]]
  const queries: URLSearchParams[] = []

  network.stubPath('GET', KLIPY_SEARCH, (request) => {
    const query = new URL(request.url).searchParams
    queries.push(query)
    if (options.failWith !== undefined) {
      return Response.json(options.failWith.body, { status: options.failWith.status })
    }
    const page = Number(query.get('page') ?? '1')
    const perPage = Number(query.get('per_page') ?? '24')
    return Response.json({
      result: true,
      data: {
        data: pages[page - 1] ?? [],
        current_page: page,
        per_page: perPage,
        has_next: page < pages.length,
      },
    })
  })

  return {
    /** The query of each search KLIPY received, in order. */
    queries(): URLSearchParams[] {
      return [...queries]
    },
  }
}

/** Every call the network recorder saw to KLIPY's host, from any route. */
export function klipyCalls() {
  return network.calls().filter((call) => new URL(call.url).hostname === 'api.klipy.com')
}
