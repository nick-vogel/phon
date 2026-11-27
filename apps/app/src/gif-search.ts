import type { Gif, GifSearchResults } from '@phon/api-types'

/**
 * The GIF picker's search field placeholder. KLIPY requires it as attribution
 * (docs.klipy.com/attribution), so it is never translated or reworded.
 */
export const GIF_SEARCH_PLACEHOLDER = 'Search KLIPY'

/** The GIFs shown once a later page arrives: that page after them, each GIF once, by `id`. */
export function appendPage(shown: readonly Gif[], results: GifSearchResults): Gif[] {
  const ids = new Set(shown.map((gif) => gif.id))
  const added = results.gifs.filter((gif) => {
    if (ids.has(gif.id)) return false
    ids.add(gif.id)
    return true
  })
  return [...shown, ...added]
}
