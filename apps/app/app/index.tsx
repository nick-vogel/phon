import type { ChannelKind, Member } from '@phon/api-types'
import { getCalendars } from 'expo-localization'
import { useFocusEffect, useNavigation, useRouter } from 'expo-router'
import {
  Hash,
  House,
  Lock,
  type LucideIcon,
  Megaphone,
  Settings,
  SquarePen,
  UserStar,
  Users,
} from 'lucide-react-native'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AppState,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import {
  forgetMe,
  getChannels,
  getMe,
  ServerError,
  subscribeChannelsChanged,
} from '../src/api/client'
import { showMentionBadge } from '../src/app-badge'
import { type ChannelListLoad, channelListView, mayCompose } from '../src/channel-list'
import { channelRouteParams } from '../src/channel-route'
import { setAppBadgeCount, subscribePushReceived } from '../src/push'
import { useTheme } from '../src/theme/use-theme'
import { HeaderIconButton } from '../src/ui/header-icon-button'
import { ListRow } from '../src/ui/list-row'
import { CHANNEL_BADGE_COLOURS } from '../src/ui/list-row-colours'
import { SectionHeader } from '../src/ui/section-header'

/** Each kind's glyph before the channel's name. A new kind fails the type check until it has one. */
const KIND_ICONS: Record<ChannelKind, LucideIcon> = {
  announcements: Megaphone,
  open: Hash,
  private: Lock,
  'small-group': House,
  team: Users,
  'team-leads': UserStar,
}

/**
 * The home screen: the member's channels, the root of the stack, so a channel opens on top of it
 * and Back returns here. `src/channel-list.ts` decides what it shows; this screen loads it and
 * draws it. The header holds Settings, and New channel for a member the server lets create one. A
 * pull reloads the channels and the member (a role an admin changed since), and a channel this
 * member created shows without one. The list also reloads each time it comes into view (the first
 * load, and the return from a channel), while in view when a push arrives, and, even under another
 * screen, when the app comes to the foreground or a channel on top sends a read marker, so a row's
 * unread state, badge and preview stay current. Each load also sets the app icon's badge to the
 * list's unread mentions; a failed load leaves it as it was.
 */
