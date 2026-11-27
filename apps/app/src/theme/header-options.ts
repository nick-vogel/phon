import type { Mode, ThemeTokens } from './theme.ts'

/**
 * The stack's header options for the resolved mode. The native header takes its interface style
 * from the navigation theme unless told (expo-router 58's useHeaderConfigProps). With none set it
 * drew light glass in dark mode, which its glyphs could not be read on (#322), so the style is
 * set here directly. expo-router's type docs say the header does not take a new style while its
 * screen is visible, but on iOS 27.2 the Settings header changed at once with Appearance
 * (Simulator, 2026-11-25).
 */
export function headerOptions(mode: Mode, tokens: ThemeTokens) {
  return {
    headerStyle: { backgroundColor: tokens.background },
    headerTintColor: tokens.primaryText,
    headerTitleStyle: { color: tokens.foreground },
    headerUserInterfaceStyle: mode,
  }
}

/**
 * React Navigation's theme colours from the tokens. Without them the stack keeps the library's
 * light grey behind its screens, which showed at a screen's rounded corners during a dark swipe
 * back (Simulator, 2026-11-25).
 */
export function navigationColours(tokens: ThemeTokens) {
  return {
    primary: tokens.primaryText,
    background: tokens.background,
    card: tokens.background,
    text: tokens.foreground,
    border: tokens.border,
    notification: tokens.destructive,
  }
}
