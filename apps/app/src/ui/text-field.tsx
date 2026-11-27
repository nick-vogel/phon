import { useMemo } from 'react'
import { StyleSheet, TextInput, type TextInputProps } from 'react-native'
import { useTheme } from '../theme/use-theme'
import { FIELD_COLOURS } from './control-colours'

export interface TextFieldProps extends TextInputProps {
  /** What VoiceOver reads for the field. The text above it says what to type. */
  accessibilityLabel: string
}

/**
 * The shared text field: the background with a muted edge, at least the tap target tall and with
 * no fixed height, so it grows with Dynamic Type. The cursor is the accent and the keyboard follows
 * the mode. Every `TextInput` prop passes through, and `style` is merged last, so a field such as
 * the code field can set its own size.
 */
export function TextField({ style, ...props }: TextFieldProps) {
  const { tokens, mode } = useTheme()
  const styles = useMemo(
    () =>
      StyleSheet.create({
        field: {
          backgroundColor: tokens[FIELD_COLOURS.surface],
          borderWidth: 1,
          borderColor: tokens[FIELD_COLOURS.border],
          borderRadius: tokens.radius,
          minHeight: tokens.minTapTarget,
          paddingHorizontal: tokens.spacing.md,
          paddingVertical: tokens.spacing.sm,
          color: tokens[FIELD_COLOURS.text],
          fontSize: tokens.type.body,
        },
      }),
    [tokens],
  )
  return (
    <TextInput
      placeholderTextColor={tokens[FIELD_COLOURS.placeholder]}
      selectionColor={tokens[FIELD_COLOURS.cursor]}
      cursorColor={tokens[FIELD_COLOURS.cursor]}
      keyboardAppearance={mode}
      {...props}
      style={[styles.field, style]}
    />
  )
}
