import type {
  ChatIcons,
  ChatLabels,
  IMessage,
  InputToolbarProps,
} from '@kesha-antonov/react-native-chat'
import {
  ArrowUp,
  Check,
  Eye,
  ImagePlay,
  Lock,
  type LucideIcon,
  Megaphone,
  Paperclip,
  Siren,
} from 'lucide-react-native'
import { type ReactNode, useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ComposerArea } from './composer-area'
import type { ThemeTokens } from './theme/theme'
import { useTheme } from './theme/use-theme'

/**
 * The chat screen's composer parts: the glyphs and labels the library's composer draws, the
 * notice in the composer's place where the member may not post, and the send options above it.
 * `composerArea` decides which of them show; these only draw it. Every colour comes from the
 * theme, the library's composer colours included (`chatTheme`).
 */

/**
 * The composer's glyphs, drawn at the colour and size the library passes: the send arrow in
 * `onAccent` on the accent fill, the attach and GIF glyphs in `composerIcon`. The library's emoji
 * button is the GIF control (`onPressEmoji`), so `emoji` is lucide's animated image. Made once, so
 * the library does not re-render on a new object.
 */
export const chatIcons: ChatIcons = {
  send: ({ color, size }) => <ArrowUp color={color} size={size} strokeWidth={2} />,
  paperclip: ({ color, size }) => <Paperclip color={color} size={size} strokeWidth={2} />,
  emoji: ({ color, size }) => <ImagePlay color={color} size={size} strokeWidth={2} />,
}

/** What VoiceOver reads for the field's icon-only controls. */
export const chatLabels: Partial<ChatLabels> = {
  attachButton: 'Add a photo',
  emojiButton: 'Add a GIF',
}

type NoticeArea = Exclude<ComposerArea, { kind: 'compose' }>

const NOTICE_ICONS: Record<NoticeArea['kind'], LucideIcon> = { oversight: Eye, 'read-only': Lock }

function noticeStyles(tokens: ThemeTokens, bottomInset: number) {
  return StyleSheet.create({
    band: {
      backgroundColor: tokens.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: tokens.border,
      padding: tokens.spacing.lg,
      paddingBottom: tokens.spacing.lg + bottomInset,
    },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: tokens.spacing.sm },
    reason: { flex: 1, color: tokens.mutedForeground, fontSize: tokens.type.footnote },
  })
}

/**
 * Why the member cannot post, in the composer's place: a quiet band on the background with a
 * hairline above it. The reason wraps and grows with Dynamic Type, never truncated. The band
 * replaces the library's whole toolbar, its home-indicator inset with it, so it keeps clear of the
 * home indicator itself.
 */
export function ComposerNotice({ area }: { area: NoticeArea }) {
  const { tokens } = useTheme()
  const { bottom } = useSafeAreaInsets()
  const styles = useMemo(() => noticeStyles(tokens, bottom), [tokens, bottom])
  const Icon = NOTICE_ICONS[area.kind]
  return (
    <View style={styles.band}>
      <View style={styles.row}>
        <Icon
          accessible={false}
          color={tokens.mutedForeground}
          size={tokens.iconSize.md}
          strokeWidth={2}
        />
        <Text style={styles.reason}>{area.reason}</Text>
      </View>
    </View>
  )
}

type NoticeRenderer = (props: InputToolbarProps<IMessage>) => ReactNode

const noticeRenderers = new Map<string, NoticeRenderer>()

/**
 * The `renderInputToolbar` for a notice area. The library calls it as a plain function, so it
 * returns an element of `ComposerNotice`, whose hooks run in a component of their own, and it is
 * the same function for the same area each time.
 */
export function renderComposerNotice(area: NoticeArea): NoticeRenderer {
  const key = `${area.kind}:${area.reason}`
  let render = noticeRenderers.get(key)
  if (render === undefined) {
    render = () => <ComposerNotice area={area} />
    noticeRenderers.set(key, render)
  }
  return render
}

function optionStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: tokens.spacing.sm,
      paddingHorizontal: tokens.spacing.sm,
    },
    target: { minHeight: tokens.minTapTarget, justifyContent: 'center' },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: tokens.spacing.xs,
      borderRadius: tokens.radius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      paddingHorizontal: tokens.spacing.md,
      paddingVertical: tokens.spacing.xs,
    },
    pillOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
    label: { fontSize: tokens.type.subheadline, color: tokens.foreground },
    labelOn: { color: tokens.primaryForeground, fontWeight: '600' },
  })
}

type OptionStyles = ReturnType<typeof optionStyles>

/**
 * One option for the next send, on or off, in a 44 pt tall touch area. On, the pill takes the
 * accent fill and a check before the label, so the state shows by more than colour.
 */
function SendOption({
  styles,
  tokens,
  label,
  icon: Icon,
  on,
  onToggle,
}: {
  styles: OptionStyles
  tokens: ThemeTokens
  label: string
  icon: LucideIcon
  on: boolean
  onToggle: () => void
}) {
  const colour = on ? tokens.primaryForeground : tokens.foreground
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={onToggle}
      style={styles.target}
    >
      <View style={[styles.pill, on && styles.pillOn]}>
        {on && <Check color={colour} size={tokens.iconSize.sm} strokeWidth={2} />}
        <Icon color={colour} size={tokens.iconSize.sm} strokeWidth={2} />
        <Text style={[styles.label, on && styles.labelOn]}>{label}</Text>
      </View>
    </Pressable>
  )
}

/**
 * The send options this person is offered, above the composer: a team announcement where they
 * lead the team, and urgent where their role may. Nothing is drawn when neither is offered. The
 * row wraps, so at the largest text size the options stay on the screen.
 */
export function SendOptions({
  area,
  teamAnnouncement,
  urgent,
  onToggleTeamAnnouncement,
  onToggleUrgent,
}: {
  area: ComposerArea
  teamAnnouncement: boolean
  urgent: boolean
  onToggleTeamAnnouncement: () => void
  onToggleUrgent: () => void
}) {
  const { tokens } = useTheme()
  const styles = useMemo(() => optionStyles(tokens), [tokens])
  if (area.kind !== 'compose' || (!area.offerTeamAnnouncement && !area.offerUrgent)) return null
  return (
    <View style={styles.row}>
      {area.offerTeamAnnouncement && (
        <SendOption
          styles={styles}
          tokens={tokens}
          label="Team announcement"
          icon={Megaphone}
          on={teamAnnouncement}
          onToggle={onToggleTeamAnnouncement}
        />
      )}
      {area.offerUrgent && (
        <SendOption
          styles={styles}
          tokens={tokens}
          label="Urgent"
          icon={Siren}
          on={urgent}
          onToggle={onToggleUrgent}
        />
      )}
    </View>
  )
}
