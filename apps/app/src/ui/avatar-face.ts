import { initials } from './initials.ts'

/** What an avatar draws: the person's photo, or their initials. */
export type AvatarFace = { kind: 'photo'; uri: string } | { kind: 'initials'; text: string }

/**
 * What a person's avatar draws: their photo when `photoUrl` is one and it has not failed to load
 * (`failedUrl`), and their initials otherwise. The server sends no photo for a minor or for a
 * person with no uploaded photo, so both always show initials. A failure is held by its URL, so a
 * different URL, after a roster sync, is tried again.
 */
export function avatarFace(
  name: string,
  photoUrl: string | null | undefined,
  failedUrl: string | null,
): AvatarFace {
  if (typeof photoUrl === 'string' && photoUrl !== '' && photoUrl !== failedUrl) {
    return { kind: 'photo', uri: photoUrl }
  }
  return { kind: 'initials', text: initials(name) }
}

/** The avatar's diameter, in points, unless a size is passed: the chat's, beside a message. */
export const AVATAR_SIZE = 28

/**
 * The font size of an avatar's initials: `base`, the theme's caption size, in a circle of
 * `AVATAR_SIZE` or smaller, and in proportion to the diameter above it, so a larger circle, such as
 * the Settings header's, does not hold tiny letters.
 */
export function initialsFontSize(size: number, base: number): number {
  return size <= AVATAR_SIZE ? base : (base * size) / AVATAR_SIZE
}
