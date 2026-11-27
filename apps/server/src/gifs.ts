import type { Gif, GifRendition, GifSearchResults } from '@phon/api-types'
import type { Identity } from './identity.ts'
import { MAX_IMAGE_BYTES } from './images.ts'

/**
 * GIF search, proxied through KLIPY (phon#15) so the KLIPY key never leaves the Worker.
 *
 * `GET /gifs?q=<text>&page=<n>` answers one page of G-rated GIFs to any current person of the
 * caller's church. The server builds KLIPY's request itself from fixed parameters, `content_filter`
 * `high` (G only) among them, and passes nothing of the app's query through but the search text and
 * the page. Its answer is built only from allow-listed fields of KLIPY's, so nothing KLIPY adds,
 * and no string carrying the key, reaches the app. A picked GIF is posted through
 * `POST /channels/:channelId/images` like any image, so the post gate decides there.
 */

/** KLIPY's API host (docs.klipy.com). */
const KLIPY_API = 'https://api.klipy.com/api/v1'

/** The longest search text Phon sends, once trimmed. */
const MAX_QUERY = 100
/** The last page Phon asks KLIPY for. */
const MAX_PAGE = 50
/** GIFs a page. */
const PER_PAGE = 24

const PAGE = /^[1-9]\d*$/

/** Answers `GET /gifs` for an authenticated caller. */
export async function searchGifs(
  request: Request,
  env: Env,
  identity: Identity,
): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
  if (!(await env.CHURCH_DIRECTORY.getByName(identity.churchId).knows(identity))) {
    return new Response('Not found', { status: 404 })
  }

  const asked = new URL(request.url).searchParams
  const q = (asked.get('q') ?? '').trim()
  const pageText = asked.get('page')
  if (q.length === 0 || q.length > MAX_QUERY) return badRequest()
  if (pageText !== null && (!PAGE.test(pageText) || Number(pageText) > MAX_PAGE)) {
    return badRequest()
  }
  const page = pageText === null ? 1 : Number(pageText)

  const key = env.KLIPY_API_KEY
  const search = new URL(`${KLIPY_API}/${encodeURIComponent(key)}/gifs/search`)
  search.searchParams.set('q', q)
  search.searchParams.set('page', String(page))
  search.searchParams.set('per_page', String(PER_PAGE))
  search.searchParams.set('content_filter', 'high')
  search.searchParams.set('format_filter', 'gif')
  search.searchParams.set('customer_id', await customerId(identity))

  let body: unknown
  try {
    const response = await fetch(search, { headers: { accept: 'application/json' } })
    if (response.status !== 200) return unavailable()
    body = await response.json()
  } catch {
    return unavailable()
  }
  const results = readResults(body, key)
  return results === null ? unavailable() : Response.json(results satisfies GifSearchResults)
}

/**
 * The stable, anonymous ID KLIPY asks for: the hex SHA-256 of `<churchId>:<personId>`, so KLIPY
 * gets no name, no email and no Planning Center ID.
 */
async function customerId(identity: Identity): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${identity.churchId}:${identity.personId}`),
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Phon's answer from KLIPY's, or null when KLIPY's is not the documented shape. */
function readResults(body: unknown, key: string): GifSearchResults | null {
  if (!isObject(body) || body.result !== true || !isObject(body.data)) return null
  const { data: items, current_page: page, has_next: hasNext } = body.data
  if (!Array.isArray(items) || typeof page !== 'number' || typeof hasNext !== 'boolean') {
    return null
  }
  const gifs = items.flatMap((item) => {
    const gif = readGif(item, key)
    return gif === null ? [] : [gif]
  })
  return { gifs, page, hasNext }
}

/** One GIF from one KLIPY item, or null when it has no usable file or a kept string holds the key. */
function readGif(item: unknown, key: string): Gif | null {
  if (!isObject(item) || typeof item.slug !== 'string' || !isObject(item.file)) return null
  const title = typeof item.title === 'string' ? item.title : ''
  const preview = rendition(item.file, 'sm', key) ?? rendition(item.file, 'xs', key)
  const send = ['md', 'sm']
    .map((tier) => rendition(item.file as Record<string, unknown>, tier, key))
    .filter((file): file is Sized => file !== null && file.size <= MAX_IMAGE_BYTES)
    .sort((a, b) => b.size - a.size)[0]
  if (preview === null || send === undefined) return null
  if (item.slug.length === 0 || [item.slug, title].some((text) => text.includes(key))) return null
  return { id: item.slug, title, preview: shown(preview), send: shown(send) }
}

interface Sized extends GifRendition {
  size: number
}

/** A tier's GIF file, when it is a whole `https://` file that does not carry the key. */
function rendition(file: Record<string, unknown>, tier: string, key: string): Sized | null {
  const formats = file[tier]
  if (!isObject(formats) || !isObject(formats.gif)) return null
  const { url, width, height, size } = formats.gif
  if (typeof url !== 'string' || url.includes(key) || !isHttps(url)) return null
  if (![width, height, size].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
    return null
  }
  return { url, width: width as number, height: height as number, size: size as number }
}

/** Only the fields the app is sent. */
function shown({ url, width, height }: Sized): GifRendition {
  return { url, width, height }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badRequest(): Response {
  return new Response('Bad request', { status: 400 })
}

/** KLIPY failed or answered something unexpected. Phon's own body, never KLIPY's. */
function unavailable(): Response {
  return new Response('GIF search is unavailable', { status: 502 })
}
