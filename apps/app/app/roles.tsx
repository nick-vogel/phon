import type { Person, Role } from '@phon/api-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { endSessions, getPeople, ServerError, setRole } from '../src/api/client'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { ListRow } from '../src/ui/list-row'
import { SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter, SectionHeader } from '../src/ui/section-header'

/** How each role reads on screen. */
const ROLE_LABELS: Record<Role, string> = {
  member: 'Member',
  'chat-admin': 'Chat admin',
  admin: 'Admin',
}
const ROLES: Role[] = ['member', 'chat-admin', 'admin']

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; people: Person[] }
  | { state: 'failed'; message: string }

/** What the last change came to: a done line, or a failure line. */
type Notice = { text: string; failed: boolean }

/**
 * The admin's roles screen: everyone in the church with their role, a choice of member, chat
 * admin or admin for each, and a way to sign each one out on every phone, for a lost or shared
 * phone. The server decides whether a change is allowed, and the screen shows its refusal.
 */
export default function Roles() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'loaded', people: (await getPeople()).people })
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

  const choose = async (person: Person, role: Role) => {
    if (role === person.role) return
    setBusy(person.personId)
    setNotice(null)
    try {
      await setRole(person.personId, role)
      await refresh()
    } catch (error) {
      setNotice({ text: describeChange(error, person), failed: true })
    }
    setBusy(null)
  }

  const signOutEverywhere = async (person: Person) => {
    setBusy(person.personId)
    setNotice(null)
    try {
      await endSessions(person.personId)
      setNotice({ text: `${person.name} is signed out on every phone.`, failed: false })
    } catch (error) {
      setNotice({ text: describeSignOut(error, person), failed: true })
    }
    setBusy(null)
  }

  const confirmSignOut = (person: Person) => {
    Alert.alert(`Sign out ${person.name} on every phone?`, 'They will need to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => void signOutEverywhere(person),
      },
    ])
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
          <SectionFooter text="Loading people" />
        </View>
      )}
      {load.state === 'failed' && (
        <View style={styles.top}>
          <SectionFooter text={load.message} />
        </View>
      )}
      {load.state === 'loaded' &&
        load.people.map((person) => (
          <View key={person.personId}>
            <SectionHeader title={person.name} />
            {ROLES.map((role, index) => (
              <ListRow
                key={role}
                title={ROLE_LABELS[role]}
                accessibilityLabel={`${ROLE_LABELS[role]} for ${person.name}`}
                checked={person.role === role}
                disabled={busy !== null}
                onPress={() => void choose(person, role)}
                first={index === 0}
              />
            ))}
            <ListRow
              title="Sign out everywhere"
              accessibilityLabel={`Sign out ${person.name} everywhere`}
              destructive
              disabled={busy !== null}
              onPress={() => confirmSignOut(person)}
              last
            />
          </View>
        ))}
    </ScrollView>
  )
}

function describeLoad(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can see and change roles.'
  }
  return 'People could not be loaded. Pull down to try again.'
}

function describeChange(error: unknown, person: Person): string {
  if (error instanceof ServerError && error.problem === 'conflict') {
    return `${person.name} is the church's only admin. Make someone else an admin first.`
  }
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can change roles.'
  }
  return `${person.name}'s role could not be changed. Please try again.`
}

function describeSignOut(error: unknown, person: Person): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can sign people out.'
  }
  if (error instanceof ServerError && error.problem === 'not-found') {
    return `${person.name} is no longer in the church's directory.`
  }
  return `${person.name} could not be signed out. Please try again.`
}

/** The page under the groups, which scrolls and pulls to refresh. */
function stylesFor(tokens: ThemeTokens) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: tokens[SECTION_COLOURS.surface] },
    content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
    top: { marginTop: tokens.spacing.sm },
  })
}
