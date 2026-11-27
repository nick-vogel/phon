import type { ColourTokens } from '../theme/theme.ts'

/**
 * Which tokens the shared Button and TextField draw, as token names, so a Node test can hold each
 * pair to the theme module's contrast report. The components import `react-native`, which the Node
 * runner cannot load, so their colours live here.
 */

/** The one strong action, a choice such as a church or a person, and a text action. */
export type ButtonVariant = 'primary' | 'secondary' | 'plain'

export interface ControlColours {
  surface: keyof ColourTokens
  label: keyof ColourTokens
}

/**
 * Each Button variant's surface and label. A plain button draws no fill, so it reads on whatever
 * is behind it; its surface here is the background it sits on.
 */
export const BUTTON_COLOURS: Record<ButtonVariant, ControlColours> = {
  primary: { surface: 'primary', label: 'primaryForeground' },
  secondary: { surface: 'secondary', label: 'secondaryForeground' },
  plain: { surface: 'background', label: 'primaryText' },
}

/**
 * The TextField's colours. Its edge is muted text, not shadcn's `input` token, since `input` on the
 * background is under the 3:1 a field's edge needs (WCAG 1.4.11).
 */
export const FIELD_COLOURS = {
  surface: 'background',
  text: 'foreground',
  placeholder: 'mutedForeground',
  border: 'mutedForeground',
  cursor: 'primary',
} as const satisfies Record<string, keyof ColourTokens>
