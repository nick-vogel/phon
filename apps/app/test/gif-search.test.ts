import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Gif } from '@phon/api-types'
import { appendPage, GIF_SEARCH_PLACEHOLDER } from '../src/gif-search.ts'

function gif(id: string): Gif {
  const file = { url: `https://static.klipy.com/ii/${id}/sm.gif`, width: 220, height: 220 }
  return { id, title: id, preview: file, send: file }
}

describe('the GIF picker', () => {
  it('shows "Search KLIPY" in its search field, the attribution KLIPY requires', () => {
    assert.equal(GIF_SEARCH_PLACEHOLDER, 'Search KLIPY')
  })

  it('adds a later page after the GIFs already shown', () => {
    const shown = [gif('wave'), gif('clap')]

    const merged = appendPage(shown, { gifs: [gif('cheer')], page: 2, hasNext: false })

    assert.deepEqual(
      merged.map((shownGif) => shownGif.id),
      ['wave', 'clap', 'cheer'],
    )
  })

  it('shows a GIF once when a later page answers it again', () => {
    const shown = [gif('wave'), gif('clap')]

    const merged = appendPage(shown, { gifs: [gif('clap'), gif('cheer')], page: 2, hasNext: true })

    assert.deepEqual(
      merged.map((shownGif) => shownGif.id),
      ['wave', 'clap', 'cheer'],
    )
  })
})
