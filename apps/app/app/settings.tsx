import SegmentedControl from '@expo/ui/community/segmented-control'
import type { Member } from '@phon/api-types'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import { getMe, signOut } from '../src/api/client'
import { registeredPushToken } from '../src/push'
import { settingsSections } from '../src/settings-sections'
import { setAppearance, useAppearance } from '../src/theme/appearance'
import { APPEARANCE_CHOICES, appearanceAt, appearanceIndex } from '../src/theme/appearance-choices'
import { useTheme } from '../src/theme/use-theme'
import { Avatar } from '../src/ui/avatar'
import { ListRow } from '../src/ui/list-row'
import { SectionHeader } from '../src/ui/section-header'

/**
 * Settings, pushed from the channel list's header: everything the drawer held but the channels.
 * The member rows, Appearance and Sign out show for everyone, and each Admin row by the server's
 * permission (`src/settings-sections.ts`). The member loads each time the screen gains focus, and
 * no Admin row shows while it loads or when it fails. The Appearance group's control picks System,
 * Light or Dark; the device keeps the choice, and every open screen follows it at once. Once the
 * member loads, a header above the groups shows their avatar, their photo or their initials, and
 * their name; nothing shows there while it loads or when it fails.
 */
/** The Settings header's avatar diameter, in points. */
const HEADER_AVATAR_SIZE = 64

export default function Settings() {
  const router = useRouter()
  const { tokens, mode } = useTheme()
  const { choice } = useAppearance()
  const [me, setMe] = useState<Member | null>(null)

  useFocusEffect(
    useCallback(() => {
      let left = false
      getMe()
        .then((loaded) => {
          if (!left) setMe(loaded)
        })
        .catch(() => {
          if (!left) setMe(null)
        })
      return () => {
        left = true
      }
    }, []),
  )

  const styles = useMemo(
    () =>
      StyleSheet.create({
        page: { backgroundColor: tokens.background },
        content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
        header: {
          alignItems: 'center',
          marginTop: tokens.spacing.lg,
          paddingHorizontal: tokens.spacing.lg,
        },
        name: {
          marginTop: tokens.spacing.sm,
          color: tokens.foreground,
          fontSize: tokens.type.title3,
          fontWeight: '600',
          textAlign: 'center',
        },
        firstGroup: { marginTop: tokens.spacing.lg },
        laterGroup: { marginTop: tokens.spacing.xl },
        controlRow: {
          minHeight: tokens.minTapTarget,
          justifyContent: 'center',
          paddingHorizontal: tokens.spacing.lg,
          paddingVertical: tokens.spacing.sm,
          marginHorizontal: tokens.spacing.lg,
          backgroundColor: tokens.card,
          borderColor: tokens.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: tokens.radius,
        },
      }),
    [tokens],
  )

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {me !== null && (
        <View style={styles.header}>
          <Avatar name={me.name} photoUrl={me.avatar} size={HEADER_AVATAR_SIZE} />
          <Text style={styles.name}>{me.name}</Text>
        </View>
      )}
      {settingsSections(me).map((section, sectionIndex) => (
        <View
          key={section.key}
          style={
            section.title !== null
              ? undefined
              : sectionIndex === 0
                ? styles.firstGroup
                : styles.laterGroup
          }
        >
          {section.title !== null && <SectionHeader title={section.title} />}
          {section.rows.map((row, index) => {
            const edges = { first: index === 0, last: index === section.rows.length - 1 }
            if ('control' in row) {
              return (
                <View key={row.label} style={styles.controlRow}>
                  <SegmentedControl
                    values={APPEARANCE_CHOICES.map((segment) => segment.label)}
                    selectedIndex={appearanceIndex(choice)}
                    onChange={(event) =>
                      void setAppearance(appearanceAt(event.nativeEvent.selectedSegmentIndex))
                    }
                    appearance={mode}
                    accessibilityLabel={row.label}
                    testID="appearance"
                  />
                </View>
              )
            }
            return 'path' in row ? (
              <ListRow
                key={row.label}
                title={row.label}
                onPress={() => router.push(row.path)}
                {...edges}
              />
            ) : (
              <ListRow
                key={row.label}
                title={row.label}
                destructive
                onPress={confirmSignOut}
                {...edges}
              />
            )
          })}
        </View>
      ))}
    </ScrollView>
  )
}

/** Asks before signing out on this phone, which then shows sign-in. */
function confirmSignOut(): void {
  Alert.alert('Sign out of Phon on this phone?', undefined, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Sign out',
      style: 'destructive',
      onPress: () => void registeredPushToken().then(signOut),
    },
  ])
}
