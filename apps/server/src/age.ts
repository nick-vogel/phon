import type { AgeGroup } from '@phon/api-types'

/**
 * The age rule. It lives here once: the roster sync asks it who is never synced, and the birthdate
 * routes ask it what a self-entered birthdate does. A person is N on their Nth birthday, counted on
 * today's UTC date, and a February 29 birthday falls on March 1 in a common year.
 */

/** No one younger is synced into Phon. */
export const MINIMUM_AGE = 13

/** From this age a person is an adult; younger, or with no birthdate, a minor. */
export const ADULT_AGE = 18

/** The earliest birthdate a person may enter. */
const EARLIEST_BIRTHDATE = '1900-01-01'

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Today's date in UTC, as `YYYY-MM-DD`. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Whether a value is a real calendar date written `YYYY-MM-DD`. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE.exec(value)
  if (match === null) return false
  const [, year, month, day] = match.map(Number) as [number, number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/**
 * Whether a value is a birthdate a person may enter: a calendar date, not in the future and not
 * before 1900-01-01.
 */
export function isBirthdate(value: unknown, today = utcToday()): value is string {
  return isCalendarDate(value) && value >= EARLIEST_BIRTHDATE && value <= today
}

/** How old a person born on `birthdate` is on `today`, both `YYYY-MM-DD`. */
export function ageOn(birthdate: string, today: string): number {
  const [birthYear, birthMonth, birthDay] = birthdate.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  const hadBirthday = month > birthMonth || (month === birthMonth && day >= birthDay)
  return year - birthYear - (hadBirthday ? 0 : 1)
}

/**
 * The latest birthdate that makes a person an adult on `today`: a birthdate is an adult's exactly
 * when it is on or before this one. Built from today's string with the year less 18, never through
 * `Date`, so a February 29 today compares as `ageOn` counts it.
 */
export function adultCutoff(today = utcToday()): string {
  const year = Number(today.slice(0, 4)) - ADULT_AGE
  return `${String(year).padStart(4, '0')}${today.slice(4)}`
}

/** Whether a person with this birthdate on file, or none, is treated as a minor. */
export function isMinor(birthdate: string | null, today = utcToday()): boolean {
  return ageGroup(birthdate, today) !== 'adult'
}

/**
 * Which age group a birthdate puts a person in: `under-13` is never synced, a person with no
 * birthdate is a `minor`, and so is anyone 13 to 17.
 */
export function ageGroup(birthdate: string | null, today = utcToday()): AgeGroup {
  if (birthdate === null) return 'minor'
  const age = ageOn(birthdate, today)
  if (age < MINIMUM_AGE) return 'under-13'
  return age < ADULT_AGE ? 'minor' : 'adult'
}
