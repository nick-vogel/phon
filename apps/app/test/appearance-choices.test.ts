import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  APPEARANCE_CHOICES,
  appearanceAt,
  appearanceIndex,
  colorSchemeOverride,
  parseAppearanceChoice,
} from '../src/theme/appearance-choices.ts'

describe('the Appearance control in Settings', () => {
  it('shows System, Light and Dark, in that order', () => {
    assert.deepEqual(
      APPEARANCE_CHOICES.map((segment) => segment.label),
      ['System', 'Light', 'Dark'],
    )
  })

  it('selects the segment of each choice, and each segment picks its choice back', () => {
    for (const choice of ['system', 'light', 'dark'] as const) {
      assert.equal(appearanceAt(appearanceIndex(choice)), choice)
    }
    assert.equal(appearanceIndex('system'), 0)
    assert.equal(appearanceIndex('light'), 1)
    assert.equal(appearanceIndex('dark'), 2)
  })

  it('reads a segment outside the three as System', () => {
    assert.equal(appearanceAt(-1), 'system')
    assert.equal(appearanceAt(3), 'system')
    assert.equal(appearanceAt(Number.NaN), 'system')
  })
})

describe('the choice stored on the device', () => {
  it('keeps a stored Light or Dark', () => {
    assert.equal(parseAppearanceChoice('light'), 'light')
    assert.equal(parseAppearanceChoice('dark'), 'dark')
  })

  it('is System when nothing is stored, System is stored, or the value is unknown', () => {
    assert.equal(parseAppearanceChoice(null), 'system')
    assert.equal(parseAppearanceChoice('system'), 'system')
    assert.equal(parseAppearanceChoice('Dark'), 'system')
    assert.equal(parseAppearanceChoice(''), 'system')
  })
})

describe("the phone's interface style under each choice", () => {
  it('follows the phone again for System', () => {
    assert.equal(colorSchemeOverride('system'), 'auto')
  })

  it('is forced to Light or Dark when the member picks one', () => {
    assert.equal(colorSchemeOverride('light'), 'light')
    assert.equal(colorSchemeOverride('dark'), 'dark')
  })
})
