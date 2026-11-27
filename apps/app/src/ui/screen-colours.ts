import type { ColourTokens } from '../theme/theme.ts'

/**
 * The tokens the one-time screens, the GIF picker and the mention list draw their text and glyphs
 * with, each on the surface it sits on. The screens read those colours only from here, so the
 * contrast test in `test/theme.test.ts` checks every pair they actually draw, in both modes. Their
 * buttons and the GIF search field draw from `control-colours.ts`, which
 * `test/control-colours.test.ts` checks.
 */

/** The oversight notice, urgent setup and Connect: titles, paragraphs, notes and failure lines. */
export const ONE_TIME_SCREEN_COLOURS = {
  surface: 'background',
  text: 'foreground',
  note: 'mutedForeground',
  failed: 'destructive',
} as const satisfies Record<string, keyof ColourTokens>

/** The GIF sheet: its status lines and the Cancel text control. */
export const GIF_PICKER_COLOURS = {
  surface: 'background',
  status: 'mutedForeground',
  cancel: 'primaryText',
} as const satisfies Record<string, keyof ColourTokens>

/** The @mention list in the chat footer, which has no surface of its own: each name. */
export const MENTION_LIST_COLOURS = {
  surface: 'background',
  name: 'foreground',
} as const satisfies Record<string, keyof ColourTokens>
