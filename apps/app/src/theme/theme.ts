import type { PartialChatTheme } from '@kesha-antonov/react-native-chat'
import { BASES, type BaseColours, type BaseName } from './bases.ts'

export type { BaseName }

/**
 * The theme module: every colour in the app comes from here. A church theme is one of shadcn's
 * seven bases plus an accent, and `resolveTheme` turns it, the appearance choice and the phone's
 * scheme into the tokens a screen reads.
 */

/** A church's look: a shadcn base and one accent colour. */
export interface ChurchTheme {
  base: BaseName
  accent: {
    /** The accent as a surface: buttons, the person's own bubbles. */
    fill: string
    /** Text and icons on the fill. */
    onFill: string
    /** The accent as text on the background, per mode. */
    text: { light: string; dark: string }
  }
}

/** What the member picked in Settings. System follows the phone. */
export type AppearanceChoice = 'system' | 'light' | 'dark'

/** The phone's scheme, as React Native 0.88's `ColorSchemeName` reports it. */
export type PhoneScheme = 'light' | 'dark' | 'unspecified' | null | undefined

export type Mode = 'light' | 'dark'

/**
 * The built-in default: the mist base and a teal accent, with the deep teal for text on it. White
 * never sits on the fill:
 * `#ffffff` on `#55b3c9` is 2.42:1, under WCAG AA.
 */
export const DEFAULT_THEME: ChurchTheme = {
  base: 'mist',
  accent: {
    fill: '#55b3c9',
    onFill: '#07252d',
    text: { light: '#07252d', dark: '#55b3c9' },
  },
}

/** The bubble tint of a message that @mentions the reader (phon#106). */
const MENTION: Record<Mode, string> = { light: '#FFF1C2', dark: '#4A3D12' }

export interface ColourTokens extends BaseColours {
  /** The accent as text on the background. */
  primaryText: string
  /** The tint behind a message that @mentions the reader. */
  mention: string
}

/**
 * The sizes, the same in both modes. Type sizes are the iOS text styles, since the typeface is the
 * system font; React Native's `Text` already follows Dynamic Type, so they do not scale here.
 */
const SCALE = {
  /** The corner radius, in points. */
  radius: 10,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  type: {
    caption2: 11,
    caption1: 12,
    footnote: 13,
    subheadline: 15,
    callout: 16,
    body: 17,
    headline: 17,
    title3: 20,
    title2: 22,
    title1: 28,
    largeTitle: 34,
  },
  /** The smallest a control may be to tap, in points. */
  minTapTarget: 44,
} as const

/** The composer's line height at the body size, the iOS body style's 22 pt. */
const COMPOSER_LINE = 22

/** Icon sizes before the phone's font scale. */
const ICON_SIZE = { sm: 16, md: 20, lg: 24 } as const

export type ThemeTokens = ColourTokens &
  typeof SCALE & { iconSize: Record<keyof typeof ICON_SIZE, number>; headerIconSize: number }

/** How well one foreground reads on one background, for the mode resolved. */
export interface ContrastPair {
  foreground: keyof ColourTokens
  background: keyof ColourTokens
  /** The WCAG 2 contrast ratio, rounded to two decimals. */
  ratio: number
  /** At least 4.5:1, WCAG AA for body text. */
  passesAA: boolean
}

export interface ResolvedTheme {
  mode: Mode
  tokens: ThemeTokens
  /** The chat library's `theme` and `darkTheme` props, both built whichever mode resolved. */
  chat: { theme: PartialChatTheme; darkTheme: PartialChatTheme }
  contrast: ContrastPair[]
}

/**
 * The foreground and background pairs the module defines: shadcn's `*Foreground` tokens on their
 * surfaces, muted text on the plain surfaces too, and the accent and mention colours. Borders,
 * inputs and rings are not text, so they are not here.
 */
