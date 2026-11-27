import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { getPeopleWithoutBirthdate, ServerError } from '../src/api/client'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { ListRow } from '../src/ui/list-row'
import { SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter } from '../src/ui/section-header'

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; people: Array<{ personId: string; name: string }> }
  | { state: 'failed'; message: string }

/**
 * The admin's list of every person in the church with no birthdate on file, sorted by name. Phon
 * treats each of them as a minor until a birthdate is added in Planning Center.
 */
export default function MissingBirthdates() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'loaded', people: (await getPeopleWithoutBirthdate()).people })
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
      <View style={styles.top}>
        <SectionFooter
          text={
            'Phon treats these people as minors until they have a birthdate. Add it to their profile in Planning Center, and they leave this list after the next sync.'
          }
        />
      </View>
      {load.state === 'loading' && (
        <View style={styles.top}>
          <SectionFooter text={'Loading people'} />
        </View>
      )}
      {load.state === 'failed' && (
        <View style={styles.top}>
          <SectionFooter text={load.message} />
        </View>
      )}
      {load.state === 'loaded' && load.people.length === 0 && (
        <View style={styles.top}>
          <SectionFooter text={'Everyone has a birthdate on file.'} />
        </View>
      )}
      {load.state === 'loaded' && load.people.length > 0 && (
        <View style={styles.group}>
          {load.people.map((person, index) => (
            <ListRow
              key={person.personId}
              title={person.name}
              first={index === 0}
              last={index === load.people.length - 1}
            />
          ))}
        </View>
      )}
    </ScrollView>
  )
}

function describeLoad(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can see who has no birthdate.'
  }
  return 'People could not be loaded. Pull down to try again.'
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
