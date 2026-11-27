import { useMemo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native'
import { useTheme } from '../theme/use-theme'
import { BUTTON_COLOURS, type ButtonVariant } from './control-colours'

export interface ButtonProps {
  /** What the button says. It wraps rather than truncates, so it grows with Dynamic Type. */
  label: string
  onPress: () => void
  /** Primary for the one strong action, secondary for a choice, plain for a text action. */
  variant?: ButtonVariant
  disabled?: boolean
  /** Shows a spinner in place of the label, and takes no press, while the action runs. */
  busy?: boolean
  /** Where the label sits: centred, or at the leading edge for a choice in a list. */
  align?: 'center' | 'start'
  /** Read in place of the label, when the label alone does not say enough. */
  accessibilityLabel?: string
}

/**
 * The shared button: at least the tap target tall, its colours from `BUTTON_COLOURS`. A plain
 * button draws no fill, so it sits on whatever is behind it. Pressed or busy, it dims to 0.7; a
 * disabled one dims to 0.5, so an empty field's button reads as not yet ready. A busy button keeps
 * its label for VoiceOver while the spinner shows.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  align = 'center',
  accessibilityLabel,
}: ButtonProps) {
  const { tokens } = useTheme()
  const styles = useMemo(() => {
    const colours = BUTTON_COLOURS[variant]
    return StyleSheet.create({
      button: {
        backgroundColor: variant === 'plain' ? undefined : tokens[colours.surface],
        borderRadius: tokens.radius,
        minHeight: tokens.minTapTarget,
        paddingHorizontal: tokens.spacing.lg,
        paddingVertical: tokens.spacing.sm,
        alignItems: align === 'start' ? 'flex-start' : 'center',
        justifyContent: 'center',
      },
      pressed: { opacity: 0.7 },
      disabled: { opacity: 0.5 },
      label: {
        color: tokens[colours.label],
        fontSize: tokens.type.body,
        fontWeight: '600',
        textAlign: align === 'start' ? 'left' : 'center',
      },
    })
  }, [tokens, variant, align])

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        (pressed || busy) && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={styles.label.color} />
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
    </Pressable>
  )
}
