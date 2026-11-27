import { useMemo } from 'react'
import { useColorScheme, useWindowDimensions } from 'react-native'
import { useAppearance } from './appearance.ts'
import { DEFAULT_THEME, type ResolvedTheme, resolveTheme } from './theme.ts'

/**
 * The resolved theme for this screen: the church theme under the member's stored choice and the
 * phone's scheme, with icon sizes at the phone's font scale. It re-renders when any of the three
 * changes. Not the chat library's own `useTheme`, which reads the library's resolved theme.
 */
export function useTheme(): ResolvedTheme {
  const scheme = useColorScheme()
  const { fontScale } = useWindowDimensions()
  const { choice } = useAppearance()
  return useMemo(
    () => resolveTheme({ church: DEFAULT_THEME, choice, scheme, fontScale }),
    [choice, scheme, fontScale],
  )
}
