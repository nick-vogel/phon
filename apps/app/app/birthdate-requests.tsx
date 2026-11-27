import type { BirthdateRequest } from '@phon/api-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import {
  approveBirthdate,
  declineBirthdate,
  getBirthdateRequests,
  ServerError,
} from '../src/api/client'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { ListRow } from '../src/ui/list-row'
import { SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter } from '../src/ui/section-header'

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; requests: BirthdateRequest[] }
  | { state: 'failed'; message: string }

/** What the last choice came to: a done line, or a failure line. */
type Notice = { text: string; failed: boolean }

/**
 * The admin's approval screen: every self-entered birthdate that makes the person 18 or older,
 * oldest first, with Approve and Decline. An approved birthdate is added to the person's Planning
 * Center profile. The list loads again after each choice, and the server decides who may choose.
 */
export default function BirthdateRequests() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'loaded', requests: (await getBirthdateRequests()).requests })
    } catch (error) {
      setLoad({ state: 'failed', message: describeLoad(error) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  const decide = async (request: BirthdateRequest, approve: boolean) => {
    setBusy(request.personId)
    setNotice(null)
    try {
      if (approve) await approveBirthdate(request.personId)
      else await declineBirthdate(request.personId)
      setNotice({
        text: approve ? `Approved for ${request.name}.` : `Declined for ${request.name}.`,
        failed: false,
      })
    } catch (error) {
      setNotice({ text: describeDecision(error, request), failed: true })
    }
    await refresh()
    setBusy(null)
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={tokens[SECTION_COLOURS.note]}
        />
      }
    >
      {notice !== null && (
        <View style={styles.top}>
          <SectionFooter tone={notice.failed ? 'error' : 'note'} live text={notice.text} />
        </View>
      )}
      {load.state === 'loading' && (
        <View style={styles.top}>
          <SectionFooter text={'Loading requests'} />
        </View>
      )}
      {load.state === 'failed' && (
        <View style={styles.top}>
          <SectionFooter text={load.message} />
        </View>
      )}
      {load.state === 'loaded' && load.requests.length === 0 && (
        <View style={styles.top}>
          <SectionFooter text={'No birthdates are waiting for approval.'} />
        </View>
      )}
      {load.state === 'loaded' &&
        load.requests.map((request) => (
          <View key={request.personId} style={styles.group}>
            <ListRow title={request.name} subtitle={`Entered ${request.birthdate}`} first />
            <ListRow
              title="Approve"
              accessibilityLabel={`Approve ${request.name}'s birthdate`}
              action
              disabled={busy !== null}
              onPress={() => void decide(request, true)}
            />
            <ListRow
              title="Decline"
              accessibilityLabel={`Decline ${request.name}'s birthdate`}
              destructive
              disabled={busy !== null}
              onPress={() => void decide(request, false)}
              last
            />
          </View>
        ))}
    </ScrollView>
  )
}

function describeLoad(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can approve birthdates.'
  }
  return 'Requests could not be loaded. Pull down to try again.'
}

function describeDecision(error: unknown, request: BirthdateRequest): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Another admin approves your own birthdate.'
  }
  if (error instanceof ServerError && error.problem === 'not-found') {
    return `${request.name}'s request is no longer waiting.`
  }
  return `${request.name}'s birthdate could not be saved to Planning Center. Try again.`
}

/** The page under the groups, which scrolls and pulls to refresh. */
function stylesFor(tokens: ThemeTokens) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: tokens[SECTION_COLOURS.surface] },
    content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
    top: { marginTop: tokens.spacing.sm },
    group: { marginTop: tokens.spacing.xl },
  })
}
