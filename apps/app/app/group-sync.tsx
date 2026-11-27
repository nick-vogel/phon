import type { GroupType } from '@phon/api-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native'
import { getGroupTypes, ServerError, setGroupTypeSync } from '../src/api/client'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { ListRow } from '../src/ui/list-row'
import { SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter } from '../src/ui/section-header'

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; groupTypes: GroupType[] }
  | { state: 'failed'; message: string }

/**
 * The admin's Group sync screen: each Planning Center Group type with a switch. A type that is
 * on gives each of its Groups a small group channel, which opens once the Group has three
 * members. The server decides whether a change is allowed, and the screen shows its refusal.
 */
export default function GroupSync() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'loaded', groupTypes: (await getGroupTypes()).groupTypes })
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

  const toggle = async (groupType: GroupType, enabled: boolean) => {
    setBusy(groupType.id)
    setNotice(null)
    try {
      await setGroupTypeSync(groupType.id, enabled)
      await refresh()
    } catch (error) {
      setNotice(describeChange(error, groupType))
    }
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
      <View style={styles.top}>
        <SectionFooter
          text={
            "Turn on a Group type to give each of its Groups a channel. A Group's channel opens once it has three members. A change takes effect at the next sync with Planning Center, within 15 minutes."
          }
        />
      </View>
      {notice !== null && (
        <View style={styles.top}>
          <SectionFooter tone="error" live text={notice} />
        </View>
      )}
      {load.state === 'loading' && (
        <View style={styles.top}>
          <SectionFooter text={'Loading Group types'} />
        </View>
      )}
      {load.state === 'failed' && (
        <View style={styles.top}>
          <SectionFooter text={load.message} />
        </View>
      )}
      {load.state === 'loaded' && load.groupTypes.length === 0 && (
        <View style={styles.top}>
          <SectionFooter
            text={
              'No Group types yet. They show here after the first sync with Planning Center has run.'
            }
          />
        </View>
      )}
      {load.state === 'loaded' && load.groupTypes.length > 0 && (
        <View style={styles.group}>
          {load.groupTypes.map((groupType, index) => (
            <ListRow
              key={groupType.id}
              title={groupType.name}
              first={index === 0}
              last={index === load.groupTypes.length - 1}
              trailing={
                <Switch
                  accessibilityLabel={`Sync ${groupType.name}`}
                  value={groupType.syncEnabled}
                  disabled={busy !== null}
                  onValueChange={(enabled) => void toggle(groupType, enabled)}
                />
              }
            />
          ))}
        </View>
      )}
    </ScrollView>
  )
}

function describeLoad(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can see and change Group sync.'
  }
  return 'Group types could not be loaded. Pull down to try again.'
}

function describeChange(error: unknown, groupType: GroupType): string {
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'Only admins can change Group sync.'
  }
  if (error instanceof ServerError && error.problem === 'not-found') {
    return `${groupType.name} is no longer in Planning Center. Pull down to refresh.`
  }
  return `Sync for ${groupType.name} could not be changed. Please try again.`
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
