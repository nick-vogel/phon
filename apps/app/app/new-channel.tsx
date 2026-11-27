import type { CreatableChannelKind, Member, Person } from '@phon/api-types'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { createChannel, getMe, getPeople, ServerError } from '../src/api/client'
import { channelRouteParams } from '../src/channel-route'
import { PersonPicker } from '../src/person-picker'
import type { ThemeTokens } from '../src/theme/theme'
import { useTheme } from '../src/theme/use-theme'
import { Button } from '../src/ui/button'
import { ListRow } from '../src/ui/list-row'
import { LIST_ROW_COLOURS, SECTION_COLOURS } from '../src/ui/list-row-colours'
import { SectionFooter, SectionHeader } from '../src/ui/section-header'
import { TextField } from '../src/ui/text-field'

/** How each kind reads on screen. */
const KIND_LABELS: Record<CreatableChannelKind, string> = {
  open: 'Open to everyone who serves',
  private: 'Private, for the people you pick',
}

/**
 * The new-channel screen: a name, and the kinds the server says this person may create. A chat
 * admin sees open channels only; an admin also sees private channels and picks their members. The
 * server decides whether the channel is allowed.
 */
export default function NewChannel() {
  const router = useRouter()
  const [me, setMe] = useState<Member | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<CreatableChannelKind | null>(null)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { tokens } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])

  useEffect(() => {
    getMe()
      .then((member) => {
        setMe(member)
        setKind(member.canCreate[0] ?? null)
      })
      .catch(() => setNotice('Could not load what you can create. Please try again.'))
  }, [])

  useEffect(() => {
    if (kind !== 'private' || people !== null) return
    getPeople()
      .then((list) => setPeople(list.people))
      .catch(() => setNotice('People could not be loaded. Please try again.'))
  }, [kind, people])

  const create = async () => {
    if (kind === null) return
    setBusy(true)
    setNotice(null)
    try {
      const channel = await createChannel(
        kind === 'private' ? { name, kind, memberIds: [...picked] } : { name, kind },
      )
      router.replace({ pathname: '/channels/[channelId]', params: channelRouteParams(channel) })
    } catch (error) {
      setNotice(describe(error))
    }
    setBusy(false)
  }

  if (me !== null && me.canCreate.length === 0) {
    return (
      <View style={[styles.page, styles.centered]}>
        <Text style={styles.note}>Only admins and chat admins create channels.</Text>
      </View>
    )
  }

  const options = me?.canCreate ?? []
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.firstGroup}>
        <ListRow
          title="Name"
          first
          last
          trailing={
            <TextField
              accessibilityLabel="Channel name"
              value={name}
              onChangeText={setName}
              placeholder="Channel name"
              maxLength={80}
              style={styles.field}
            />
          }
        />
      </View>
      {options.length > 0 && <SectionHeader title="Who it's for" />}
      {options.map((option, index) => (
        <ListRow
          key={option}
          title={KIND_LABELS[option]}
          checked={kind === option}
          onPress={() => setKind(option)}
          first={index === 0}
          last={index === options.length - 1}
        />
      ))}
      {kind === 'private' && (
        <View>
          <SectionHeader title="Members (at least three)" />
          {people === null ? (
            <SectionFooter text={'Loading people'} />
          ) : (
            <PersonPicker people={people} picked={picked} onChange={setPicked} />
          )}
        </View>
      )}
      <View style={styles.laterGroup}>
        <View style={styles.action}>
          <Button
            label="Create channel"
            busy={busy}
            disabled={kind === null}
            onPress={() => void create()}
          />
        </View>
        {notice !== null && <SectionFooter tone="error" live text={notice} />}
      </View>
    </ScrollView>
  )
}

function describe(error: unknown): string {
  if (error instanceof ServerError) {
    switch (error.problem) {
      case 'invalid':
        return 'Give the channel a name of up to 80 characters. A private channel needs at least three members.'
      case 'conflict':
        return 'A channel with that name already exists.'
      case 'not-allowed':
        return 'You cannot create this kind of channel.'
      default:
        break
    }
  }
  return 'The channel could not be created. Please try again.'
}

/**
 * The page under the groups. The name field fills its row after the title, with no edge of its own
 * and on the row's surface, so the row reads as the field; it keeps the tap target height.
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
    field: {
      flex: 1,
      minWidth: tokens.minTapTarget * 3,
      minHeight: tokens.minTapTarget,
      borderWidth: 0,
      backgroundColor: tokens[LIST_ROW_COLOURS.surface],
      color: tokens[LIST_ROW_COLOURS.title],
      paddingHorizontal: 0,
    },
  })
}
