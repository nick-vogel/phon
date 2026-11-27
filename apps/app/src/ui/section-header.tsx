import { useMemo } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useTheme } from '../theme/use-theme'
import { SECTION_COLOURS } from './list-row-colours'

export interface SectionHeaderProps {
  title: string
}

/**
 * The heading above a group of `ListRow`s: footnote size in muted text on the page, lined up with
 * the rows' titles (the row's inset plus its padding). It wraps, and VoiceOver reads it as a
 * heading.
 */
export function SectionHeader({ title }: SectionHeaderProps) {
  const { tokens } = useTheme()
  const styles = useMemo(
    () =>
      StyleSheet.create({
        header: {
          color: tokens[SECTION_COLOURS.header],
          fontSize: tokens.type.footnote,
          paddingHorizontal: tokens.spacing.xxl,
          marginTop: tokens.spacing.xl,
          marginBottom: tokens.spacing.sm,
        },
      }),
    [tokens],
  )
  return (
    <Text accessibilityRole="header" style={styles.header}>
      {title}
    </Text>
  )
}

export interface SectionFooterProps {
  /** The line. It is a prop, not children, since lint takes a raw string only inside `Text`. */
  text: string
  /** A note in muted text, or a failure line in the destructive colour. A note by default. */
  tone?: 'note' | 'error'
  /** Whether VoiceOver announces the line when it appears, for a line that follows an action. */
  live?: boolean
}

/**
 * A line under a group of `ListRow`s, as iOS Settings explains a group: footnote size on the page,
 * lined up with the header and the rows' titles. It wraps.
 */
export function SectionFooter({ text, tone = 'note', live = false }: SectionFooterProps) {
  const { tokens } = useTheme()
  const styles = useMemo(
    () =>
      StyleSheet.create({
        footer: {
          color: tokens[tone === 'error' ? SECTION_COLOURS.error : SECTION_COLOURS.note],
          fontSize: tokens.type.footnote,
          paddingHorizontal: tokens.spacing.xxl,
          marginTop: tokens.spacing.sm,
        },
      }),
    [tokens, tone],
  )
  return (
    <Text accessibilityLiveRegion={live ? 'polite' : undefined} style={styles.footer}>
      {text}
    </Text>
  )
}
