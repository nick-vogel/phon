/**
 * Clock times as quiet hours store them: `HH:MM` on a 24-hour clock. The screen shows them on the
 * phone's own clock, 12-hour or 24-hour. Pure, so a test runs it without a phone.
 */

/**
 * The clock time a number of minutes after another, wrapping around midnight both ways. Answers
 * the time unchanged when it is not `HH:MM`.
 */
export function stepClock(clock: string, minutes: number): string {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (match === null) return clock
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % (24 * 60)
  const wrapped = total < 0 ? total + 24 * 60 : total
  const hours = String(Math.floor(wrapped / 60)).padStart(2, '0')
  const rest = String(wrapped % 60).padStart(2, '0')
  return `${hours}:${rest}`
}

/**
 * A stored clock time as the phone's clock shows it: unchanged on a 24-hour clock, else with AM
 * or PM (`22:00` is `10:00 PM`). A phone that does not say gets the 12-hour clock. Answers the
 * time unchanged when it is not `HH:MM`.
 */
export function showClock(clock: string, uses24hourClock: boolean | null): string {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (match === null || uses24hourClock === true) return clock
  const hours = Number(match[1])
  const half = hours < 12 ? 'AM' : 'PM'
  return `${hours % 12 === 0 ? 12 : hours % 12}:${match[2]} ${half}`
}
