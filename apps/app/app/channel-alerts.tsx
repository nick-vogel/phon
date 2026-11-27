import type { AlertLevel, ChannelAlerts } from '@phon/api-types'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet } from 'react-native'
import { getChannelAlerts, ServerError, setChannelAlertLevel } from '../src/api/client'
import { useTheme } from '../src/theme/use-theme'
import { ListRow } from '../src/ui/list-row'
import { SectionFooter, SectionHeader } from '../src/ui/section-header'

/** How each alert level reads on the screen. */
const LABELS: Record<AlertLevel, string> = {
  'every-message': 'Every message',
  'mentions-and-team-announcements': '@mentions and team announcements',
  mentions: '@mentions only',
  off: 'Off',
}

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; alerts: ChannelAlerts }
  | { state: 'failed'; message: string }

/**
 * One channel's alert level for the signed-in person, as one group of choices with a check mark on
 * the chosen one. It shows the level and the choices the server sends, and after a pick shows
 * what the server answers. The server holds every rule.
 */
export default function ChannelAlertsScreen() {
  const { channelId, name } = useLocalSearchParams<{ channelId: string; name?: string }>()
  const navigation = useNavigation()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [saving, setSaving] = useState(false)
  const { tokens } = useTheme()
  const styles = useMemo(
    () =>
      StyleSheet.create({
        page: { backgroundColor: tokens.background },
        content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
      }),
    [tokens],
  )

  useLayoutEffect(() => {
    navigation.setOptions({ title: `Alerts for # ${name ?? channelId}` })
  }, [navigation, name, channelId])

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'loaded', alerts: await getChannelAlerts(channelId) })
    } catch (error) {
      setLoad({ state: 'failed', message: describe(error) })
    }
  }, [channelId])

  useEffect(() => {
    setLoad({ state: 'loading' })
    void refresh()
  }, [refresh])

  const pick = useCallback(
    async (level: AlertLevel) => {
      setSaving(true)
      try {
        await setChannelAlertLevel(channelId, level)
        await refresh()
      } catch (error) {
        setLoad({ state: 'failed', message: describe(error) })
      } finally {
        setSaving(false)
      }
    },
    [channelId, refresh],
  )

  const { choices, level } =
    load.state === 'loaded' ? load.alerts : { choices: [] as AlertLevel[], level: null }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SectionHeader title="Alert level" />
      {choices.map((choice, index) => (
        <ListRow
          key={choice}
          title={LABELS[choice]}
          checked={choice === level}
          disabled={saving}
          onPress={() => void pick(choice)}
          first={index === 0}
          last={index === choices.length - 1}
        />
      ))}
      {load.state === 'loading' && <SectionFooter text={'Loading the alert level'} />}
      {load.state === 'failed' && <SectionFooter tone="error" live text={load.message} />}
      {load.state === 'loaded' && choices.length === 0 && (
        <SectionFooter text={'Announcements always alert you.'} />
      )}
    </ScrollView>
  )
}

function describe(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'not-found') {
    return 'This channel is not available.'
  }
  if (error instanceof ServerError && error.problem === 'not-allowed') {
    return 'You get no alerts from this channel, so there is nothing to set.'
  }
  return 'The alert level could not be loaded or saved. Try again.'
}
