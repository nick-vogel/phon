/** The status bar and home-indicator heights, as `useSafeAreaInsets()` reports them. */
export interface VerticalInsets {
  top: number
  bottom: number
}

/**
 * How a screen with no header keeps its scrolling content out of the status bar and the home
 * indicator. React Native's ScrollView adds no inset of its own. The frame around the scroll view
 * starts it below the status bar, so nothing scrolls under the clock; the content's bottom padding
 * lifts the last button out of the home indicator's swipe zone once the content overflows. The
 * app is portrait only, so the sides take no inset.
 */
export function headerlessPadding(base: number, insets: VerticalInsets) {
  return {
    frame: { paddingTop: insets.top },
    content: {
      paddingTop: base,
      paddingBottom: insets.bottom + base,
      paddingHorizontal: base,
    },
  }
}
