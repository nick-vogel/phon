import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_THEME, type ResolvedTheme, resolveTheme } from '../src/theme/theme.ts'
import { BUTTON_COLOURS, type ButtonVariant, FIELD_COLOURS } from '../src/ui/control-colours.ts'

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'plain']

/** WCAG 1.4.11: the edge that shows where a field is needs 3:1 against what is around it. */
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

  describe(`the shared controls in ${choice} mode`, () => {
    for (const variant of VARIANTS) {
      it(`draws the ${variant} button's label at AA on its surface`, () => {
        const { label, surface } = BUTTON_COLOURS[variant]
        const entry = pair(theme, label, surface)
        assert.ok(entry.passesAA, `${label} on ${surface} is ${entry.ratio}:1`)
      })
    }

    it("draws the field's text and placeholder at AA on its surface", () => {
      for (const foreground of [FIELD_COLOURS.text, FIELD_COLOURS.placeholder]) {
        const entry = pair(theme, foreground, FIELD_COLOURS.surface)
        assert.ok(entry.passesAA, `${foreground} on ${FIELD_COLOURS.surface} is ${entry.ratio}:1`)
      }
    })

    it("draws the field's edge at 3:1 or more on its surface", () => {
      const entry = pair(theme, FIELD_COLOURS.border, FIELD_COLOURS.surface)
      assert.ok(entry.ratio >= NON_TEXT, `the field's edge is ${entry.ratio}:1`)
    })
  })
}

describe('the button variants', () => {
  it('fill the one strong action with the accent, a choice with the secondary surface, and leave a text action unfilled', () => {
    assert.deepEqual(BUTTON_COLOURS, {
      primary: { surface: 'primary', label: 'primaryForeground' },
      secondary: { surface: 'secondary', label: 'secondaryForeground' },
      plain: { surface: 'background', label: 'primaryText' },
    })
  })
})
