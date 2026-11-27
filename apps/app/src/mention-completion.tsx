import type { ChannelPeople } from '@phon/api-types'
import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ThemeTokens } from './theme/theme'
import { useTheme } from './theme/use-theme'
import { MENTION_LIST_COLOURS } from './ui/screen-colours'

/** One person an @mention can reach, as `GET /channels/:channelId/people` lists them. */
export type MentionablePerson = ChannelPeople['people'][number]

/** The most people the completion list shows at once. */
const MAX_SUGGESTIONS = 5

/**
 * The @mention being typed at the end of the composer's text: what follows the `@` of the last
 * word, or null when the last word does not start with `@`.
 */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text)
  return match === null ? null : (match[1] ?? '')
}

/**
 * The people whose names match an @mention being typed, the ones whose names start with it first,
 * in the server's order. The signed-in person is left out: they never mention themselves.
 */
export function mentionSuggestions(
  people: readonly MentionablePerson[],
  query: string,
  selfId: string | null,
): MentionablePerson[] {
  const wanted = query.toLowerCase()
  const others = people.filter((person) => person.personId !== selfId)
  const starts = others.filter((person) => person.name.toLowerCase().startsWith(wanted))
  const contains = others.filter(
    (person) => !starts.includes(person) && person.name.toLowerCase().includes(wanted),
  )
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS)
}

/** The composer's text with the @mention being typed replaced by `@<name> `. */
export function completeMention(text: string, person: MentionablePerson): string {
  return text.replace(/@[^\s@]*$/, `@${person.name} `)
}

/**
 * The people picked from the completion list whose `@<name>` is still in the text, in the order
 * picked. The server checks them again and keeps only those the channel's members include.
 */
export function mentionedIds(text: string, picked: ReadonlyMap<string, string>): string[] {
  return [...picked].filter(([, name]) => text.includes(`@${name}`)).map(([personId]) => personId)
}

/** The completion list, shown above the composer while an @mention is being typed. */
export function MentionSuggestions({
  suggestions,
  onPick,
}: {
  suggestions: readonly MentionablePerson[]
  onPick: (person: MentionablePerson) => void
}) {
  const { tokens } = useTheme()
  const styles = useMemo(() => mentionStyles(tokens), [tokens])
  if (suggestions.length === 0) return null
  return (
    <View style={styles.list} accessibilityLabel="People to mention">
      {suggestions.map((person) => (
        <Pressable
          key={person.personId}
          accessibilityRole="button"
          onPress={() => onPick(person)}
          style={styles.row}
        >
          <Text style={styles.name}>@{person.name}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function mentionStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    list: { paddingHorizontal: 12, paddingVertical: 4, gap: 2 },
    row: { minHeight: 40, justifyContent: 'center' },
    name: { color: tokens[MENTION_LIST_COLOURS.name], fontSize: 16 },
  })
}
