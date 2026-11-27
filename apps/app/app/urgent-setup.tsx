import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { URGENT_CHANNEL_NAME } from '../src/notification-channels'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { ONE_TIME_SCREEN_COLOURS } from '../src/ui/screen-colours'
import { SectionFooter, SectionHeader } from '../src/ui/section-header'
import { markUrgentSetupSeen } from '../src/urgent-setup'
import { leaveUrgentSetup } from '../src/urgent-setup-exit'

/**
 * How to let urgent messages through on this phone. Admins and chat admins can mark a message
 * urgent, and Phon sends it so it can break through Focus on iPhone and Do Not Disturb on Android,
 * but only once the person allows it in the phone's settings. Phon cannot read whether they did,
 * so this screen explains and opens Settings. Shown once per device, and from Settings.
 */
export default function UrgentSetup() {
  const router = useRouter()
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])
  const [settingsFailed, setSettingsFailed] = useState(false)

  const openSettings = () => {
    setSettingsFailed(false)
    Linking.openSettings().catch(() => setSettingsFailed(true))
  }

  const done = async () => {
    await markUrgentSetupSeen()
    leaveUrgentSetup(router)
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text style={styles.title} accessibilityRole="header">
        Let urgent messages through
      </Text>
      <Text style={styles.body}>
        Your church's admins and chat admins can mark a message urgent. An urgent message reaches
        you even during your quiet hours.
      </Text>
      <SectionHeader title={Platform.OS === 'ios' ? 'On this iPhone' : 'On this phone'} />
      <View style={styles.action}>
        <Button label="Open settings" onPress={openSettings} />
      </View>
      {Platform.OS === 'ios' ? (
        <>
          <SectionFooter
            text={
              'To let it through Focus as well, open Settings, then Notifications, then Phon, and turn on Time Sensitive Notifications.'
            }
          />
          <SectionFooter
            text={
              'Then, in Settings, open Focus, and for each Focus you use, add Phon to the apps allowed to notify you, or allow Time Sensitive notifications.'
            }
          />
        </>
      ) : (
        <SectionFooter
          text={`To let it through Do Not Disturb as well, open Phon's notification settings, choose the "${URGENT_CHANNEL_NAME}" category, and turn on Override Do Not Disturb.`}
        />
      )}
      {settingsFailed && (
        <SectionFooter
          tone="error"
          live
          text={'Settings could not be opened. Open them from the home screen.'}
        />
      )}
      <View style={styles.laterGroup}>
        <View style={styles.action}>
          <Button label="Done" variant="secondary" onPress={() => void done()} />
        </View>
      </View>
    </ScrollView>
  )
}

/**
 * The screen scrolls, so at the largest text size its rows are never cut off. The header above it
 * keeps it out of the status bar, and the scroll view's automatic inset keeps the last row out of
 * the home indicator. The title and first paragraph sit on the page, lined up with the groups'
 * headers.
 */
function stylesFor(tokens: ThemeTokens) {
  return StyleSheet.create({
    page: { backgroundColor: tokens[ONE_TIME_SCREEN_COLOURS.surface] },
    content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
    title: {
      color: tokens[ONE_TIME_SCREEN_COLOURS.text],
      fontSize: tokens.type.title1,
      fontWeight: '700',
      paddingHorizontal: tokens.spacing.xxl,
      marginTop: tokens.spacing.xl,
    },
    body: {
      color: tokens[ONE_TIME_SCREEN_COLOURS.text],
      fontSize: tokens.type.body,
      paddingHorizontal: tokens.spacing.xxl,
      marginTop: tokens.spacing.md,
    },
    laterGroup: { marginTop: tokens.spacing.xl },
    action: { marginHorizontal: tokens.spacing.lg },
  })
}
