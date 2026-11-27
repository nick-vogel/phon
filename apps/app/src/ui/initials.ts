/**
 * The initials an avatar shows for a name: the first letter of its first word and of its last,
 * upper-cased, so "Ben Ito" is "BI" and "Former member" is "FM". A one-word name gives one letter,
 * and an empty or blank name gives none. Letters are taken whole, so one outside the Basic
 * Multilingual Plane is not split in half.
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  const first = words[0]
  if (first === undefined) return ''
  const last = words.length > 1 ? words[words.length - 1] : undefined
  return [first, last]
    .map((word) => (word === undefined ? '' : (Array.from(word)[0] ?? '')))
    .join('')
    .toLocaleUpperCase()
}
