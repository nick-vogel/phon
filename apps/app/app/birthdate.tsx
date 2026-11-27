import type { BirthdateStatus } from '@phon/api-types'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { getBirthdate, ServerError, setBirthdate } from '../src/api/client'
import { clearSession } from '../src/api/session'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { ListRow } from '../src/ui/list-row'
import { LIST_ROW_COLOURS, SECTION_COLOURS } from '../src/ui/list-row-colours'
import { ONE_TIME_SCREEN_COLOURS } from '../src/ui/screen-colours'
import { SectionFooter, SectionHeader } from '../src/ui/section-header'
import { TextField } from '../src/ui/text-field'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

type Load =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; status: BirthdateStatus }

/**
 * The signed-in person's birthdate: the one on file, a birthdate waiting for an admin, or, when
 * there is neither, a form to enter one as month, day and year. The server decides what an entry
 * does, and after a save the screen shows what it answered.
 */
export default function BirthdateScreen() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [month, setMonth] = useState('')
  const [day, setDay] = useState('')
  const [year, setYear] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  useEffect(() => {
    getBirthdate()
      .then((status) => setLoad({ state: 'loaded', status }))
      .catch(() => setLoad({ state: 'failed' }))
  }, [])

  const save = async () => {
    const birthdate = dateFrom(year, month, day)
    if (birthdate === null) {
      setNotice('Enter the month, day and year you were born, in numbers.')
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      setLoad({ state: 'loaded', status: await setBirthdate(birthdate) })
    } catch (error) {
      setNotice(describeSave(error))
    } finally {
      setSaving(false)
    }
  }

  const page = (children: ReactNode) => (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  )

  if (load.state === 'loading') {
    return page(
      <View style={styles.centered}>
        <ActivityIndicator color={tokens[SECTION_COLOURS.note]} />
      </View>,
    )
  }
  if (load.state === 'failed') {
    return page(
      <View style={styles.centered}>
        <Text style={styles.note}>Your birthdate could not be loaded. Open this screen again.</Text>
      </View>,
    )
  }

  const { status } = load
  if (status.ageGroup === 'under-13') {
    return page(
      <>
        <Text style={styles.body}>
          Phon is for people 13 and older, so you have been signed out. If your birthdate is wrong,
          ask an admin at your church to correct it in Planning Center.
        </Text>
        <View style={styles.laterGroup}>
          <View style={styles.action}>
            <Button label="OK" onPress={() => void clearSession()} />
          </View>
        </View>
      </>,
    )
  }
  if (status.birthdate !== null) {
    return page(
      <View style={styles.firstGroup}>
        <ListRow title="Birthdate" value={readable(status.birthdate)} first last />
        <SectionFooter
          text={'If it is wrong, an admin at your church can change it in Planning Center.'}
        />
      </View>,
    )
  }

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    maxLength: number,
    placeholder: string,
  ) => (
    <ListRow
      title={label}
      first={label === 'Month'}
      last={label === 'Year'}
      trailing={
        <TextField
          accessibilityLabel={label}
          value={value}
          onChangeText={(text) => onChange(text.replace(/\D/g, ''))}
          keyboardType="number-pad"
          maxLength={maxLength}
          placeholder={placeholder}
          style={styles.field}
        />
      }
    />
  )

  return page(
    <>
      <SectionHeader title="Your birthdate" />
      {field('Month', month, setMonth, 2, 'MM')}
      {field('Day', day, setDay, 2, 'DD')}
      {field('Year', year, setYear, 4, 'YYYY')}
      <SectionFooter
        text={
          status.pendingBirthdate !== null
            ? `You entered ${readable(status.pendingBirthdate)}. An admin at your church approves it before it is added to your Planning Center profile. If it is wrong, enter it again.`
            : 'Your church has no birthdate for you. Enter it here and it is added to your Planning Center profile. A birthdate that makes you 18 or older is approved by an admin first.'
        }
      />
      <View style={styles.laterGroup}>
        <View style={styles.action}>
          <Button label="Save" busy={saving} onPress={() => void save()} />
        </View>
        {notice !== null && <SectionFooter tone="error" live text={notice} />}
      </View>
    </>,
  )
}

/** `YYYY-MM-DD` from the three fields, or null when one is missing. The server checks the rest. */
function dateFrom(year: string, month: string, day: string): string | null {
  if (year.length !== 4 || month === '' || day === '') return null
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/** A `YYYY-MM-DD` date in words, such as March 4, 2010. */
function readable(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return `${MONTHS[month - 1] ?? month} ${day}, ${year}`
}

function describeSave(error: unknown): string {
  if (error instanceof ServerError && error.problem === 'invalid') {
    return 'That is not a date Phon can take. Check the month, day and year.'
  }
  if (error instanceof ServerError && error.problem === 'conflict') {
    return 'Your church already has a birthdate for you.'
  }
  return 'Your birthdate could not be saved. Try again.'
}

/**
 * The page under the groups. Each field fills its row after the title, with no edge of its own and
 * on the row's surface, so the row reads as the field; it keeps the tap target height.
 */
function stylesFor(tokens: ThemeTokens) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: tokens[SECTION_COLOURS.surface] },
    content: { flexGrow: 1, paddingBottom: tokens.spacing.xl },
    centered: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: tokens.spacing.xl,
    },
    firstGroup: { marginTop: tokens.spacing.lg },
    laterGroup: { marginTop: tokens.spacing.xl },
    action: { marginHorizontal: tokens.spacing.lg },
    body: {
      color: tokens[ONE_TIME_SCREEN_COLOURS.text],
      fontSize: tokens.type.body,
      paddingHorizontal: tokens.spacing.xxl,
      marginTop: tokens.spacing.xl,
    },
    note: {
      color: tokens[SECTION_COLOURS.note],
      fontSize: tokens.type.body,
      textAlign: 'center',
    },
    field: {
      flex: 1,
      minWidth: tokens.minTapTarget * 2,
      minHeight: tokens.minTapTarget,
      borderWidth: 0,
      backgroundColor: tokens[LIST_ROW_COLOURS.surface],
      color: tokens[LIST_ROW_COLOURS.title],
      textAlign: 'right',
      paddingHorizontal: 0,
      fontVariant: ['tabular-nums'],
    },
  })
}
