import type { OversightView } from '@phon/api-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { getOversightLog, ServerError } from '../src/api/client'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { ListRow } from '../src/ui/list-row'
import { SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter } from '../src/ui/section-header'

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; views: OversightView[] }
  | { state: 'failed'; message: string }

/**
 * The admins' oversight log: each time an admin opened a private channel they are not in, newest
 * first, as the server sends it.
 */
export default function OversightLog() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'loaded', views: (await getOversightLog()).views })
    } catch (error) {
      setLoad({ state: 'failed', message: describe(error) })
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
      {load.state === 'loading' && (
        <View style={styles.top}>
          <SectionFooter text={'Loading the log'} />
        </View>
      )}
      {load.state === 'failed' && (
        <View style={styles.top}>
          <SectionFooter text={load.message} />
        </View>
      )}
      {load.state === 'loaded' && load.views.length === 0 && (
        <View style={styles.top}>
          <SectionFooter text={'No admin has opened a private channel they are not in.'} />
        </View>
      )}
      {load.state === 'loaded' && load.views.length > 0 && (
        <View style={styles.group}>
          {load.views.map((view, index) => (
            <ListRow
              key={view.viewId}
              title={`${view.adminName} opened # ${view.channelName}`}
              subtitle={new Date(view.openedAt).toLocaleString()}
              first={index === 0}
              last={index === load.views.length - 1}
            />
          ))}
        </View>
      )}
    </ScrollView>
  )
}

function describe(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can see the oversight log.'
  }
  return 'The log could not be loaded. Pull down to try again.'
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
