import {
  Chat,
  type IMessage,
  type MessageMenuItem,
  type PickedAttachment,
  Send,
  type SendProps,
} from '@kesha-antonov/react-native-chat'
import type { Gif, Member, Message } from '@phon/api-types'
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { Bell, Info, WifiOff } from 'lucide-react-native'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, StyleSheet, Text, View } from 'react-native'
import { type ChannelSocket, openChannelSocket } from '../../src/api/channel-socket'
import {
  channelsChanged,
  deleteMessage,
  getChannelPeople,
  getHistory,
  getMe,
  markRead,
  pinMessage,
  postImage,
  removeMessage as removeOnServer,
  reportMessage,
  ServerError,
  unpinMessage,
} from '../../src/api/client'
import { localGif, localImage } from '../../src/api/images'
import { channelClosed, clearedOnOpen, NOT_LOADED_NOTICE } from '../../src/channel-close'
import {
  applyReactions,
  type ChannelChatMessage,
  channelNames,
  emptyFrameRecord,
  type HistoryReads,
  hasReacted,
  historyReads,
  type MessageMenuAction,
  memberReads,
  mergeHistory,
  mergeMessages,
  messageMenuActions,
  peopleReads,
  recordFrame,
  removeMessage,
  type Schedule,
  toChatMessages,
  unnamedAuthors,
} from '../../src/channel-messages'
import { reconnects } from '../../src/channel-reconnect'
import {
  hideTime,
  renderChannelAvatar,
  renderChannelBubble,
  renderMessageMarks,
} from '../../src/chat-bubbles'
import { chatIcons, chatLabels, renderComposerNotice, SendOptions } from '../../src/chat-composer'
import { composerArea } from '../../src/composer-area'
import { GifPicker } from '../../src/gif-picker'
import { imagePickers } from '../../src/image-picker'
import {
  completeMention,
  type MentionablePerson,
  MentionSuggestions,
  mentionedIds,
  mentionQuery,
  mentionSuggestions,
} from '../../src/mention-completion'
import { noticeBanner } from '../../src/notice-banner'
import { READ_MARKER_VIEWABILITY, type ReadMarks, readMarks } from '../../src/read-marker'
import { sendButtonProps } from '../../src/send-button'
import type { ThemeTokens } from '../../src/theme/theme'
import { useTheme } from '../../src/theme/use-theme'
import { Banner } from '../../src/ui/banner'
import { HeaderIconButton } from '../../src/ui/header-icon-button'

type Status =
  | { state: 'open' }
  | { state: 'unavailable' }
  | { state: 'not-signed-in' }
  | { state: 'notice'; text: string }

/**
 * One channel: its history, its live messages, and the composer. It shows what the server sends
 * and decides nothing: a message appears when the server's `message` frame for it arrives, goes
 * when its `removed` frame does, and is replaced by an `updated` frame. Its reactions change when
 * a `reactions` frame arrives, and a posted image shows once it is downloaded. A socket that drops
 * is opened again by itself, and the screen catches up on what was sent while it was down; the
 * Reconnect button and the app coming back to the foreground skip the wait, and take again a read
 * that failed while the socket stayed open, which shows Reconnect too. The notice and Reconnect
 * show as one banner just above the composer, which rises with the keyboard. When the server closes
 * the socket because the person was taken out of the channel, the screen empties and shows the
 * channel as not available, and tries no more. As messages come on screen, the newest of them is
 * sent as the member's read marker (`src/read-marker.ts`), except to an admin reading by oversight.
 */
