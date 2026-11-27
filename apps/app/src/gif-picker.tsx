import type { Gif } from '@phon/api-types'
import { Search } from 'lucide-react-native'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { searchGifs } from './api/client'
import { appendPage, GIF_SEARCH_PLACEHOLDER } from './gif-search'
import type { ThemeTokens } from './theme/theme'
import { useTheme } from './theme/use-theme'
import { FIELD_COLOURS } from './ui/control-colours'
import { GIF_PICKER_COLOURS } from './ui/screen-colours'

/** How long typing pauses before a search goes, so a word typed is one search, not one a letter. */
const SEARCH_DELAY_MS = 300
const COLUMNS = 2

type Results =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'shown'; gifs: Gif[]; page: number; hasNext: boolean }
  | { state: 'failed' }

/**
 * The GIF keyboard: a sheet with a search field and the GIFs the server answers, two to a row,
 * the next page loaded at the end of the list. A tap hands the GIF to `onPick` and closes the
 * sheet. It decides nothing: the server picks the GIFs and the file each one posts as.
 */
export function GifPicker({
  visible,
  onPick,
  onClose,
}: {
  visible: boolean
  onPick: (gif: Gif) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results>({ state: 'idle' })
  // The search the shown results are for. An answer to any older search is dropped.
  const searchRef = useRef(0)
  const loadingMore = useRef(false)
  const { tokens, mode } = useTheme()
  const styles = useMemo(() => stylesFor(tokens), [tokens])
  const { width } = useWindowDimensions()
  const gap = tokens.spacing.sm
  const cell = (width - gap * (COLUMNS + 1)) / COLUMNS

  useEffect(() => {
    if (!visible) {
      setQuery('')
      setResults({ state: 'idle' })
    }
  }, [visible])

  useEffect(() => {
    const search = ++searchRef.current
    const text = query.trim()
    if (text === '') {
      setResults({ state: 'idle' })
      return
    }
    const timer = setTimeout(() => {
      setResults({ state: 'searching' })
      searchGifs(text, 1).then(
        (page) => {
          if (search !== searchRef.current) return
          setResults({ state: 'shown', gifs: page.gifs, page: page.page, hasNext: page.hasNext })
        },
        () => {
          if (search === searchRef.current) setResults({ state: 'failed' })
        },
      )
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query])

  const loadMore = () => {
    if (results.state !== 'shown' || !results.hasNext || loadingMore.current) return
    const search = searchRef.current
    loadingMore.current = true
    searchGifs(query.trim(), results.page + 1)
      .then(
        (page) => {
          if (search !== searchRef.current) return
          setResults((current) =>
            current.state === 'shown'
              ? {
                  state: 'shown',
                  gifs: appendPage(current.gifs, page),
                  page: page.page,
                  hasNext: page.hasNext,
                }
              : current,
          )
        },
        // A later page that fails leaves the shown GIFs; reaching the end again retries it.
        () => {},
      )
      .finally(() => {
        loadingMore.current = false
      })
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.field}>
            <View accessible={false}>
              <Search
                color={tokens[FIELD_COLOURS.placeholder]}
                size={tokens.iconSize.md}
                strokeWidth={2}
              />
            </View>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={GIF_SEARCH_PLACEHOLDER}
              placeholderTextColor={tokens[FIELD_COLOURS.placeholder]}
              selectionColor={tokens[FIELD_COLOURS.cursor]}
              cursorColor={tokens[FIELD_COLOURS.cursor]}
              keyboardAppearance={mode}
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
              style={styles.search}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <Text style={styles.closeText}>Cancel</Text>
          </Pressable>
        </View>
        {results.state === 'failed' && (
          <Text style={styles.line}>GIFs could not be loaded. Try again.</Text>
        )}
        {results.state === 'searching' && <Text style={styles.line}>Searching</Text>}
        {results.state === 'shown' && results.gifs.length === 0 && (
          <Text style={styles.line}>No GIFs found</Text>
        )}
        {results.state === 'shown' && (
          <FlatList
            data={results.gifs}
            keyExtractor={(gif) => gif.id}
            numColumns={COLUMNS}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="imagebutton"
                accessibilityLabel={item.title === '' ? 'GIF' : item.title}
                onPress={() => {
                  onPick(item)
                  onClose()
                }}
              >
                <Image
                  source={{ uri: item.preview.url }}
                  style={[
                    styles.preview,
                    { width: cell, height: (cell * item.preview.height) / item.preview.width },
                  ]}
                />
              </Pressable>
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  )
}

/**
 * The sheet fills the screen, so it keeps itself out of the status bar and the home indicator and
 * paints the background itself. The search field draws the shared field's colours, its glyph in
 * the placeholder's muted text, and Cancel is an accent text control at least the tap target big.
 */
function stylesFor(tokens: ThemeTokens) {
  const gap = tokens.spacing.sm
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: tokens[GIF_PICKER_COLOURS.surface] },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap,
      paddingHorizontal: gap,
      paddingVertical: gap,
    },
    field: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: tokens.spacing.sm,
      minHeight: tokens.minTapTarget,
      paddingHorizontal: tokens.spacing.md,
      backgroundColor: tokens[FIELD_COLOURS.surface],
      borderWidth: 1,
      borderColor: tokens[FIELD_COLOURS.border],
      borderRadius: tokens.radius,
    },
    search: {
      flex: 1,
      paddingVertical: tokens.spacing.sm,
      color: tokens[FIELD_COLOURS.text],
      fontSize: tokens.type.body,
    },
    close: {
      minHeight: tokens.minTapTarget,
      minWidth: tokens.minTapTarget,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: tokens.spacing.sm,
    },
    pressed: { opacity: 0.7 },
    closeText: { color: tokens[GIF_PICKER_COLOURS.cancel], fontSize: tokens.type.body },
    line: {
      padding: tokens.spacing.lg,
      textAlign: 'center',
      color: tokens[GIF_PICKER_COLOURS.status],
      fontSize: tokens.type.body,
    },
    list: { padding: gap, gap },
    row: { gap },
    preview: { borderRadius: tokens.radius, backgroundColor: tokens.muted },
  })
}
