import type { LucideIcon } from 'lucide-react-native'
import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/use-theme'
import { BANNER_COLOURS } from './banner-colours'

export interface BannerProps {
  /** The icon before the text, which says the notice's kind by more than colour. */
  icon?: LucideIcon
  /** The notice. With none, the banner draws the icon and the action only. */
  text?: string | null
  /** One button on the banner, such as Reconnect. */
  action?: { label: string; onPress: () => void }
}

/**
 * A notice on a rounded card, with one optional action. The text and icon are `foreground` on
 * `muted` and the action is a pill on `primary`, both pairs AA in each mode. The text grows with
 * the phone's text size and is never cut: the row wraps, so at the largest sizes the action drops
 * to its own line. VoiceOver reads the icon and text as one item and the action as a second.
 */
export function Banner({ icon: Icon, text, action }: BannerProps) {
  const { tokens } = useTheme()
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          marginHorizontal: tokens.spacing.sm,
          marginVertical: tokens.spacing.xs,
          padding: tokens.spacing.md,
          borderRadius: tokens.radius,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.border,
          backgroundColor: tokens[BANNER_COLOURS.surface],
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.spacing.sm,
        },
        notice: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: tokens.spacing.sm,
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 180,
        },
        text: {
          flexShrink: 1,
          color: tokens[BANNER_COLOURS.text],
          fontSize: tokens.type.subheadline,
        },
        action: {
          minHeight: tokens.minTapTarget,
          justifyContent: 'center',
          paddingHorizontal: tokens.spacing.lg,
          borderRadius: tokens.radius,
          backgroundColor: tokens[BANNER_COLOURS.action],
        },
        pressed: { opacity: 0.7 },
        actionLabel: {
          color: tokens[BANNER_COLOURS.actionLabel],
          fontSize: tokens.type.subheadline,
          fontWeight: '600',
          textAlign: 'center',
        },
      }),
    [tokens],
  )
  const hasText = typeof text === 'string' && text !== ''
  return (
    <View style={styles.card}>
      {(Icon || hasText) && (
        <View
          style={hasText ? styles.notice : undefined}
          accessible={hasText}
          accessibilityRole={hasText ? 'alert' : undefined}
        >
          {Icon && (
            <View accessible={false}>
              <Icon color={tokens[BANNER_COLOURS.icon]} size={tokens.iconSize.md} strokeWidth={2} />
            </View>
          )}
          {hasText && <Text style={styles.text}>{text}</Text>}
        </View>
      )}
      {action && (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionLabel}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  )
}
