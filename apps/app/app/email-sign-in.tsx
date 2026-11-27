import type { ConnectedChurch } from '@phon/api-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { NameChoicePerson } from '../src/api/email-sign-in'
import {
  churchesForEmailSignIn,
  sendEmailCode,
  signInAsChosenPerson,
  signInWithEmailCode,
} from '../src/api/sign-in'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { TextField } from '../src/ui/text-field'

/** What the code step says once a code was asked for, whatever the address. */
const SENT_TEXT = "If this address is on your church's Planning Center profile, we sent it a code."
const TRY_AGAIN_TEXT = 'Something went wrong. Try again.'
const WRONG_CODE_TEXT = 'That code did not work. Check it, or send a new code.'
const START_OVER_TEXT = 'That sign-in ran out. Send a new code.'
const WAIT_TEXT = 'Too many tries from this network. Wait a minute, then try again.'

type Step =
  | { step: 'church' }
  | { step: 'address'; church: ConnectedChurch }
  | { step: 'code'; church: ConnectedChurch; address: string }
  | {
      step: 'name'
      church: ConnectedChurch
      address: string
      choiceToken: string
      people: NameChoicePerson[]
    }

type Churches =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'wait' }
  | { state: 'loaded'; churches: ConnectedChurch[] }

/**
 * The email code sign-in, for a person whose only Planning Center login is Church Center: pick the
 * church, enter the address on its Planning Center profile, then the 6-digit code from the email.
 * A right code saves the session, and the layout's guards then take over. When several people
 * share the address, a right code shows their names first, and the person picks their own.
 */
