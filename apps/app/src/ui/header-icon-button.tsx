import type { LucideIcon } from 'lucide-react-native'
import { Pressable } from 'react-native'
import { useTheme } from '../theme/use-theme'

/** A glyph button in the header, the tap target in both directions, in the accent text colour. */
export function HeaderIconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon
  label: string
  onPress: () => void
}) {
  const { tokens } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: tokens.minTapTarget,
        minHeight: tokens.minTapTarget,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon color={tokens.primaryText} size={tokens.headerIconSize} strokeWidth={2} />
    </Pressable>
  )
}
