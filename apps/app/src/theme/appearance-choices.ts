import type { AppearanceChoice } from './theme.ts'

/**
 * The appearance choices as Settings shows them and the device stores them. Pure, so the Node test
 * runner covers it; `appearance.ts` holds the stored choice and applies it.
 */

/** The Appearance control's segments, in order. */
export const APPEARANCE_CHOICES: readonly { choice: AppearanceChoice; label: string }[] = [
  { choice: 'system', label: 'System' },
  { choice: 'light', label: 'Light' },
  { choice: 'dark', label: 'Dark' },
]

/** The segment that shows a choice. */
export function appearanceIndex(choice: AppearanceChoice): number {
  return APPEARANCE_CHOICES.findIndex((segment) => segment.choice === choice)
}

/** The choice a segment picks. A segment outside the three is System. */
export function appearanceAt(index: number): AppearanceChoice {
  return APPEARANCE_CHOICES[index]?.choice ?? 'system'
}

/** The stored value as a choice. Nothing stored, or anything but Light or Dark, is System. */
export function parseAppearanceChoice(stored: string | null): AppearanceChoice {
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/**
 * The interface style React Native's `Appearance.setColorScheme` takes for a choice, so native
 * chrome follows it too: System resets to the phone's own, Light and Dark force theirs.
 */
export function colorSchemeOverride(choice: AppearanceChoice): 'auto' | 'light' | 'dark' {
  return choice === 'system' ? 'auto' : choice
}
