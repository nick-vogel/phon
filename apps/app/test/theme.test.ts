import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type BaseName, type ChurchTheme, DEFAULT_THEME, resolveTheme } from '../src/theme/theme.ts'
import { BANNER_COLOURS } from '../src/ui/banner-colours.ts'
import {
  GIF_PICKER_COLOURS,
  MENTION_LIST_COLOURS,
  ONE_TIME_SCREEN_COLOURS,
} from '../src/ui/screen-colours.ts'

const BASE_NAMES: BaseName[] = ['neutral', 'stone', 'zinc', 'mauve', 'olive', 'mist', 'taupe']

const COLOUR_TOKENS = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'popover',
  'popoverForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'muted',
  'mutedForeground',
  'accent',
  'accentForeground',
  'destructive',
  'border',
  'input',
  'ring',
  'primaryText',
  'mention',
] as const

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i

function onBase(base: BaseName): ChurchTheme {
  return { ...DEFAULT_THEME, base }
}

describe('resolving a church theme', () => {
  for (const base of BASE_NAMES) {
    it(`resolves the ${base} base in both modes to a full set of hex colours`, () => {
      const light = resolveTheme({ church: onBase(base), choice: 'light', scheme: 'light' })
      const dark = resolveTheme({ church: onBase(base), choice: 'dark', scheme: 'dark' })
      for (const resolved of [light, dark]) {
        for (const token of COLOUR_TOKENS) {
          assert.match(resolved.tokens[token], HEX, `${base} ${resolved.mode} ${token}`)
        }
      }
      assert.equal(light.mode, 'light')
      assert.equal(dark.mode, 'dark')
      assert.notEqual(light.tokens.background, dark.tokens.background)
      assert.notEqual(light.tokens.foreground, dark.tokens.foreground)
    })
  }

  it('carries the mist values shadcn v4 publishes, converted to hex', () => {
    const light = resolveTheme({ church: onBase('mist'), choice: 'light', scheme: null })
    const dark = resolveTheme({ church: onBase('mist'), choice: 'dark', scheme: null })
    assert.equal(light.tokens.background, '#ffffff')
    assert.equal(dark.tokens.background, '#090b0c')
  })
})

describe('choosing the mode', () => {
  const church = DEFAULT_THEME

  it('gives dark for a stored Dark on a light phone, and light for a stored Light on a dark one', () => {
    assert.equal(resolveTheme({ church, choice: 'dark', scheme: 'light' }).mode, 'dark')
    assert.equal(resolveTheme({ church, choice: 'light', scheme: 'dark' }).mode, 'light')
  })

  it('follows the phone under System', () => {
    assert.equal(resolveTheme({ church, choice: 'system', scheme: 'dark' }).mode, 'dark')
    assert.equal(resolveTheme({ church, choice: 'system', scheme: 'light' }).mode, 'light')
  })

  it('gives light under System when the phone names no scheme', () => {
    for (const scheme of [null, undefined, 'unspecified'] as const) {
      assert.equal(resolveTheme({ church, choice: 'system', scheme }).mode, 'light', String(scheme))
    }
  })
})

