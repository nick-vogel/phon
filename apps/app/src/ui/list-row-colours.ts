import type { ColourTokens } from '../theme/theme.ts'

/**
 * Which tokens the inset grouped list draws, as token names, so a Node test can hold each pair to
 * the theme module's contrast report. `ListRow` and `SectionHeader` import `react-native`, which
 * the Node runner cannot load, so their colours live here.
 */

/**
 * One row: its surface and edge, its title, a second line under the title, a value after the
 * title, an action's title (the accent as text), a destructive title, the check mark of a chosen
 * row, and the glyphs (an icon, the chevron). A muted title is a channel with its alerts off.
 * Pressed, the row takes the accent surface for as long as the finger is down, and its second line,
 * value and muted title take the accent's text, since muted text on the accent is not a checked pair.
 */
export const LIST_ROW_COLOURS = {
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
} as const satisfies Record<string, keyof ColourTokens>

/** A channel row's mention badge: a pill in the accent, the count in the accent's text. */
export const CHANNEL_BADGE_COLOURS = {
  fill: 'primary',
  text: 'primaryForeground',
} as const satisfies Record<string, keyof ColourTokens>

/** A group's header and footer lines, on the page around the rows: notes, and a failure line. */
export const SECTION_COLOURS = {
  surface: 'background',
  header: 'mutedForeground',
  note: 'mutedForeground',
  error: 'destructive',
} as const satisfies Record<string, keyof ColourTokens>
