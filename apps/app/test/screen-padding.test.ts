import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { headerlessPadding } from '../src/ui/screen-padding.ts'

// A headerless screen draws from the very top of the phone to the very bottom, so it has to keep
// its scrolling content out of the status bar and the home indicator itself. Whether the sign-in
// screen then reads clear at AX5 is for the Simulator walk; a Node test cannot see it.
describe('the padding of a headerless screen', () => {
  const base = 24
  const phones = [
    { top: 59, bottom: 34 },
    { top: 47, bottom: 34 },
    { top: 24, bottom: 48 },
  ]

  it('starts the scroll view below the status bar, so nothing scrolls under it', () => {
    for (const insets of phones) {
      const { frame, content } = headerlessPadding(base, insets)
      assert.equal(frame.paddingTop, insets.top, JSON.stringify(insets))
      assert.equal(content.paddingTop, base, JSON.stringify(insets))
    }
  })

  it('ends the content clear of the home indicator by the base padding', () => {
    for (const insets of phones) {
      const { content } = headerlessPadding(base, insets)
      assert.equal(content.paddingBottom, insets.bottom + base, JSON.stringify(insets))
      assert.equal(content.paddingHorizontal, base, JSON.stringify(insets))
    }
  })

  it('is the base padding on every side on a phone with no insets', () => {
    assert.deepEqual(headerlessPadding(base, { top: 0, bottom: 0 }), {
      frame: { paddingTop: 0 },
      content: { paddingTop: base, paddingBottom: base, paddingHorizontal: base },
    })
  })
})