const PAIRS: [keyof ColourTokens, keyof ColourTokens][] = [
  ['foreground', 'background'],
  ['foreground', 'muted'],
  ['cardForeground', 'card'],
  ['popoverForeground', 'popover'],
  ['primaryForeground', 'primary'],
  ['secondaryForeground', 'secondary'],
  ['mutedForeground', 'muted'],
  ['mutedForeground', 'background'],
  ['mutedForeground', 'card'],
  ['accentForeground', 'accent'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['primaryText', 'background'],
  ['primaryText', 'card'],
  ['foreground', 'mention'],
]

const AA = 4.5

export interface ResolveThemeInput {
  church: ChurchTheme
  choice: AppearanceChoice
  scheme: PhoneScheme
  /** The phone's font scale, which icon sizes and the composer's maximum height follow. */
  fontScale?: number
}

/** Resolves a church theme for the member's choice and the phone's scheme. */
export function resolveTheme({
  church,
  choice,
  scheme,
  fontScale = 1,
}: ResolveThemeInput): ResolvedTheme {
  const mode = modeFor(choice, scheme)
  const colour = colours(church, mode)
  const iconSize = {
    sm: Math.round(ICON_SIZE.sm * fontScale),
    md: Math.round(ICON_SIZE.md * fontScale),
    lg: Math.round(ICON_SIZE.lg * fontScale),
  }
  const contrast = PAIRS.map(([foreground, background]) => {
    const ratio = Math.round(contrastRatio(colour[foreground], colour[background]) * 100) / 100
    return { foreground, background, ratio, passesAA: ratio >= AA }
  })
  return {
    mode,
    // The header's glyphs stay at their size, as the composer's do: the navigation bar does not
    // grow with Dynamic Type, so a scaled glyph spilled over the status bar (Simulator, AX5, #322).
    tokens: { ...colour, ...SCALE, iconSize, headerIconSize: ICON_SIZE.lg },
    chat: {
      theme: chatTheme(colours(church, 'light'), fontScale),
      darkTheme: chatTheme(colours(church, 'dark'), fontScale),
    },
    contrast,
  }
}

/**
 * A stored Light or Dark beats the phone. System follows the phone, and a phone that names no
 * scheme (`null` or `unspecified`) gets the light look, as the chat library does.
 */
function modeFor(choice: AppearanceChoice, scheme: PhoneScheme): Mode {
  if (choice !== 'system') return choice
  return scheme === 'dark' ? 'dark' : 'light'
}

function colours(church: ChurchTheme, mode: Mode): ColourTokens {
  return {
    ...BASES[church.base][mode],
    primary: church.accent.fill,
    primaryForeground: church.accent.onFill,
    primaryText: church.accent.text[mode],
    mention: MENTION[mode],
  }
}

/**
 * The chat library's colours and bubble shape from the tokens. Bubbles are flat: every corner is
 * the radius, a grouped one included, with no tail and no shadow. Day separators sit on the
 * background in muted text. The wallpaper and the outgoing gradient are turned off, since the
 * library draws them over `background` and `outgoingBubble`, and the colours would not show.
 *
 * The composer is one field on the card surface with a hairline border and the accent cursor, its
 * attach and GIF glyphs in muted text and its send glyph the text colour on the fill. Its text is
 * the iOS body style, which Dynamic Type grows by itself. Its height starts at the tap target and
 * stops at whole lines at the phone's font scale: six at the default size, fewer as the text grows,
 * never fewer than two, so the last line it shows is never cut. The library pads one line
 * vertically to the tap target, and the lines sit inside that padding.
 */
function chatTheme(t: ColourTokens, fontScale: number): PartialChatTheme {
  const lines = Math.max(2, Math.floor(6 / fontScale))
  const padding = SCALE.minTapTarget - COMPOSER_LINE
  const maxHeight = padding + lines * Math.ceil(COMPOSER_LINE * fontScale)
  return {
    colors: {
      background: t.background,
      incomingBubble: t.muted,
      incomingText: t.foreground,
      incomingMeta: t.foreground,
      incomingLink: t.foreground,
      outgoingBubble: t.primary,
      outgoingText: t.primaryForeground,
      outgoingMeta: t.primaryForeground,
      outgoingLink: t.primaryForeground,
      accent: t.primary,
      // The send glyph on the accent fill, never white (phon#276).
      onAccent: t.primaryForeground,
      separator: t.border,
      inputBackground: t.card,
      inputFieldBorder: t.border,
      inputText: t.foreground,
      inputCursor: t.primary,
      placeholder: t.mutedForeground,
      // The attach and GIF glyphs in the field.
      composerIcon: t.mutedForeground,
      incomingBubbleShadow: 'transparent',
      outgoingBubbleShadow: 'transparent',
      // On the background, since muted text on the muted surface fails AA in mist light.
      dayPillBackground: t.background,
      dayPillText: t.mutedForeground,
      surface: t.popover,
      error: t.destructive,
      senderName: t.mutedForeground,
    },
    // The library insets a photo 2 pt inside the bubble, so its corners sit 2 pt under the bubble's.
    radii: { bubble: SCALE.radius, bubbleGrouped: SCALE.radius, media: SCALE.radius - 2 },
    typography: {
      day: { fontSize: SCALE.type.footnote },
      composer: { fontSize: SCALE.type.body, lineHeight: COMPOSER_LINE },
    },
    // The glyphs stay at their size: the library's attach, GIF and send cells are a fixed 44 pt.
    composer: { minHeight: SCALE.minTapTarget, insetIconSize: ICON_SIZE.lg, maxHeight },
    wallpaper: { isEnabled: false },
    bubble: { hasTail: false, outgoingGradient: null },
  }
}

/** The WCAG 2 contrast ratio of two opaque `#rrggbb` colours. */
function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG 2 relative luminance. */
function luminance(hex: string): number {
  const channel = (start: number) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