export default function ChannelList() {
  const router = useRouter()
  const navigation = useNavigation()
  const { tokens } = useTheme()
  const [load, setLoad] = useState<ChannelListLoad>({ state: 'loading' })
  const [me, setMe] = useState<Member | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const styles = useMemo(
    () =>
      StyleSheet.create({
        page: { backgroundColor: tokens.background },
        content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
        centred: {
          flexGrow: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: tokens.spacing.xl,
          gap: tokens.spacing.sm,
        },
        note: {
          color: tokens.mutedForeground,
          fontSize: tokens.type.body,
          textAlign: 'center',
        },
        emptyTitle: {
          color: tokens.foreground,
          fontSize: tokens.type.title3,
          fontWeight: '600',
          textAlign: 'center',
        },
        firstGroup: { marginTop: tokens.spacing.lg },
        leads: {
          color: tokens.secondaryForeground,
          backgroundColor: tokens.secondary,
          fontSize: tokens.type.caption1,
          fontWeight: '600',
          borderRadius: tokens.radius,
          overflow: 'hidden',
          paddingVertical: tokens.spacing.xs,
          paddingHorizontal: tokens.spacing.sm,
          flexShrink: 1,
        },
        marks: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: tokens.spacing.xs,
          flexShrink: 1,
        },
        mentions: {
          color: tokens[CHANNEL_BADGE_COLOURS.text],
          backgroundColor: tokens[CHANNEL_BADGE_COLOURS.fill],
          fontSize: tokens.type.caption1,
          fontWeight: '600',
          borderRadius: tokens.radius,
          overflow: 'hidden',
          paddingVertical: tokens.spacing.xs,
          paddingHorizontal: tokens.spacing.sm,
        },
      }),
    [tokens],
  )

  // Focus, the foreground, a push and a pull can each start a load while another runs: only the
  // newest one's answer is drawn.
  const loads = useRef(0)
  const refresh = useCallback(async () => {
    loads.current += 1
    const current = loads.current
    getMe()
      .then((loaded) => {
        if (current === loads.current) setMe(loaded)
      })
      .catch(() => {
        if (current === loads.current) setMe(null)
      })
    try {
      const list = await getChannels()
      if (current === loads.current) {
        setLoad({ state: 'loaded', channels: list.channels })
        void showMentionBadge(list.channels, setAppBadgeCount, Platform.OS)
      }
    } catch (error) {
      if (current === loads.current) setLoad({ state: 'failed', message: describe(error) })
    }
  }, [])

  // A channel this member created, or a read sent from a channel on top, shows without a pull.
  useEffect(() => subscribeChannelsChanged(() => void refresh()), [refresh])

  // The foreground reloads the list even under another screen, so the icon's badge is current
  // whichever screen the app opens on.
  useEffect(() => {
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh()
    })
    return () => foreground.remove()
  }, [refresh])

  useFocusEffect(
    useCallback(() => {
      void refresh()
      // Only while the list is in view: a hidden one reloads when it comes back, and the push
      // itself sets the icon's badge.
      return subscribePushReceived(() => void refresh())
    }, [refresh]),
  )

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    // A pull also picks up a role an admin changed since the member was loaded.
    forgetMe()
    await refresh()
    setRefreshing(false)
  }, [refresh])

  const compose = mayCompose(me)
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <HeaderIconButton
          icon={Settings}
          label="Settings"
          onPress={() => router.push('/settings')}
        />
      ),
      headerRight: compose
        ? () => (
            <HeaderIconButton
              icon={SquarePen}
              label="New channel"
              onPress={() => router.push('/new-channel')}
            />
          )
        : undefined,
    })
  }, [navigation, router, compose])

  const view = channelListView(load, me, {
    now: new Date(),
    uses24hourClock: getCalendars()[0]?.uses24hourClock ?? null,
  })

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={tokens.mutedForeground}
        />
      }
    >
      {view.kind === 'loading' && (
        <View style={styles.centred}>
          <Text style={styles.note}>Loading channels</Text>
        </View>
      )}
      {view.kind === 'failed' && (
        <View style={styles.centred}>
          <Text style={styles.note}>{view.message}</Text>
        </View>
      )}
      {view.kind === 'empty' && (
        <View style={styles.centred}>
          <Text accessibilityRole="header" style={styles.emptyTitle}>
            {view.title}
          </Text>
          <Text style={styles.note}>{view.body}</Text>
        </View>
      )}
      {view.kind === 'channels' &&
        view.sections.map((section) => (
          <View key={section.key} style={section.title === null ? styles.firstGroup : undefined}>
            {section.title !== null && <SectionHeader title={section.title} />}
            {section.rows.map((row, index) => (
              <ListRow
                key={row.channel.id}
                title={row.channel.name}
                icon={KIND_ICONS[row.channel.kind]}
                bold={row.unread}
                muted={row.muted}
                subtitle={row.preview?.text}
                subtitleLines={1}
                value={row.preview?.time}
                valueOneLine
                first={index === 0}
                last={index === section.rows.length - 1}
                accessibilityLabel={row.accessibilityLabel}
                trailing={
                  row.mentions !== null || row.leads ? (
                    <View accessible={false} style={styles.marks}>
                      {row.mentions !== null && (
                        <Text accessible={false} style={styles.mentions}>
                          {row.mentions}
                        </Text>
                      )}
                      {row.leads && (
                        <Text accessible={false} style={styles.leads}>
                          You lead
                        </Text>
                      )}
                    </View>
                  ) : undefined
                }
                onPress={() =>
                  router.push({
                    pathname: '/channels/[channelId]',
                    params: channelRouteParams(row.channel),
                  })
                }
              />
            ))}
          </View>
        ))}
    </ScrollView>
  )
}

function describe(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-signed-in') return 'Not signed in'
  return 'Channels could not be loaded. Pull down to try again.'
}