export default function EmailSignIn() {
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])
  const [step, setStep] = useState<Step>({ step: 'church' })
  const [churches, setChurches] = useState<Churches>({ state: 'loading' })
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadChurches = useCallback(() => {
    setChurches({ state: 'loading' })
    churchesForEmailSignIn()
      .then((listed) =>
        setChurches(
          listed.outcome === 'listed'
            ? { state: 'loaded', churches: listed.churches }
            : listed.outcome === 'wait'
              ? { state: 'wait' }
              : { state: 'failed' },
        ),
      )
      .catch(() => setChurches({ state: 'failed' }))
  }, [])

  useEffect(loadChurches, [loadChurches])

  const send = async (church: ConnectedChurch, to: string) => {
    setBusy(true)
    setNotice(null)
    const sent = await sendEmailCode({ churchId: church.churchId, address: to }).catch(
      () => ({ outcome: 'try-again' }) as const,
    )
    setBusy(false)
    if (sent.outcome === 'sent') {
      setCode('')
      setStep({ step: 'code', church, address: to })
      setNotice(SENT_TEXT)
    } else {
      setNotice(sent.outcome === 'wait' ? WAIT_TEXT : TRY_AGAIN_TEXT)
    }
  }

  const check = async (church: ConnectedChurch, to: string) => {
    setBusy(true)
    setNotice(null)
    const outcome = await signInWithEmailCode({
      churchId: church.churchId,
      address: to,
      code,
    }).catch(() => 'try-again' as const)
    setBusy(false)
    if (outcome === 'wrong-code') setNotice(WRONG_CODE_TEXT)
    else if (outcome === 'wait') setNotice(WAIT_TEXT)
    else if (outcome === 'try-again') setNotice(TRY_AGAIN_TEXT)
    else if (outcome !== 'signed-in') {
      setCode('')
      setStep({
        step: 'name',
        church,
        address: to,
        choiceToken: outcome.choiceToken,
        people: outcome.people,
      })
    }
  }

  const choose = async (
    church: ConnectedChurch,
    to: string,
    choiceToken: string,
    personId: string,
  ) => {
    setBusy(true)
    setNotice(null)
    const outcome = await signInAsChosenPerson({
      churchId: church.churchId,
      choiceToken,
      personId,
    }).catch(() => 'try-again' as const)
    setBusy(false)
    if (outcome === 'start-over') {
      setCode('')
      setStep({ step: 'code', church, address: to })
      setNotice(START_OVER_TEXT)
    } else if (outcome === 'wait') {
      setNotice(WAIT_TEXT)
    } else if (outcome === 'try-again') {
      setNotice(TRY_AGAIN_TEXT)
    }
  }

  const goTo = (next: Step) => {
    setNotice(null)
    setStep(next)
  }

  if (step.step === 'church') {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.screen}>
        <Text style={styles.heading} accessibilityRole="header">
          Pick your church
        </Text>
        {churches.state === 'loading' && <ActivityIndicator color={tokens.mutedForeground} />}
        {(churches.state === 'failed' || churches.state === 'wait') && (
          <>
            <Text style={styles.note}>
              {churches.state === 'wait' ? WAIT_TEXT : TRY_AGAIN_TEXT}
            </Text>
            <Button label="Try again" variant="plain" onPress={loadChurches} />
          </>
        )}
        {churches.state === 'loaded' && churches.churches.length === 0 && (
          <Text style={styles.note}>No church is connected to Phon yet.</Text>
        )}
        {churches.state === 'loaded' &&
          churches.churches.map((church) => (
            <Button
              key={church.churchId}
              label={church.name}
              variant="secondary"
              align="start"
              onPress={() => goTo({ step: 'address', church })}
            />
          ))}
      </ScrollView>
    )
  }

  if (step.step === 'address') {
    const to = address.trim()
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.screen}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.heading} accessibilityRole="header">
          {step.church.name}
        </Text>
        <Text style={styles.body}>
          Enter the email address on your Planning Center profile. We will send it a sign-in code.
        </Text>
        <TextField
          accessibilityLabel="Email address"
          value={address}
          onChangeText={setAddress}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          placeholder="you@example.com"
          returnKeyType="send"
          onSubmitEditing={() => to !== '' && !busy && send(step.church, to)}
        />
        <Button
          label="Send a code"
          busy={busy}
          disabled={to === ''}
          onPress={() => send(step.church, to)}
        />
        {notice !== null && <Text style={styles.note}>{notice}</Text>}
        <Button
          label="Pick a different church"
          variant="plain"
          disabled={busy}
          onPress={() => goTo({ step: 'church' })}
        />
      </ScrollView>
    )
  }

  if (step.step === 'name') {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.screen}>
        <Text style={styles.heading} accessibilityRole="header">
          Who is signing in?
        </Text>
        <Text style={styles.body}>More than one person uses this address. Pick your name.</Text>
        {step.people.map((person) => (
          <Button
            key={person.personId}
            label={person.name}
            variant="secondary"
            align="start"
            disabled={busy}
            onPress={() => choose(step.church, step.address, step.choiceToken, person.personId)}
          />
        ))}
        {busy && <ActivityIndicator color={tokens.mutedForeground} />}
        {notice !== null && <Text style={styles.note}>{notice}</Text>}
        <Button
          label="Send a new code"
          variant="plain"
          disabled={busy}
          onPress={() => send(step.church, step.address)}
        />
      </ScrollView>
    )
  }

  const complete = /^\d{6}$/.test(code)
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Text style={styles.heading} accessibilityRole="header">
        Enter your code
      </Text>
      <Text style={styles.body}>{step.address}</Text>
      <TextField
        accessibilityLabel="Sign-in code"
        value={code}
        onChangeText={(text) => setCode(text.replace(/\D/g, ''))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="123456"
        style={styles.codeInput}
      />
      <Button
        label="Sign in"
        busy={busy}
        disabled={!complete}
        onPress={() => check(step.church, step.address)}
      />
      {notice !== null && <Text style={styles.note}>{notice}</Text>}
      <View style={styles.links}>
        <Button
          label="Send a new code"
          variant="plain"
          disabled={busy}
          onPress={() => send(step.church, step.address)}
        />
        <Button
          label="Use a different address"
          variant="plain"
          disabled={busy}
          onPress={() => goTo({ step: 'address', church: step.church })}
        />
      </View>
    </ScrollView>
  )
}

/**
 * Each step scrolls on the background, so at the largest text size nothing is cut off; the address
 * and code steps also move their buttons above the keyboard.
 */
function stylesFor(tokens: ThemeTokens) {
  return StyleSheet.create({
    scroll: { backgroundColor: tokens.background },
    screen: { flexGrow: 1, padding: tokens.spacing.xl, gap: tokens.spacing.lg },
    heading: { color: tokens.foreground, fontSize: tokens.type.title2, fontWeight: '700' },
    body: { color: tokens.foreground, fontSize: tokens.type.body },
    note: { color: tokens.foreground, fontSize: tokens.type.subheadline },
    codeInput: {
      fontSize: tokens.type.title2,
      letterSpacing: 6,
      fontVariant: ['tabular-nums'],
    },
    links: { gap: tokens.spacing.xs },
  })
}
