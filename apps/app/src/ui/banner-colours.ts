import type { ColourTokens } from '../theme/theme.ts'

/**
 * The tokens the Banner draws with. The Banner reads its colours only from here, so the contrast
 * test in `test/theme.test.ts` checks the pairs it actually draws, in both modes.
 */
export const BANNER_COLOURS = {
  surface: 'muted',
  text: 'foreground',
  icon: 'foreground',
  action: 'primary',
  actionLabel: 'primaryForeground',
} as const satisfies Record<string, keyof ColourTokens>
