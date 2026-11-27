/**
 * Time zone helpers for quiet hours tests. The Worker runs in UTC, so a test that wants a person
 * inside or outside their quiet hours builds the window from the person's own local time, read
 * through `Intl` the same way any correct server would have to.
 */

/** The hour, 0 to 23, on the clock in a time zone at a moment. */
export function localHour(timeZone: string, now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour')?.value
  return Number(hour)
}

/**
 * The fixed-offset IANA zone whose clock reads UTC plus `hours`, from -12 to +14. The `Etc/GMT`
 * zones are signed the POSIX way: `Etc/GMT-6` is six hours ahead of UTC.
 */
export function zoneAhead(hours: number): string {
  if (!Number.isInteger(hours) || hours < -12 || hours > 14) {
    throw new Error(`No Etc/GMT zone is ${hours} hours from UTC`)
  }
  if (hours === 0) return 'Etc/GMT'
  return hours > 0 ? `Etc/GMT-${hours}` : `Etc/GMT+${-hours}`
}

/** The fixed-offset zone whose clock now reads the given hour. */
export function zoneAtHour(hour: number, now: Date = new Date()): string {
  let offset = hour - now.getUTCHours()
  if (offset > 14) offset -= 24
  if (offset < -12) offset += 24
  return zoneAhead(offset)
}

/** `HH:00` for an hour, wrapped into 0 to 23. */
export function onTheHour(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`
}

/**
 * A window that holds now in a zone: from an hour before its local hour to two hours after, in
 * whole hours, so a test never straddles the edge.
 */
export function quietWindowAround(timeZone: string): { start: string; end: string } {
  const hour = localHour(timeZone)
  return { start: onTheHour(hour - 1), end: onTheHour(hour + 2) }
}

/** A window that does not hold now in a zone: from three to five hours after its local hour. */
export function quietWindowAway(timeZone: string): { start: string; end: string } {
  const hour = localHour(timeZone)
  return { start: onTheHour(hour + 3), end: onTheHour(hour + 5) }
}