describe('the contrast of each pair', () => {
  function pair(
    resolved: ReturnType<typeof resolveTheme>,
    foreground: string,
    background: string,
  ): { ratio: number; passesAA: boolean } {
    const found = resolved.contrast.find(
      (entry) => entry.foreground === foreground && entry.background === background,
    )
    assert.ok(found, `${foreground} on ${background}`)
    return found
  }

  const light = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: 'light' })
  const dark = resolveTheme({ church: DEFAULT_THEME, choice: 'dark', scheme: 'dark' })

  it('passes the default theme text on the fill at 6.62:1', () => {
    for (const resolved of [light, dark]) {
      assert.deepEqual(pair(resolved, 'primaryForeground', 'primary'), {
        foreground: 'primaryForeground',
        background: 'primary',
        ratio: 6.62,
        passesAA: true,
      })
    }
  })

  it('passes the default theme accent text on the background in light and in dark', () => {
    assert.deepEqual(pair(light, 'primaryText', 'background'), {
      foreground: 'primaryText',
      background: 'background',
      ratio: 16.01,
      passesAA: true,
    })
    assert.deepEqual(pair(dark, 'primaryText', 'background'), {
      foreground: 'primaryText',
      background: 'background',
      ratio: 8.15,
      passesAA: true,
    })
  })

  it("passes the text of other people's bubbles on the muted surface in both modes", () => {
    assert.equal(pair(light, 'foreground', 'muted').passesAA, true)
    assert.equal(pair(dark, 'foreground', 'muted').passesAA, true)
  })

  it('passes the text over the mention tint in both modes', () => {
    assert.equal(pair(light, 'foreground', 'mention').passesAA, true)
    assert.equal(pair(dark, 'foreground', 'mention').passesAA, true)
  })

  it('passes every text and glyph colour the one-time screens, the GIF picker and the mention list draw, in both modes', () => {
    for (const resolved of [light, dark]) {
      for (const [screen, { surface, ...drawn }] of [
        ['one-time screen', ONE_TIME_SCREEN_COLOURS],
        ['GIF picker', GIF_PICKER_COLOURS],
        ['mention list', MENTION_LIST_COLOURS],
      ] as const) {
        for (const [part, foreground] of Object.entries(drawn)) {
          assert.equal(
            pair(resolved, foreground, surface).passesAA,
            true,
            `${resolved.mode} ${screen} ${part}: ${foreground} on ${surface}`,
          )
        }
      }
    }
  })

  it("passes the drop notice banner's text, icon and Reconnect label in both modes", () => {
    for (const resolved of [light, dark]) {
      for (const [part, foreground, background] of [
        ['text', BANNER_COLOURS.text, BANNER_COLOURS.surface],
        ['icon', BANNER_COLOURS.icon, BANNER_COLOURS.surface],
        ['Reconnect', BANNER_COLOURS.actionLabel, BANNER_COLOURS.action],
      ] as const) {
        assert.equal(
          pair(resolved, foreground, background).passesAA,
          true,
          `${resolved.mode} ${part}`,
        )
      }
    }
  })

  it('reports white on #55b3c9 as failing, at 2.42:1', () => {
    const church: ChurchTheme = {
      ...DEFAULT_THEME,
      accent: { ...DEFAULT_THEME.accent, onFill: '#ffffff' },
    }
    const resolved = resolveTheme({ church, choice: 'light', scheme: 'light' })
    assert.deepEqual(pair(resolved, 'primaryForeground', 'primary'), {
      foreground: 'primaryForeground',
      background: 'primary',
      ratio: 2.42,
      passesAA: false,
    })
  })

  it('reports a pair that fails rather than hiding it: mist light muted text on the muted surface', () => {
    assert.deepEqual(pair(light, 'mutedForeground', 'muted'), {
      foreground: 'mutedForeground',
      background: 'muted',
      ratio: 4.14,
      passesAA: false,
    })
  })

  it('reports every pair the module defines, for the mode it resolved', () => {
    const names = light.contrast.map((entry) => `${entry.foreground}/${entry.background}`)
    assert.deepEqual(names, [
      'foreground/background',
      'foreground/muted',
      'cardForeground/card',
      'popoverForeground/popover',
      'primaryForeground/primary',
      'secondaryForeground/secondary',
      'mutedForeground/muted',
      'mutedForeground/background',
      'mutedForeground/card',
      'accentForeground/accent',
      'destructive/background',
      'destructive/card',
      'primaryText/background',
      'primaryText/card',
      'foreground/mention',
    ])
  })
})

describe('the scale tokens', () => {
  it('holds the radius, the tap target and the iOS body size in both modes', () => {
    for (const choice of ['light', 'dark'] as const) {
      const { tokens } = resolveTheme({ church: DEFAULT_THEME, choice, scheme: null })
      assert.equal(tokens.radius, 10)
      assert.equal(tokens.minTapTarget, 44)
      assert.equal(tokens.type.body, 17)
      assert.equal(tokens.spacing.lg, 16)
    }
  })

  it('scales icon sizes with the font scale, and nothing else', () => {
    const base = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    const large = resolveTheme({
      church: DEFAULT_THEME,
      choice: 'light',
      scheme: null,
      fontScale: 2,
    })
    assert.deepEqual(base.tokens.iconSize, { sm: 16, md: 20, lg: 24 })
    assert.deepEqual(large.tokens.iconSize, { sm: 32, md: 40, lg: 48 })
    assert.deepEqual(large.tokens.type, base.tokens.type)
    assert.deepEqual(large.tokens.spacing, base.tokens.spacing)
  })

  it('rounds a scaled icon size to a whole point', () => {
    const { tokens } = resolveTheme({
      church: DEFAULT_THEME,
      choice: 'light',
      scheme: null,
      fontScale: 1.15,
    })
    assert.deepEqual(tokens.iconSize, { sm: 18, md: 23, lg: 28 })
  })
})

