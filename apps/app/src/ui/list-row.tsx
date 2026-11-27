import { Check, ChevronRight, type LucideIcon } from 'lucide-react-native'
import { type ReactNode, useMemo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/use-theme'
import { LIST_ROW_COLOURS } from './list-row-colours'

export interface ListRowProps {
  /** What the row says. It wraps rather than truncates, so the row grows with Dynamic Type. */
  title: string
  /**
   * A second line under the title, in muted text, such as when a log entry happened. It wraps,
   * unless `subtitleLines` cuts it. In a pressable row it takes the accent's text while pressed,
   * since muted text on the pressed surface falls under AA.
   */
  subtitle?: string
  /** The most lines the subtitle takes, its end cut with an ellipsis. By default it wraps. */
  subtitleLines?: number
  /**
   * What a tap does. With neither this nor `checked`, the row is not a button: VoiceOver reaches
   * its title and whatever `trailing` holds (a field, a switch, steppers) as their own elements.
   */
  onPress?: () => void
  /** A glyph before the title, in muted text. It is not an accessibility element. */
  icon?: LucideIcon
  /**
   * What sits after the title, before the chevron: a mark, a value or a control. In a row that is
   * not a button, it takes the rest of the row, at its end, and moves onto its own line below the
   * title when both do not fit, so at the largest text size the title is never squeezed.
   */
  trailing?: ReactNode
  /**
   * A value after the title, in muted text, such as the birthdate on file. It wraps unless
   * `valueOneLine` holds it to one line. In a pressable row it takes the accent's text while pressed.
   */
  value?: string
  /**
   * Holds the value to one line at its full width, so a short value such as a time never breaks
   * and the title and second line give way instead.
   */
  valueOneLine?: boolean
  /** Whether a chevron says the row opens a screen. By default, a pressable row that opens one. */
  chevron?: boolean
  /** Draws the title in the destructive colour, for an action such as Sign out. */
  destructive?: boolean
  /** Draws the title bold, for a channel with a message the member has not read. */
  bold?: boolean
  /**
   * Draws the title in muted text, for a channel with its alerts off. In a pressable row it takes
   * the accent's text while pressed.
   */
  muted?: boolean
  /**
   * Draws the title in the accent, with no chevron, for a row that acts on its group in place:
   * Approve, Close report. An action that stands alone under the groups is a Button instead.
   */
  action?: boolean
  /**
   * Makes the row a choice: VoiceOver reads it as `choice` and whether it is chosen, and a chosen
   * row draws a check mark at its end.
   */
  checked?: boolean
  /**
   * What kind of choice a `checked` row is: one of several (a radio, the default), or one of a set
   * that may hold any number (a checkbox).
   */
  choice?: 'radio' | 'checkbox'
  /** Takes no press, and dims as a disabled button does. */
  disabled?: boolean
  /** Shows a spinner after the title and takes no press, while what the row started runs. */
  busy?: boolean
  /** The first row of its group, which rounds the group's top corners and draws its top edge. */
  first?: boolean
  /** The last row of its group, which rounds the group's bottom corners. */
  last?: boolean
  /** Read in place of the title, when the title alone does not say enough. */
  accessibilityLabel?: string
}

/**
 * One row of an inset grouped list: on the card surface, inset from the screen's edges, at least
 * the tap target tall. The rows of a group share a hairline edge, each row's bottom edge the line
 * between it and the next, and the group's outer corners take the radius. Pressed, the row takes
 * the accent surface. A row with no press is a plain row that holds a value or a control; it adds
 * no padding above and below a control, so a 44 pt control makes it the tap target tall.
 */
export function ListRow({
  title,
  subtitle,
  subtitleLines,
  valueOneLine,
  onPress,
  icon: Icon,
  trailing,
  value,
  chevron,
  destructive = false,
  bold = false,
  muted = false,
  action = false,
  checked,
  choice = 'radio',
  disabled = false,
  busy = false,
  first = false,
  last = false,
  accessibilityLabel,
}: ListRowProps) {
  const { tokens } = useTheme()
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          minHeight: tokens.minTapTarget,
          flexDirection: 'row',
          alignItems: 'center',
          gap: tokens.spacing.md,
          paddingHorizontal: tokens.spacing.lg,
          paddingVertical: tokens.spacing.md,
          marginHorizontal: tokens.spacing.lg,
          backgroundColor: tokens[LIST_ROW_COLOURS.surface],
          borderColor: tokens[LIST_ROW_COLOURS.edge],
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
        plain: { paddingVertical: 0 },
        first: {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopLeftRadius: tokens.radius,
          borderTopRightRadius: tokens.radius,
        },
        last: {
          borderBottomLeftRadius: tokens.radius,
          borderBottomRightRadius: tokens.radius,
        },
        pressed: { backgroundColor: tokens[LIST_ROW_COLOURS.pressed] },
        disabled: { opacity: 0.5 },
        content: {
          flexGrow: 1,
          flexShrink: 1,
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: tokens.spacing.md,
        },
        title: {
          flexShrink: 1,
          flexGrow: 1,
          color:
            tokens[
              destructive
                ? LIST_ROW_COLOURS.destructive
                : action
                  ? LIST_ROW_COLOURS.action
                  : muted
                    ? LIST_ROW_COLOURS.mutedTitle
                    : LIST_ROW_COLOURS.title
            ],
          fontSize: tokens.type.body,
          fontWeight: bold ? '600' : undefined,
        },
        pressedText: { color: tokens[LIST_ROW_COLOURS.pressedText] },
        plainTitle: { flexGrow: 0, paddingVertical: tokens.spacing.md },
        lines: { flexShrink: 1, flexGrow: 1, gap: tokens.spacing.xs },
        subtitle: {
          color: tokens[LIST_ROW_COLOURS.subtitle],
          fontSize: tokens.type.subheadline,
        },
        value: {
          flexShrink: 1,
          color: tokens[LIST_ROW_COLOURS.value],
          fontSize: tokens.type.body,
          textAlign: 'right',
        },
        valueOneLine: { flexShrink: 0 },
        end: {
          flexGrow: 1,
          flexShrink: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
        },
      }),
    [tokens, destructive, action, muted, bold],
  )
  const pressable = onPress !== undefined || checked !== undefined
  const showChevron =
    chevron ?? (onPress !== undefined && !destructive && !action && checked === undefined)
  const label =
    accessibilityLabel ?? [title, subtitle, value].filter((part) => part !== undefined).join(', ')

  const spinner = busy && (
    <ActivityIndicator accessible={false} color={tokens[LIST_ROW_COLOURS.action]} />
  )
  const valueText = (pressed: boolean) =>
    value !== undefined && (
      <Text
        accessible={false}
        numberOfLines={valueOneLine ? 1 : undefined}
        style={[styles.value, valueOneLine && styles.valueOneLine, pressed && styles.pressedText]}
      >
        {value}
      </Text>
    )
  const mark = checked === true && (
    <View accessible={false}>
      <Check color={tokens[LIST_ROW_COLOURS.mark]} size={tokens.iconSize.md} strokeWidth={2.5} />
    </View>
  )
  // A plain row that holds a control is not one element, so its lines are read on their own.
  const holdsControl = !pressable && trailing !== undefined
  const subtitleText = (pressed: boolean) =>
    subtitle !== undefined && (
      <Text
        accessible={holdsControl}
        numberOfLines={subtitleLines}
        ellipsizeMode="tail"
        style={[styles.subtitle, pressed && styles.pressedText]}
      >
        {subtitle}
      </Text>
    )
  const icon = Icon && (
    <View accessible={false}>
      <Icon color={tokens[LIST_ROW_COLOURS.glyph]} size={tokens.iconSize.md} strokeWidth={2} />
    </View>
  )

  if (!pressable) {
    // A plain row: with no control, VoiceOver reads its title, second line and value as one
    // element; with one, the title and the control are each their own.
    return (
      <View
        accessible={!holdsControl}
        accessibilityLabel={holdsControl ? undefined : label}
        accessibilityState={busy ? { busy } : undefined}
        style={[
          styles.row,
          styles.plain,
          first && styles.first,
          last && styles.last,
          disabled && styles.disabled,
        ]}
      >
        {icon}
        <View style={styles.content}>
          {subtitle === undefined ? (
            <Text accessible={holdsControl} style={[styles.title, styles.plainTitle]}>
              {title}
            </Text>
          ) : (
            <View style={[styles.lines, styles.plainTitle]}>
              <Text accessible={holdsControl} style={styles.title}>
                {title}
              </Text>
              {subtitleText(false)}
            </View>
          )}
          {spinner}
          {(value !== undefined || trailing) && (
            <View style={styles.end}>
              {valueText(false)}
              {trailing}
            </View>
          )}
        </View>
      </View>
    )
  }

  return (
    <Pressable
      accessibilityRole={checked === undefined ? 'button' : choice}
      accessibilityLabel={label}
      accessibilityState={{
        disabled: disabled || busy,
        ...(busy && { busy }),
        ...(checked !== undefined && { checked }),
      }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        first && styles.first,
        last && styles.last,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {({ pressed }) => {
        // A muted title is muted text, which falls under AA on the pressed surface.
        const titleStyle = [styles.title, pressed && muted && styles.pressedText]
        return (
          <>
            {icon}
            {subtitle === undefined ? (
              <Text style={titleStyle}>{title}</Text>
            ) : (
              <View style={styles.lines}>
                <Text style={titleStyle}>{title}</Text>
                {subtitleText(pressed)}
              </View>
            )}
            {spinner}
            {valueText(pressed)}
            {trailing}
            {mark}
            {showChevron && (
              <View accessible={false}>
                <ChevronRight
                  color={tokens[LIST_ROW_COLOURS.glyph]}
                  size={tokens.iconSize.sm}
                  strokeWidth={2}
                />
              </View>
            )}
          </>
        )
      }}
    </Pressable>
  )
}
