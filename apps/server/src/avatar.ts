import { ageGroup } from './age.ts'

/**
 * The avatar rule. It lives here once: the roster sync asks it which photo a synced person keeps.
 * Only an adult (the age rule's `adult`: 18 or older, and no birthdate on file is a minor) keeps
 * one, and only an uploaded photo: Planning Center answers its default initials image, under
 * `/uploads/initials/`, for a person who uploaded none. The app loads the URL directly, so anything
 * that is not an `https:` URL is no photo.
 */

/** The path segment of Planning Center's default initials image. */
const INITIALS_IMAGE = '/uploads/initials/'

/**
 * The photo a synced person keeps: Planning Center's URL as it sent it, or null for a minor, for
 * no uploaded photo, and for a value that is not an `https:` URL.
 */
export function syncedAvatar(url: unknown, birthdate: string | null, today: string): string | null {
  if (ageGroup(birthdate, today) !== 'adult' || typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.pathname.includes(INITIALS_IMAGE)) return null
  return url
}