describe('the chat library theme', () => {
  it('carries the light and dark accent fill as the outgoing bubble, whichever mode resolved', () => {
    const light = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    const dark = resolveTheme({ church: DEFAULT_THEME, choice: 'dark', scheme: null })
    for (const resolved of [light, dark]) {
      assert.equal(resolved.chat.theme.colors?.outgoingBubble, light.tokens.primary)
      assert.equal(resolved.chat.darkTheme.colors?.outgoingBubble, dark.tokens.primary)
      assert.equal(resolved.chat.theme.colors?.outgoingText, '#07252d')
    }
  })

  it('maps each mode to its own base surfaces', () => {
    const { chat } = resolveTheme({ church: DEFAULT_THEME, choice: 'system', scheme: 'light' })
    assert.equal(chat.theme.colors?.background, '#ffffff')
    assert.equal(chat.darkTheme.colors?.background, '#090b0c')
  })

  it('turns off the wallpaper and the dark outgoing gradient, which would hide those colours', () => {
    const { chat } = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    for (const theme of [chat.theme, chat.darkTheme]) {
      assert.equal(theme.wallpaper?.isEnabled, false)
      assert.equal(theme.bubble?.outgoingGradient, null)
    }
  })

  it('draws flat bubbles with every corner at 10 pt and no tail, in both modes', () => {
    const { chat } = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    for (const theme of [chat.theme, chat.darkTheme]) {
      assert.equal(theme.radii?.bubble, 10)
      assert.equal(theme.radii?.bubbleGrouped, 10)
      assert.equal(theme.bubble?.hasTail, false)
      assert.equal(theme.colors?.incomingBubbleShadow, 'transparent')
      assert.equal(theme.colors?.outgoingBubbleShadow, 'transparent')
    }
  })

  it('rounds a photo 2 pt inside the 10 pt bubble, in both modes', () => {
    const { chat } = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    for (const theme of [chat.theme, chat.darkTheme]) {
      assert.equal(theme.radii?.media, 8)
    }
  })

  it("draws the day separators from each mode's tokens", () => {
    const light = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    const dark = resolveTheme({ church: DEFAULT_THEME, choice: 'dark', scheme: null })
    assert.equal(light.chat.theme.colors?.dayPillBackground, light.tokens.background)
    assert.equal(light.chat.darkTheme.colors?.dayPillBackground, dark.tokens.background)
    assert.equal(light.chat.theme.colors?.dayPillText, light.tokens.mutedForeground)
    assert.equal(light.chat.darkTheme.colors?.dayPillText, dark.tokens.mutedForeground)
    for (const theme of [light.chat.theme, light.chat.darkTheme]) {
      assert.equal(theme.typography?.day?.fontSize, 13)
    }
  })

  it("draws the composer's field, cursor, glyphs and send glyph from each mode's tokens", () => {
    const light = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    const dark = resolveTheme({ church: DEFAULT_THEME, choice: 'dark', scheme: null })
    for (const [theme, tokens] of [
      [light.chat.theme, light.tokens],
      [light.chat.darkTheme, dark.tokens],
    ] as const) {
      assert.equal(theme.colors?.onAccent, tokens.primaryForeground)
      assert.equal(theme.colors?.composerIcon, tokens.mutedForeground)
      assert.equal(theme.colors?.inputCursor, tokens.primary)
      assert.equal(theme.colors?.inputFieldBorder, tokens.border)
      assert.equal(theme.colors?.inputBackground, tokens.card)
      assert.equal(theme.colors?.inputText, tokens.foreground)
      assert.equal(theme.colors?.placeholder, tokens.mutedForeground)
    }
    // The send glyph on the fill and the placeholder on the field both read at AA.
    for (const resolved of [light, dark]) {
      for (const [foreground, background] of [
        ['primaryForeground', 'primary'],
        ['mutedForeground', 'card'],
      ]) {
        const found = resolved.contrast.find(
          (entry) => entry.foreground === foreground && entry.background === background,
        )
        assert.equal(found?.passesAA, true, `${resolved.mode} ${foreground} on ${background}`)
      }
    }
  })

  it('sets the composer text at the iOS body size, 17 on a 22 pt line, in a 44 pt field', () => {
    const { chat } = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    for (const theme of [chat.theme, chat.darkTheme]) {
      assert.equal(theme.typography?.composer?.fontSize, 17)
      assert.equal(theme.typography?.composer?.lineHeight, 22)
      assert.equal(theme.composer?.minHeight, 44)
      assert.equal(theme.composer?.insetIconSize, 24)
    }
  })

  it('grows the composer to six lines at the default text size', () => {
    const { chat } = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null })
    for (const theme of [chat.theme, chat.darkTheme]) {
      // 11 pt above and below one 22 pt line, then six lines of 22.
      assert.equal(theme.composer?.maxHeight, 154)
    }
  })

  it('holds two whole lines at the largest accessibility text size', () => {
    const { chat } = resolveTheme({
      church: DEFAULT_THEME,
      choice: 'light',
      scheme: null,
      fontScale: 3.1,
    })
    for (const theme of [chat.theme, chat.darkTheme]) {
      // 22 pt of padding, then two lines of 22 * 3.1, rounded up to 69.
      assert.equal(theme.composer?.maxHeight, 160)
      assert.equal(theme.composer?.minHeight, 44)
    }
  })

  it('never cuts the second line of the composer, at any text size', () => {
    for (let step = 0; step <= 25; step += 1) {
      const fontScale = 1 + step / 10
      const { chat } = resolveTheme({
        church: DEFAULT_THEME,
        choice: 'light',
        scheme: null,
        fontScale,
      })
      const maxHeight = chat.theme.composer?.maxHeight ?? 0
      assert.ok(maxHeight >= 22 + 2 * Math.ceil(22 * fontScale), `at font scale ${fontScale}`)
    }
  })
})
