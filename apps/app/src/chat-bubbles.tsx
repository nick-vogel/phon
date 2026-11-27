import { type AvatarProps, Bubble, type BubbleProps } from '@kesha-antonov/react-native-chat'
import { useMemo } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { type ChannelChatMessage, messageMarks } from './channel-messages'
import type { ThemeTokens } from './theme/theme'
import { useTheme } from './theme/use-theme'
import { AVATAR_SIZE, Avatar } from './ui/avatar'

/**
 * The chat screen's render props. They draw the layout `toChatMessages` decided for each message
 * (`ChannelChatMessage.layout`) and decide nothing themselves. Every colour comes from the theme.
 * The library calls a render prop as a plain function, so each one returns an element of a
 * component, whose hooks then run in a component of their own, and each is made once, since the
 * library re-renders every row on a new render function.
 */

/** The height of the time line under a group's last bubble, before the phone's font scale. */
const TIME_LINE_HEIGHT = 16

function bubbleStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    // Fills the row beside the avatar, as the library's own bubble container does, so a
    // long-press beside a short bubble still reaches it.
    column: { flex: 1 },
    columnLeft: { alignItems: 'flex-start' },
    columnRight: { alignItems: 'flex-end' },
    // The library's container is `flex: 1`, which in this column would grow it vertically.
    bubble: { flex: 0, alignSelf: 'stretch' },
    name: {
      color: tokens.foreground,
      fontSize: tokens.type.footnote,
      fontWeight: '600',
      paddingHorizontal: tokens.spacing.sm,
      paddingBottom: tokens.spacing.xs,
    },
    time: {
      color: tokens.mutedForeground,
      fontSize: tokens.type.caption1,
      lineHeight: TIME_LINE_HEIGHT,
      paddingHorizontal: tokens.spacing.sm,
      paddingTop: tokens.spacing.xs,
    },
  })
}

/**
 * A message's bubble: other people's on the left on the muted surface, the member's own on the
 * right on the accent fill. The author's name shows above the first bubble of a group and the
 * time under the last. A message someone else wrote that @mentions the reader takes the mention
 * tint, which is never the only sign: the marks line in it also reads "Mentions you".
 */
function ChannelBubble(props: BubbleProps<ChannelChatMessage>) {
  const { tokens } = useTheme()
  const styles = useMemo(() => bubbleStyles(tokens), [tokens])
  const message = props.currentMessage
  const { side, showName, showTime } = message.layout
  const wrapperStyle = message.mentionsMe
    ? {
        ...props.wrapperStyle,
        left: [props.wrapperStyle?.left, { backgroundColor: tokens.mention }],
      }
    : props.wrapperStyle
  return (
    <View style={[styles.column, side === 'left' ? styles.columnLeft : styles.columnRight]}>
      {showName && message.user.name ? <Text style={styles.name}>{message.user.name}</Text> : null}
      <Bubble
        {...props}
        wrapperStyle={wrapperStyle}
        containerStyle={{
          left: [props.containerStyle?.left, styles.bubble],
          right: [props.containerStyle?.right, styles.bubble],
        }}
      />
      {showTime ? (
        <Text style={styles.time}>
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * The avatar beside the last bubble of another person's group, raised above the time line under
 * it. Other rows hold an empty space of its width, so a group's bubbles line up.
 */
function ChannelAvatar({ currentMessage }: AvatarProps<ChannelChatMessage>) {
  const { fontScale } = useWindowDimensions()
  const { tokens } = useTheme()
  const { showAvatar, showTime } = currentMessage.layout
  if (!showAvatar) return <View style={{ width: AVATAR_SIZE }} />
  const timeLine = showTime ? TIME_LINE_HEIGHT * fontScale + tokens.spacing.xs : 0
  return (
    <View style={{ marginBottom: timeLine }}>
      <Avatar name={currentMessage.user.name ?? ''} photoUrl={currentMessage.avatar} />
    </View>
  )
}

/**
 * Marks a message as the server sent it: mentioning the reader, pinned, urgent, a team
 * announcement, or deleted, which it sends to admins only (`messageMarks`). The text takes the
 * bubble's own text colour, on the muted surface, the mention tint or the accent fill.
 */
function MessageMarks({ currentMessage }: BubbleProps<ChannelChatMessage>) {
  const { tokens } = useTheme()
  const marks = messageMarks(currentMessage)
  if (marks.length === 0) return null
  const color =
    currentMessage.layout.side === 'right' ? tokens.primaryForeground : tokens.foreground
  return (
    <Text
      style={{
        color,
        fontSize: tokens.type.caption1,
        fontStyle: 'italic',
        paddingHorizontal: 10,
        paddingTop: tokens.spacing.xs,
      }}
    >
      {marks.join(' · ')}
    </Text>
  )
}

/** The library's time inside the bubble, hidden: `ChannelBubble` draws it under the group. */
export function hideTime() {
  return null
}

/** `renderBubble`: the bubble, with its name and time. */
export function renderChannelBubble(props: BubbleProps<ChannelChatMessage>) {
  return <ChannelBubble {...props} />
}

/** `renderAvatar`: the avatar beside a group's last bubble. */
export function renderChannelAvatar(props: AvatarProps<ChannelChatMessage>) {
  return <ChannelAvatar {...props} />
}

/** `renderCustomView`: the marks line in a bubble. */
export function renderMessageMarks(props: BubbleProps<ChannelChatMessage>) {
  return <MessageMarks {...props} />
}