export default function ChannelScreen() {
  const { channelId, name, canPost, oversight, leads } = useLocalSearchParams<{
    channelId: string
    name?: string
    canPost?: string
    oversight?: string
    leads?: string
  }>()
  // The server's answer, passed on by the channel bar. Only an explicit "false" makes it read-only:
  // the server refuses a send it does not take anyway.
  const readOnly = canPost === 'false'
  const overseeing = oversight === 'true'
  // The channel bar passes the server's word that this person leads the channel's team.
  const leadsTeam = leads === 'true'
  const navigation = useNavigation()
  const router = useRouter()
  // The chat library follows the stored appearance choice, not only the phone's scheme.
  const theme = useTheme()
  const styles = useMemo(() => screenStyles(theme.tokens), [theme.tokens])
  const [me, setMe] = useState<Member | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [status, setStatus] = useState<Status>({ state: 'open' })
  const [socket, setSocket] = useState<ChannelSocket | null>(null)
  // The live socket closed on its own, and a reconnect is under way. Reconnect skips its wait.
  const [disconnected, setDisconnected] = useState(false)
  // What Reconnect does: connect now, and take again a read that failed while the socket was open.
  const retryRef = useRef<(() => void) | null>(null)
  // The composer's text, and the people picked from the @mention list, by person ID, with the name
  // inserted for each. Only those whose `@<name>` is still in the text go with the message.
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map())
  const [people, setPeople] = useState<MentionablePerson[]>([])
  // The same list by person ID, which names each message's author: null until a read of it answers
  // in this opening, and while it fails. An author it does not name has the list read again, once
  // per author per opening, through `rereadPeople`, which the opening sets and clears. The
  // history's reads in this opening name the authors the list leaves out (`channelNames`).
  const [listNames, setListNames] = useState<ReadonlyMap<string, string> | null>(null)
  const [historyAuthors, setHistoryAuthors] = useState<ReadonlyMap<string, string>>(new Map())
  // Each author's photo URL, or null, by person ID, from the history's reads in this opening: the
  // people list carries none. The latest read wins, so a photo a roster sync changed shows on it.
  const [historyAvatars, setHistoryAvatars] = useState<ReadonlyMap<string, string | null>>(
    new Map(),
  )
  const askedAuthors = useRef(new Set<string>())
  const rereadPeople = useRef<(() => void) | null>(null)
  // This opening's read marker, which the opening sets and clears, for the list's viewability
  // handler to send the rows on screen to.
  const readMarker = useRef<ReadMarks | null>(null)
  // What the next send asks to be. The server decides whether either is allowed, and its error
  // frame shows as the notice when not. Both reset after a send or an image pick.
  const [asTeamAnnouncement, setAsTeamAnnouncement] = useState(false)
  const [asUrgent, setAsUrgent] = useState(false)
  // Each message image downloaded to the device, by image ID, and the IDs already asked for.
  const [localImages, setLocalImages] = useState<ReadonlyMap<string, string>>(new Map())
  const requestedImages = useRef(new Set<string>())
  // The GIF keyboard's sheet is open.
  const [choosingGif, setChoosingGif] = useState(false)

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name ? `# ${name}` : `# ${channelId}`,
      // An admin reading by oversight gets no alerts from the channel, so has nothing to set.
      headerRight: overseeing
        ? undefined
        : () => (
            <HeaderIconButton
              icon={Bell}
              label="Alerts"
              onPress={() =>
                router.navigate({
                  pathname: '/channel-alerts',
                  params: { channelId, name: name ?? channelId },
                })
              }
            />
          ),
    })
  }, [navigation, router, name, channelId, overseeing])

  useFocusEffect(
    useCallback(() => {
      let left = false
      // The server took the person out of the channel. A read still in flight is dropped, so the
      // emptied screen stays empty and stays not available.
      let evicted = false
      setMessages([])
      setStatus({ state: 'open' })
      setDisconnected(false)
      setDraft('')
      setPicked(new Map())
      setAsTeamAnnouncement(false)
      setAsUrgent(false)
      setChoosingGif(false)
      setListNames(null)
      setHistoryAuthors(new Map())
      setHistoryAvatars(new Map())
      askedAuthors.current = new Set()

      const schedule: Schedule = (run, ms) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      }
      // A dropped socket is opened again by itself, after a wait that grows with each try. The
      // channel refusing the person is not a drop, so it ends the tries for good.
      const reconnect = reconnects({ connect: () => connect(), schedule })

      const failed = (error: unknown) => {
        if (left || evicted) return
        if (error instanceof ServerError && error.problem === 'not-found') {
          reconnect.stop()
          setStatus({ state: 'unavailable' })
        } else if (error instanceof ServerError && error.problem === 'not-signed-in') {
          reconnect.stop()
          setStatus({ state: 'not-signed-in' })
        } else {
          setStatus({ state: 'notice', text: NOT_LOADED_NOTICE })
        }
      }

      const member = memberReads({
        read: getMe,
        apply(found) {
          if (left) return
          setMe(found)
          loadedAgain()
        },
        failed,
      })

      let current: { live: ChannelSocket; history: HistoryReads } | null = null

      // A read that lands takes "could not be loaded" off the screen once the other read is not
      // failing either. Under an open socket nothing else would, since no open reads again.
      const loadedAgain = () => {
        if (member.failing() || current?.history.failing()) return
        setStatus((shown) =>
          shown.state === 'notice' && shown.text === NOT_LOADED_NOTICE ? { state: 'open' } : shown,
        )
      }

      // Opens one socket and reads the history for it. The history is read once the socket is
      // open: the server stores a message before it broadcasts it, so a message stored before the
      // read is in the history and one stored after the socket was accepted comes as a frame. The
      // history can still answer after frames that are newer than its copy, so what the socket
      // delivered wins over the history's copy. A socket that never connects still loads the
      // history when it closes, and one whose upgrade is held loads it after historyFallbackMs,
      // then again once it opens. A reconnect keeps the messages on screen: its read brings in
      // what was sent while the socket was down and takes off what went, and the dropped socket's
      // reads are stopped, since they would merge against that socket's frames.
      const connect = () => {
        current?.history.stop()
        current?.live.close()
        let delivered = emptyFrameRecord()
        const history = historyReads({
          read: () => getHistory(channelId),
          apply(read) {
            if (left || evicted) return
            setMessages((shown) => mergeHistory(shown, read.messages, delivered))
            setHistoryAuthors((named) => {
              const next = new Map(named)
              for (const { personId, name } of read.authors) next.set(personId, name)
              return next
            })
            setHistoryAvatars((photos) => {
              const next = new Map(photos)
              for (const { personId, avatar } of read.authors) next.set(personId, avatar ?? null)
              return next
            })
            loadedAgain()
          },
          failed,
          schedule,
        })

        const live = openChannelSocket(channelId, {
          onOpen() {
            if (left) return
            reconnect.opened()
            history.opened()
            setDisconnected(false)
            setStatus((shown) =>
              shown.state === 'notice' && clearedOnOpen(shown.text) ? { state: 'open' } : shown,
            )
            member.retry()
          },
          onFrame(frame) {
            if (left) return
            delivered = recordFrame(delivered, frame)
            if (frame.type === 'message' || frame.type === 'updated') {
              setMessages((shown) => mergeMessages(shown, [frame.message]))
            } else if (frame.type === 'removed') {
              setMessages((shown) => removeMessage(shown, frame.messageId))
            } else if (frame.type === 'reactions') {
              setMessages((shown) => applyReactions(shown, frame.messageId, frame.reactions))
            } else {
              setStatus({ state: 'notice', text: frame.reason })
            }
          },
          onClose(opened, code) {
            if (left) return
            const closed = channelClosed(opened, code)
            if (closed.outcome === 'evicted') {
              evicted = true
              reconnect.stop()
              history.stop()
              marks?.stop()
              readMarker.current = null
              setMessages([])
              setPeople([])
              setListNames(null)
              setHistoryAuthors(new Map())
              setHistoryAvatars(new Map())
              peopleList.stop()
              rereadPeople.current = null
              setDisconnected(false)
              setStatus({ state: 'unavailable' })
              setSocket(null)
              channelsChanged()
              return
            }
            if (!opened) history.neverOpened()
            setDisconnected(true)
            setStatus((shown) =>
              shown.state === 'unavailable' || shown.state === 'not-signed-in'
                ? shown
                : { state: 'notice', text: closed.notice },
            )
            reconnect.dropped()
          },
        })
        current = { live, history }
        setSocket(live)
      }
      connect()

      // A dropped socket connects now instead of waiting. A socket that stays open reads nothing
      // again by itself, so a read that failed under it is taken again here.
      const retry = () => {
        reconnect.now()
        current?.history.retry()
        member.retry()
      }
      retryRef.current = retry

      // A phone that slept with the channel open tries again at once when it wakes, rather than
      // waiting out the rest of the wait.
      // The read marker of this opening. An admin reading by oversight sends none: the server
      // keeps no marker for them. Each marker the server took reloads the channel list, which
      // stays mounted under this screen, so the icon's badge follows the read.
      const marks = overseeing
        ? null
        : readMarks({ send: (id) => markRead(channelId, id), read: () => channelsChanged() })
      marks?.active(AppState.currentState === 'active')
      readMarker.current = marks

      const foreground = AppState.addEventListener('change', (state) => {
        // A message that comes on screen while the phone is locked waits until it is unlocked.
        marks?.active(state === 'active')
        if (state === 'active') retry()
      })

      // Without the list there is no completion, and a message still sends as typed. A failed read
      // is taken again until one answers, and keeps what an earlier read of this opening gave.
      let listed = false
      const peopleList = peopleReads({
        read: () => getChannelPeople(channelId),
        // Leaving and eviction both stop the reads, so neither an answer nor a failure lands after.
        apply(list) {
          listed = true
          setPeople(list.people)
          setListNames(new Map(list.people.map(({ personId, name }) => [personId, name])))
        },
        failed() {
          if (!listed) setPeople([])
        },
        schedule,
      })
      rereadPeople.current = peopleList.again

      return () => {
        left = true
        reconnect.stop()
        retryRef.current = null
        rereadPeople.current = null
        foreground.remove()
        marks?.stop()
        readMarker.current = null
        peopleList.stop()
        current?.history.stop()
        current?.live.close()
        setSocket(null)
      }
    }, [channelId, overseeing]),
  )

  // The rows on screen, as the list reports them after each change: the read marker sends the
  // newest message among them. The list reports a new message in the commit that adds it, before
  // this screen's effects run, so each row's own ID and send time go, not a lookup in `messages`.
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item?: IMessage }[] }) => {
      const rows: IMessage[] = []
      for (const token of viewableItems) {
        if (token.item !== undefined) rows.push(token.item)
      }
      readMarker.current?.seen(rows)
    },
    [],
  )
  // The config's own `id` keeps these rows apart from the chat library's pair (READ_MARKER_VIEWABILITY).
  const listProps = useMemo(
    () => ({ onViewableItemsChanged, viewabilityConfig: READ_MARKER_VIEWABILITY }),
    [onViewableItemsChanged],
  )

  // Downloads each message image once. A failed download is asked for again the next time the
  // messages change, such as when the channel is opened again.
  useEffect(() => {
    for (const message of messages) {
      const image = message.image
      if (image === null || requestedImages.current.has(image.id)) continue
      requestedImages.current.add(image.id)
      localImage(channelId, image)
        .then((uri) => setLocalImages((current) => new Map(current).set(image.id, uri)))
        .catch(() => {
          requestedImages.current.delete(image.id)
        })
    }
  }, [messages, channelId])

  const names = useMemo(() => channelNames(listNames, historyAuthors), [listNames, historyAuthors])

  // A message from an author the people list does not name, such as a person the roster sync
  // added after the list was read, reads the list again, once per author per opening.
  useEffect(() => {
    if (me === null) return
    const authors = unnamedAuthors(messages, names, me, askedAuthors.current)
    if (authors.length === 0) return
    for (const author of authors) askedAuthors.current.add(author)
    rereadPeople.current?.()
  }, [messages, names, me])

  const chatMessages = useMemo(
    () => (me === null ? [] : toChatMessages(messages, me, names, localImages, historyAvatars)),
    [messages, me, names, localImages, historyAvatars],
  )
  const user = useMemo(() => (me === null ? undefined : { _id: me.personId, name: me.name }), [me])

  // The chat library clears the composer before it calls `onSend`, so a send the socket cannot
  // take is refused here, at the button, and the typed text stays in the composer.
  const renderSend = useCallback(
    (props: SendProps<IMessage>) => (
      <Send
        {...props}
        // Only when the field holds text, as in Messages: the library would otherwise force it on,
        // since no recorder is installed. Hidden, it is hidden from screen readers too.
        isSendButtonAlwaysVisible={false}
        sendButtonProps={sendButtonProps(props.text)}
        onSend={(message, shouldResetInputToolbar) => {
          if (socket?.isOpen() !== true) {
            setStatus({ state: 'notice', text: 'Not connected. The message was not sent.' })
            return
          }
          props.onSend?.(message, shouldResetInputToolbar)
        }}
      />
    ),
    [socket],
  )

  const onSend = useCallback(
    (outgoing: IMessage[]) => {
      // One send frame per message, and nothing appended here: the server stores it and sends it
      // back to every socket, this one included. The server decides who the mentions alert.
      for (const message of outgoing) {
        const sent = socket?.send(message.text, {
          mentions: mentionedIds(message.text, picked),
          teamAnnouncement: asTeamAnnouncement,
          urgent: asUrgent,
        })
        if (sent !== true) {
          setStatus({ state: 'notice', text: 'Not connected. The message was not sent.' })
        }
      }
      setPicked(new Map())
      setAsTeamAnnouncement(false)
      setAsUrgent(false)
    },
    [socket, picked, asTeamAnnouncement, asUrgent],
  )

  const query = mentionQuery(draft)
  const suggestions = useMemo(
    () => (query === null ? [] : mentionSuggestions(people, query, me?.personId ?? null)),
    [people, query, me],
  )
  // The composer, with the options this person is offered, or why they cannot post, as the
  // server said: a team announcement where they lead the team, and urgent when their role may.
  const canMarkUrgent = me?.canMarkUrgent === true
  const area = useMemo(
    () => composerArea({ overseeing, readOnly, leadsTeam, canMarkUrgent }),
    [overseeing, readOnly, leadsTeam, canMarkUrgent],
  )
  const composing = area.kind === 'compose'
  const openGif = useCallback(() => setChoosingGif(true), [])
  const toggleTeamAnnouncement = useCallback(() => setAsTeamAnnouncement((on) => !on), [])
  const toggleUrgent = useCallback(() => setAsUrgent((on) => !on), [])
  const reconnectShown =
    disconnected || (status.state === 'notice' && status.text === NOT_LOADED_NOTICE)
  const noticeText = status.state === 'notice' ? status.text : null
  const banner = useMemo(
    () => noticeBanner({ notice: noticeText, reconnect: reconnectShown }),
    [noticeText, reconnectShown],
  )
  const reconnectNow = useCallback(() => retryRef.current?.(), [])
  const renderChatFooter = useCallback(
    () => (
      <>
        {banner && (
          <Banner
            icon={banner.tone === 'connection' ? WifiOff : Info}
            text={banner.text}
            action={banner.reconnect ? { label: 'Reconnect', onPress: reconnectNow } : undefined}
          />
        )}
        <MentionSuggestions
          suggestions={suggestions}
          onPick={(person) => {
            setDraft((current) => completeMention(current, person))
            setPicked((current) => new Map(current).set(person.personId, person.name))
          }}
        />
        <SendOptions
          area={area}
          teamAnnouncement={asTeamAnnouncement}
          urgent={asUrgent}
          onToggleTeamAnnouncement={toggleTeamAnnouncement}
          onToggleUrgent={toggleUrgent}
        />
      </>
    ),
    [
      banner,
      reconnectNow,
      suggestions,
      area,
      asTeamAnnouncement,
      asUrgent,
      toggleTeamAnnouncement,
      toggleUrgent,
    ],
  )

  // A tap on an emoji takes the person's reaction off when the server already lists them under it,
  // and adds it otherwise. Nothing changes here: the server's `reactions` frame does that.
  const onReactionPress = useCallback(
    (message: ChannelChatMessage, emoji: string) => {
      if (me === null) return
      const shown = messages.find((candidate) => candidate.id === String(message._id))
      if (shown === undefined) return
      const sent = hasReacted(shown, me.personId, emoji)
        ? socket?.unreact(shown.id, emoji)
        : socket?.react(shown.id, emoji)
      if (sent !== true) {
        setStatus({ state: 'notice', text: 'Not connected. The reaction was not sent.' })
      }
    },
    [me, messages, socket],
  )

  // Uploads each picked image in turn, the caption and the send options with the first, and sends
  // nothing itself: the library is told `null`, and each message shows when the server's `message`
  // frame arrives. The options reset after a pick, as after a send.
  const onPick = useCallback(
    (attachments: PickedAttachment[], { caption }: { caption: string }) => {
      const images = attachments.flatMap((attachment) =>
        attachment.type === 'image' ? [attachment] : [],
      )
      const asked = { teamAnnouncement: asTeamAnnouncement, urgent: asUrgent }
      const plain = { teamAnnouncement: false, urgent: false }
      setAsTeamAnnouncement(false)
      setAsUrgent(false)
      void (async () => {
        for (const [index, image] of images.entries()) {
          try {
            await postImage(
              channelId,
              image,
              index === 0 ? caption : '',
              index === 0 ? asked : plain,
            )
          } catch (error) {
            setStatus({ state: 'notice', text: uploadRefusal(error) })
            return
          }
        }
      })()
      return null
    },
    [channelId, asTeamAnnouncement, asUrgent],
  )
  // Posts a GIF picked from the GIF keyboard the way a picked photo is posted: downloaded from
  // KLIPY's CDN, then uploaded as an image with the send options, which then reset. Nothing is
  // appended here: the message shows when the server's `message` frame arrives.
  const onPickGif = useCallback(
    (gif: Gif) => {
      const asked = { teamAnnouncement: asTeamAnnouncement, urgent: asUrgent }
      setAsTeamAnnouncement(false)
      setAsUrgent(false)
      void (async () => {
        try {
          const uri = await localGif(gif)
          await postImage(channelId, { uri, mimeType: 'image/gif' }, '', asked)
        } catch (error) {
          setStatus({ state: 'notice', text: uploadRefusal(error) })
        }
      })()
    },
    [channelId, asTeamAnnouncement, asUrgent],
  )
  const attachments = useMemo(
    () =>
      composing
        ? {
            tabs: ['gallery' as const, 'camera' as const],
            isGalleryGridEnabled: false,
            pickers: imagePickers,
            onPick,
          }
        : false,
    [composing, onPick],
  )
  // An admin reading by oversight cannot react: oversight is read only, and the server refuses it.
  const reactions = useMemo(
    () => ({ isEnabled: !overseeing, onReactionPress }),
    [overseeing, onReactionPress],
  )

  // In place of the composer when this person reads by oversight or may not post here.
  const renderInputToolbar = area.kind === 'compose' ? undefined : renderComposerNotice(area)

  // The long-press menu: Delete on the person's own messages, Report on anyone else's, and Remove
  // and Pin or Unpin when the server says this person moderates. Nothing changes here: the
  // server's `removed` or `updated` frame does that, on every screen showing the channel.
  const messageActions = useCallback(
    (message: ChannelChatMessage, defaults: MessageMenuItem[]): MessageMenuItem[] => {
      if (me === null) return defaults
      const messageId = String(message._id)
      const notice = (text: string) => setStatus({ state: 'notice', text })
      const items: Record<MessageMenuAction, MessageMenuItem> = {
        delete: {
          key: 'delete',
          label: 'Delete',
          destructive: true,
          onPress: () => {
            deleteMessage(channelId, messageId).catch(() =>
              notice('The message could not be deleted.'),
            )
          },
        },
        report: {
          key: 'report',
          label: 'Report',
          onPress: () =>
            confirm(
              'Report this message?',
              'The admins and chat admins will be told.',
              'Report',
              () =>
                reportMessage(channelId, messageId).then(
                  () => notice('Reported. The admins and chat admins have been told.'),
                  () => notice('The message could not be reported. Try again.'),
                ),
            ),
        },
        remove: {
          key: 'remove',
          label: 'Remove',
          destructive: true,
          onPress: () =>
            confirm(
              'Remove this message?',
              'It leaves the channel for everyone. Admins still see it, marked as removed.',
              'Remove',
              () =>
                removeOnServer(channelId, messageId).catch(() =>
                  notice('The message could not be removed.'),
                ),
              true,
            ),
        },
        pin: {
          key: 'pin',
          label: 'Pin',
          onPress: () => {
            pinMessage(channelId, messageId).catch(() => notice('The message could not be pinned.'))
          },
        },
        unpin: {
          key: 'unpin',
          label: 'Unpin',
          onPress: () => {
            unpinMessage(channelId, messageId).catch(() =>
              notice('The message could not be unpinned.'),
            )
          },
        },
      }
      return [...defaults, ...messageMenuActions(message, me).map((action) => items[action])]
    },
    [me, channelId],
  )

  if (status.state === 'unavailable') {
    return (
      <View style={styles.centered}>
        <Text style={styles.centeredText}>This channel is not available</Text>
      </View>
    )
  }
  // The server no longer takes the session: the client has cleared it, and the layout's guard is
  // taking the member to sign-in.
  if (status.state === 'not-signed-in') return null

  return (
    <View style={styles.screen}>
      {/* `emptyChatGreeting={null}` drops the empty card's greeting sticker, which posts a wave to
          the whole channel in one tap and bypasses the send gate in `renderSend`.
          `reply={{ isEnabled: false }}` removes swipe-to-reply and the long-press Reply item: a send
          frame carries only text, so a reply would post bare with the quote the member saw dropped.
          The bubbles draw the layout `toChatMessages` decided: `isAvatarVisibleForEveryMessage`
          has the library call `renderAvatar` on every row so that layout decides, and the
          library's own name and time inside the bubble are off, since the bubble draws both.
          The GIF control sits in the field's emoji slot (`onPressEmoji`), so the library's emoji
          panel is off; the system keyboard has its own emoji key. `listProps` passes the rows
          on screen to the read marker. */}
      <Chat
        messages={chatMessages}
        text={draft}
        onDraftChange={setDraft}
        renderChatFooter={renderChatFooter}
        onSend={onSend}
        renderSend={renderSend}
        emptyChatGreeting={null}
        reply={{ isEnabled: false }}
        messageActions={messageActions}
        renderCustomView={renderMessageMarks}
        renderBubble={renderChannelBubble}
        renderAvatar={renderChannelAvatar}
        isAvatarVisibleForEveryMessage
        isUsernameVisible={false}
        listProps={listProps}
        renderTime={hideTime}
        renderInputToolbar={renderInputToolbar}
        onPressEmoji={composing ? openGif : undefined}
        emojiKeyboard={false}
        icons={chatIcons}
        labels={chatLabels}
        user={user}
        isGroupChat
        attachments={attachments}
        reactions={reactions}
        theme={theme.chat.theme}
        darkTheme={theme.chat.darkTheme}
        colorScheme={theme.mode}
      />
      {composing && (
        <GifPicker visible={choosingGif} onPick={onPickGif} onClose={() => setChoosingGif(false)} />
      )}
    </View>
  )
}

/** What the person is told when an image they picked was not posted. */
function uploadRefusal(error: unknown): string {
  const problem = error instanceof ServerError ? error.problem : 'unavailable'
  switch (problem) {
    case 'too-large':
      return 'That image is larger than 10 MB, so it was not posted.'
    case 'unsupported':
      return 'Phon posts JPEG, PNG, WebP and GIF images. That one was not posted.'
    case 'not-allowed':
    case 'not-found':
      return 'You cannot post an image in this channel.'
    default:
      return 'The image could not be posted. Try again.'
  }
}

/**
 * Asks before an action that tells other people or changes the channel for everyone, and runs it
 * only on the confirming button.
 */
function confirm(
  title: string,
  message: string,
  action: string,
  onConfirm: () => void,
  destructive = false,
): void {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
  ])
}

/** The screen's styles, from the theme's tokens. */
function screenStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: tokens.background,
    },
    centeredText: { fontSize: 16, color: tokens.mutedForeground, textAlign: 'center' },
  })
}
