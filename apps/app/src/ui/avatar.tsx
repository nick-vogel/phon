import { useMemo, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/use-theme'
import { AVATAR_SIZE, avatarFace, initialsFontSize } from './avatar-face'

export { AVATAR_SIZE }

export interface AvatarProps {
  /** Whose avatar it is. Its initials show when there is no photo, or it fails to load. */
  name: string
  /** The person's photo, as the server sends it: a URL, or null for a minor or no photo. */
  photoUrl?: string | null
  /** The diameter, in points. */
  size?: number
}

/**
 * A person's avatar: their photo in a circle when there is one, and their initials otherwise or
 * once the photo fails to load (`avatarFace`). The initials keep the theme's caption size at the
 * chat's size and grow with a larger circle (`initialsFontSize`), not with the text size, since
 * the circle does not grow with it. It is not an accessibility element: the name beside it already
 * says who it is.
 */
export function Avatar({ name, photoUrl, size = AVATAR_SIZE }: AvatarProps) {
  const { tokens } = useTheme()
  // The URL that failed to load, so a different one, after a roster sync, is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const styles = useMemo(
    () =>
      StyleSheet.create({
        circle: {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tokens.secondary,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        photo: { width: size, height: size },
        initials: {
          color: tokens.secondaryForeground,
          fontSize: initialsFontSize(size, tokens.type.caption1),
          fontWeight: '600',
        },
      }),
    [tokens, size],
  )
  const face = avatarFace(name, photoUrl, failedUrl)
  return (
    <View style={styles.circle} accessible={false}>
      {face.kind === 'photo' ? (
        <Image
          source={{ uri: face.uri }}
          style={styles.photo}
          onError={() => setFailedUrl(face.uri)}
        />
      ) : (
        <Text style={styles.initials} allowFontScaling={false}>
          {face.text}
        </Text>
      )}
    </View>
  )
}
