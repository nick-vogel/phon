import { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'
import { connectSyncAccount } from '../src/api/sign-in'
import type { SyncConnectOutcome } from '../src/api/sync-account'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { ONE_TIME_SCREEN_COLOURS } from '../src/ui/screen-colours'

type Outcome = SyncConnectOutcome | 'cancelled'

/** What the screen says after a connect, in plain words. */
const OUTCOME_TEXT: Record<Outcome, string> = {
  connected:
    "The sync account is connected. Phon reads your church's teams from Planning Center on its next roster sync, within 15 minutes, and your volunteers can sign in after that.",
  'not-administrator':
    'That Planning Center account is not an organization administrator. Only an organization administrator can connect the sync account.',
  cancelled: 'Connecting was cancelled.',
  failed: 'Could not connect the sync account. Please try again.',
}

/**
 * The screen that connects the church's sync account, reachable signed out: nobody is known to
 * Phon before the first roster sync. It plays the Planning Center connect flow and says what came
 * of it. It saves no session, because the sync account is the church's, not a person who chats.
 */
export default function Connect() {
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const connect = async () => {
    setBusy(true)
    setOutcome(null)
    setOutcome(await connectSyncAccount().catch((): Outcome => 'failed'))
    setBusy(false)
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading} accessibilityRole="header">
        Connect your church's sync account
      </Text>
      <Text style={styles.body}>
        Phon keeps its channels in step with your church's teams in Planning Center. It reads them
        with one account, the sync account: a dedicated Planning Center account on a church email
        address, not a person's own login.
      </Text>
      <Text style={styles.body}>
        The sync account has to be a Planning Center organization administrator, with administrator
        permission in People, Services and Groups.
      </Text>
      <Text style={styles.note}>
        Planning Center will ask you to sign in. Sign in as the sync account, and allow Phon when it
        asks.
      </Text>
      <Button label="Connect the sync account" busy={busy} onPress={connect} />
      {outcome !== null && (
        <Text style={styles.outcome} accessibilityLiveRegion="polite">
          {OUTCOME_TEXT[outcome]}
        </Text>
      )}
    </ScrollView>
  )
}

/**
 * The screen scrolls, so at the largest text size the outcome is never cut off. The header above it
 * keeps it out of the status bar, and the scroll view's automatic inset keeps the end of it out of
 * the home indicator.
 */
function stylesFor(tokens: ThemeTokens) {
  return StyleSheet.create({
    page: { backgroundColor: tokens[ONE_TIME_SCREEN_COLOURS.surface] },
    screen: { flexGrow: 1, padding: tokens.spacing.xl, gap: tokens.spacing.lg },
    heading: {
      color: tokens[ONE_TIME_SCREEN_COLOURS.text],
      fontSize: tokens.type.title2,
      fontWeight: '700',
    },
    body: { color: tokens[ONE_TIME_SCREEN_COLOURS.text], fontSize: tokens.type.body },
    note: { color: tokens[ONE_TIME_SCREEN_COLOURS.note], fontSize: tokens.type.subheadline },
    outcome: { color: tokens[ONE_TIME_SCREEN_COLOURS.text], fontSize: tokens.type.body },
  })
}
