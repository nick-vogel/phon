import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { headerOptions, navigationColours } from '../src/theme/header-options.ts'
import { DEFAULT_THEME, resolveTheme } from '../src/theme/theme.ts'

// What the native header and the stack draw from these values (the glass, its glyphs, the colour
// behind a screen in a swipe back) shows only on a device. docs/design/after/channels-dark.png
// and the 2026-11-25 Simulator checks B and C are the records these rules came from (#322).
const themeFor = (mode: 'light' | 'dark', fontScale = 1) =>
  resolveTheme({ church: DEFAULT_THEME, choice: mode, scheme: 'light', fontScale })

describe('the stack header options', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`give the native header the ${mode} style when the app resolves to ${mode}`, () => {
      assert.equal(headerOptions(mode, themeFor(mode).tokens).headerUserInterfaceStyle, mode)
    })
  }
})

describe('the navigation colours', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`put the ${mode} page background behind every screen of the stack`, () => {
      const { tokens } = themeFor(mode)
      assert.equal(navigationColours(tokens).background, tokens.background)
    })
  }
})

describe('the header glyph size', () => {
  it('stays at 24 pt at the largest text size, since the navigation bar does not grow', () => {
    assert.equal(themeFor('light', 1).tokens.headerIconSize, 24)
    assert.equal(themeFor('light', 3.12).tokens.headerIconSize, 24)
  })
})
