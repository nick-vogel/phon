import type { QuietHours } from '@phon/api-types'
import { getCalendars } from 'expo-localization'
import { type LucideIcon, Minus, Plus } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native'
import { getQuietHours, ServerError, setQuietHours } from '../src/api/client'
import { showClock, stepClock } from '../src/clock'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { ListRow } from '../src/ui/list-row'
import { LIST_ROW_COLOURS, SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter, SectionHeader } from '../src/ui/section-header'

/** The window a person starts from when they turn quiet hours on. */
const DEFAULT_WINDOW = { start: '22:00', end: '07:00' }

/** How far one tap moves a time. */
const STEP_MINUTES = 30

/** The notice after a save the server took. Every other notice is a failure line. */
const SAVED = 'Saved.'

type Load =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; saved: QuietHours | null }

/**
 * The signed-in person's quiet hours: off, or one daily window in this phone's time zone, during
 * which nothing pushes to them but an urgent message. The phone's zone goes with every save, and
 * after a save the screen shows what the server answers, not what was sent.
 */
export default function QuietHoursScreen() {
  const calendar = getCalendars()[0]
  const timeZone = calendar?.timeZone ?? null
  const uses24hourClock = calendar?.uses24hourClock ?? null
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [on, setOn] = useState(false)
  const [window, setWindow] = useState(DEFAULT_WINDOW)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  // Shows what the server holds, the switch and the times included.
  const show = useCallback((saved: QuietHours | null) => {
    setLoad({ state: 'loaded', saved })
    setOn(saved !== null)
    if (saved !== null) setWindow({ start: saved.start, end: saved.end })
  }, [])

  useEffect(() => {
    getQuietHours()
      .then((setting) => show(setting.quietHours))
      .catch(() => setLoad({ state: 'failed' }))
  }, [show])

  const save = async () => {
    if (timeZone === null) return
    setSaving(true)
    setNotice(null)
    try {
      await setQuietHours(on ? { ...window, timeZone } : null)
      const setting = await getQuietHours()
      show(setting.quietHours)
      setNotice(SAVED)
    } catch (error) {
      setNotice(
        error instanceof ServerError && error.problem === 'invalid'
          ? 'Quiet hours need a start and an end that are not the same time.'
          : 'Quiet hours could not be saved. Try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  if (load.state === 'loading') {
    return (
      <View style={[styles.page, styles.centered]}>
        <ActivityIndicator color={tokens[SECTION_COLOURS.note]} />
      </View>
    )
  }
  if (load.state === 'failed') {
    return (
      <View style={[styles.page, styles.centered]}>
        <Text style={styles.note}>Quiet hours could not be loaded. Open this screen again.</Text>
      </View>
    )
  }
  if (timeZone === null) {
    return (
      <View style={[styles.page, styles.centered]}>
        <Text style={styles.note}>
          Quiet hours cannot be set on this phone, because it does not report its time zone.
        </Text>
      </View>
    )
  }

  const step = (label: string, key: 'start' | 'end', minutes: number, Glyph: LucideIcon) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${minutes < 0 ? 'earlier' : 'later'}`}
      onPress={() =>
        setWindow((current) => ({ ...current, [key]: stepClock(current[key], minutes) }))
      }
      style={({ pressed }) => [styles.step, pressed && styles.stepPressed]}
    >
      <Glyph color={tokens[LIST_ROW_COLOURS.action]} size={tokens.iconSize.md} strokeWidth={2.5} />
    </Pressable>
  )

  const stepper = (label: string, key: 'start' | 'end', last: boolean) => (
    <ListRow
      title={label}
      last={last}
      first={key === 'start'}
      trailing={
        <View style={styles.stepper}>
          {step(label, key, -STEP_MINUTES, Minus)}
          <Text style={styles.time}>{showClock(window[key], uses24hourClock)}</Text>
          {step(label, key, STEP_MINUTES, Plus)}
        </View>
      }
    />
  )

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.firstGroup}>
        <ListRow
          title="Quiet hours"
          first
          last
          trailing={<Switch value={on} onValueChange={setOn} accessibilityLabel="Quiet hours" />}
        />
        <SectionFooter
          text={
            'During quiet hours Phon sends you no alerts, announcements included. Only an urgent message from an admin or chat admin comes through. Everything else waits in its channel.'
          }
        />
      </View>
      {on && (
        <View>
          <SectionHeader title="Times" />
          {stepper('Start', 'start', false)}
          {stepper('End', 'end', true)}
          <SectionFooter text={`Times are in this phone's time zone, ${timeZone}.`} />
        </View>
      )}
      <View style={styles.laterGroup}>
        <View style={styles.action}>
          <Button label="Save" busy={saving} onPress={() => void save()} />
        </View>
        {notice !== null && (
          <SectionFooter tone={notice === SAVED ? 'note' : 'error'} live text={notice} />
        )}
        <SectionFooter text={describeSaved(load.saved, uses24hourClock)} />
      </View>
    </ScrollView>
  )
}

/** What the server holds, in words. */
function describeSaved(saved: QuietHours | null, uses24hourClock: boolean | null): string {
  if (saved === null) return 'Quiet hours are off.'
  const start = showClock(saved.start, uses24hourClock)
  const end = showClock(saved.end, uses24hourClock)
  return `Quiet hours are ${start} to ${end}, ${saved.timeZone} time.`
}

/**
 * The page under the groups, and the steppers: each step is the tap target square, and the time
 * between them keeps its width as the digits change, `10:00 PM` included. At the largest text
 * sizes the time wraps, so both steps stay on screen.
 */
function stylesFor(tokens: ThemeTokens) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: tokens[SECTION_COLOURS.surface] },
    content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
    centered: { alignItems: 'center', justifyContent: 'center', padding: tokens.spacing.xl },
    firstGroup: { marginTop: tokens.spacing.lg },
    laterGroup: { marginTop: tokens.spacing.xl },
    action: { marginHorizontal: tokens.spacing.lg },
    note: {
      color: tokens[SECTION_COLOURS.note],
      fontSize: tokens.type.body,
      textAlign: 'center',
    },
    stepper: { flexShrink: 1, flexDirection: 'row', alignItems: 'center' },
    step: {
      minWidth: tokens.minTapTarget,
      minHeight: tokens.minTapTarget,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: tokens.radius,
    },
    stepPressed: { backgroundColor: tokens[LIST_ROW_COLOURS.pressed] },
    time: {
      color: tokens[LIST_ROW_COLOURS.title],
      fontSize: tokens.type.body,
      fontVariant: ['tabular-nums'],
      textAlign: 'center',
      minWidth: tokens.minTapTarget * 2,
      flexShrink: 1,
    },
  })
}
