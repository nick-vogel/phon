import { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { acknowledgeNotice } from '../src/oversight-notice'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { ONE_TIME_SCREEN_COLOURS } from '../src/ui/screen-colours'
import { headerlessPadding, type VerticalInsets } from '../src/ui/screen-padding'

/**
 * The oversight notice, shown once to every person before their first channel. Its button records
 * with the server that they saw it, and the layout's guards then show the channel list.
 */
export default function OversightNotice() {
  const { tokens } = useTheme()
  const { top, bottom } = useSafeAreaInsets()
  const styles = useMemo(() => stylesFor(tokens, { top, bottom }), [tokens, top, bottom])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const acknowledge = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await acknowledgeNotice()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <View style={styles.frame}>
      <ScrollView contentContainerStyle={styles.screen}>
        <View style={styles.column}>
          <Text style={styles.title} accessibilityRole="header">
            Before you start
          </Text>
          <Text style={styles.body}>
            Your church's admins can read every channel in Phon, including private channels, and
            they can see messages that were deleted.
          </Text>
          <Text style={styles.body}>
            When an admin opens a private channel they are not in, Phon records it, and the other
            admins can see that record.
          </Text>
          <Button label="I understand" busy={busy} onPress={() => void acknowledge()} />
          {failed && (
            <Text style={styles.failed} accessibilityLiveRegion="polite">
              That did not go through. Please try again.
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

/**
 * The notice scrolls, so at the largest text size its button is never cut off; at the default size
 * its column sits in the middle. The screen has no header, so it keeps itself out of the status
 * bar and the home indicator.
 */
function stylesFor(tokens: ThemeTokens, insets: VerticalInsets) {
  const padding = headerlessPadding(tokens.spacing.xl, insets)
  return StyleSheet.create({
    frame: { flex: 1, backgroundColor: tokens[ONE_TIME_SCREEN_COLOURS.surface], ...padding.frame },
    screen: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', ...padding.content },
    column: { width: '100%', maxWidth: 400, gap: tokens.spacing.lg },
    title: {
      color: tokens[ONE_TIME_SCREEN_COLOURS.text],
      fontSize: tokens.type.title1,
      fontWeight: '700',
    },
    body: { color: tokens[ONE_TIME_SCREEN_COLOURS.text], fontSize: tokens.type.body },
    failed: { color: tokens[ONE_TIME_SCREEN_COLOURS.failed], fontSize: tokens.type.subheadline },
  })
}
