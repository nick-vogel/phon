import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_THEME, type ResolvedTheme, resolveTheme } from '../src/theme/theme.ts'
import {
  CHANNEL_BADGE_COLOURS,
  LIST_ROW_COLOURS,
  SECTION_COLOURS,
} from '../src/ui/list-row-colours.ts'

/** WCAG 1.4.11: a mark or glyph that carries meaning needs 3:1 against what is around it. */
const NON_TEXT = 3

/** The contrast report's entry for one pair, failing when the theme module does not check it. */
function pair(theme: ResolvedTheme, foreground: string, background: string) {
  const found = theme.contrast.find(
    (entry) => entry.foreground === foreground && entry.background === background,
  )
  assert.ok(found, `${foreground} on ${background} is not in the ${theme.mode} contrast report`)
  return found
}

for (const choice of ['light', 'dark'] as const) {
  const theme = resolveTheme({ church: DEFAULT_THEME, choice, scheme: null })

  describe(`the list rows in ${choice} mode`, () => {
    for (const part of [
      'title',
      'subtitle',
      'value',
      'action',
      'destructive',
      'mutedTitle',
    ] as const) {
      it(`draws a row's ${part} at AA on the row`, () => {
        const entry = pair(theme, LIST_ROW_COLOURS[part], LIST_ROW_COLOURS.surface)
        assert.ok(entry.passesAA, `${LIST_ROW_COLOURS[part]} on card is ${entry.ratio}:1`)
      })
    }

    it("draws a pressed row's second line, value and muted title at AA on the pressed surface", () => {
      const entry = pair(theme, LIST_ROW_COLOURS.pressedText, LIST_ROW_COLOURS.pressed)
      assert.ok(entry.passesAA, `${LIST_ROW_COLOURS.pressedText} on accent is ${entry.ratio}:1`)
    })

    it("draws a channel's mention count at AA on its badge", () => {
      const entry = pair(theme, CHANNEL_BADGE_COLOURS.text, CHANNEL_BADGE_COLOURS.fill)
      assert.ok(entry.passesAA, `${CHANNEL_BADGE_COLOURS.text} on its fill is ${entry.ratio}:1`)
    })

    for (const part of ['mark', 'glyph'] as const) {
      it(`draws a row's ${part} at 3:1 or more on the row`, () => {
        const entry = pair(theme, LIST_ROW_COLOURS[part], LIST_ROW_COLOURS.surface)
        assert.ok(entry.ratio >= NON_TEXT, `${LIST_ROW_COLOURS[part]} on card is ${entry.ratio}:1`)
      })
    }

    for (const part of ['header', 'note', 'error'] as const) {
      it(`draws a group's ${part} line at AA on the page`, () => {
        const entry = pair(theme, SECTION_COLOURS[part], SECTION_COLOURS.surface)
        assert.ok(entry.passesAA, `${SECTION_COLOURS[part]} on the page is ${entry.ratio}:1`)
      })
    }
  })
}

describe('the list row colours', () => {
  it('draw a row on the card, its text in the card text, second lines, values and glyphs muted, actions and marks in the accent', () => {
    assert.deepEqual(LIST_ROW_COLOURS, {
      surface: 'card',
      title: 'cardForeground',
      subtitle: 'mutedForeground',
      value: 'mutedForeground',
      action: 'primaryText',
      destructive: 'destructive',
      mark: 'primaryText',
      glyph: 'mutedForeground',
      edge: 'border',
      pressed: 'accent',
      mutedTitle: 'mutedForeground',
      pressedText: 'accentForeground',
    })
  })

  it("draw a channel's mention badge in the accent, its count in the accent's text", () => {
    assert.deepEqual(CHANNEL_BADGE_COLOURS, { fill: 'primary', text: 'primaryForeground' })
  })

  it("draw a group's header and notes muted on the page, and its failure line in the destructive colour", () => {
    assert.deepEqual(SECTION_COLOURS, {
      surface: 'background',
      header: 'mutedForeground',
      note: 'mutedForeground',
      error: 'destructive',
    })
  })
})
