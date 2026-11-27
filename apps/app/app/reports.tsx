import type { Report } from '@phon/api-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { closeReport, getReports, ServerError } from '../src/api/client'
import { reportRows } from '../src/report-rows'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { ListRow } from '../src/ui/list-row'
import { SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter, SectionHeader } from '../src/ui/section-header'

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; reports: Report[] }
  | { state: 'failed'; message: string }

/**
 * The open reports, newest first, as the server sends them to an admin or chat admin: the channel,
 * the reported message and its author, who reported it and when. An admin sees a message removed
 * since, marked; a chat admin is told it has since been deleted. Close report takes a report off
 * the list for everyone.
 */
export default function Reports() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'loaded', reports: (await getReports()).reports })
    } catch (error) {
      setLoad({ state: 'failed', message: describe(error) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    setNotice(null)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  const onClose = useCallback(
    async (reportId: string) => {
      setNotice(null)
      try {
        await closeReport(reportId)
      } catch {
        setNotice('The report could not be closed. Try again.')
      }
      await refresh()
    },
    [refresh],
  )

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
          <SectionFooter tone="error" live text={notice} />
        </View>
      )}
      {load.state === 'loading' && (
        <View style={styles.top}>
          <SectionFooter text={'Loading reports'} />
        </View>
      )}
      {load.state === 'failed' && (
        <View style={styles.top}>
          <SectionFooter text={load.message} />
        </View>
      )}
      {load.state === 'loaded' && load.reports.length === 0 && (
        <View style={styles.top}>
          <SectionFooter text={'No open reports.'} />
        </View>
      )}
      {load.state === 'loaded' &&
        load.reports.map((report) => {
          const rows = reportRows(report)
          return (
            <View key={report.reportId}>
              <SectionHeader title={`# ${report.channelName}`} />
              <ListRow
                title={rows.message.title}
                subtitle={rows.message.subtitle ?? undefined}
                first
              />
              <ListRow title={rows.reported.title} subtitle={rows.reported.subtitle} />
              <ListRow
                title="Close report"
                accessibilityLabel={`Close the report on ${report.authorName}'s message`}
                action
                onPress={() => void onClose(report.reportId)}
                last
              />
            </View>
          )
        })}
    </ScrollView>
  )
}

function describe(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins and chat admins can see reports.'
  }
  return 'Reports could not be loaded. Pull down to try again.'
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
