import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { type ConnectOutcome, connectChurch, type SignInOutcome, signIn } from '../src/api/sign-in'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { headerlessPadding, type VerticalInsets } from '../src/ui/screen-padding'

type Outcome = SignInOutcome | ConnectOutcome

/** What the screen says after a sign-in or a connect that did not finish. */
const OUTCOME_TEXT: Record<Exclude<Outcome, 'signed-in'>, string> = {
  'not-known':
    'Phon does not know you for this church yet. Ask your church to add you to a team in Planning Center. If you are a Planning Center administrator setting Phon up for your church, connect your church instead.',
  'not-administrator':
    'Only a Planning Center administrator of your church can connect it to Phon.',
  'already-connected':
    'Your church is already connected to Phon. Ask one of its admins to add you.',
  cancelled: 'Sign-in was cancelled.',
  failed: 'Could not sign in. Please try again.',
}

/**
 * The sign-in screen: the Planning Center sign-in first, and what came of it in plain words, then
 * always the email code sign-in for a person whose only login is Church Center, and the link to
 * connect the church's sync account. A finished sign-in saves the session, and the layout's guards
 * then show the channels.
 */
export default function SignIn() {
  const router = useRouter()
  const { tokens } = useTheme()
  const { top, bottom } = useSafeAreaInsets()
  const styles = useMemo(() => stylesFor(tokens, { top, bottom }), [tokens, top, bottom])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const run = async (flow: () => Promise<Outcome>) => {
    setBusy(true)
    setOutcome(null)
    const result = await flow().catch((): Outcome => 'failed')
    setOutcome(result)
    setBusy(false)
  }
  const start = () => run(signIn)
  const connect = () => run(connectChurch)

  return (
    <View style={styles.frame}>
      <ScrollView contentContainerStyle={styles.screen}>
        <View style={styles.column}>
          <Text style={styles.title} accessibilityRole="header">
            Phon
          </Text>
          <Text style={styles.lead}>Your church team chat</Text>
          <Button label="Sign in with Planning Center" busy={busy} onPress={start} />
          {outcome !== null && outcome !== 'signed-in' && (
            <Text style={styles.outcome}>{OUTCOME_TEXT[outcome]}</Text>
          )}
          {(outcome === 'not-known' || outcome === 'not-administrator') && (
            <Button label="Connect your church" variant="plain" disabled={busy} onPress={connect} />
          )}
          <Button
            label="Sign in with an email code"
            variant="plain"
            disabled={busy}
            onPress={() => router.navigate('/email-sign-in')}
          />
          <Button
            label="Connect your church's sync account"
            variant="plain"
            disabled={busy}
            onPress={() => router.navigate('/connect')}
          />
        </View>
      </ScrollView>
    </View>
  )
}

/**
 * The screen scrolls, so at the largest text size the outcome and the links below it are never cut
 * off; at the default size its column sits in the middle. The screen has no header, so it keeps
 * itself out of the status bar and the home indicator.
 */
function stylesFor(tokens: ThemeTokens, insets: VerticalInsets) {
  const padding = headerlessPadding(tokens.spacing.xl, insets)
  return StyleSheet.create({
    frame: { flex: 1, backgroundColor: tokens.background, ...padding.frame },
    screen: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', ...padding.content },
    column: { width: '100%', maxWidth: 400, gap: tokens.spacing.lg },
    title: {
      color: tokens.foreground,
      fontSize: tokens.type.largeTitle,
      fontWeight: '700',
      textAlign: 'center',
    },
    lead: {
      color: tokens.mutedForeground,
      fontSize: tokens.type.body,
      textAlign: 'center',
      marginBottom: tokens.spacing.lg,
    },
    outcome: {
      color: tokens.foreground,
      fontSize: tokens.type.subheadline,
      textAlign: 'center',
    },
  })
}
