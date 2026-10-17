/**
 * Deadlines in the conference's time zone (FR-DL-01, ADR-08): a deadline is a day; it ends
 * at the end of that day where the conference is, so a submission at 23:59 of the deadline
 * day is accepted and one at 00:00 of the next day is refused. "Closed from the start of the
 * day after its deadline, in the conference's time zone."
 *
 * Times are stored in UTC and computed with the runtime's time-zone database (Intl), also on
 * the days the clocks change. Where a zone skips midnight, the next day starts at its first
 * instant.
 */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The offset of a zone at an instant, in milliseconds (local minus UTC). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The first instant of a local day (YYYY-MM-DD) in a zone. */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const match = DAY.exec(day);
  if (match === null) {
    throw new RangeError('A day is written YYYY-MM-DD.');
  }
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let instant = guess - zoneOffsetMs(guess, timeZone);
  // Once more with the offset at the instant found: right across a change of the clocks.
  instant = guess - zoneOffsetMs(instant, timeZone);
  // A zone that skips midnight: the day starts at its first instant, never in the day before.
  if (localDay(new Date(instant), timeZone) !== day) {
    instant += 60 * 60 * 1000;
  }
  return new Date(instant);
}

/** The day after a day, YYYY-MM-DD. */
export function nextDay(day: string): string {
  const match = DAY.exec(day);
  if (match === null) {
    throw new RangeError('A day is written YYYY-MM-DD.');
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1))
    .toISOString()
    .slice(0, 10);
}

/** The instant a deadline ends: the start of the next day in the conference's zone. */
export function deadlineEnd(endsOn: string, timeZone: string): Date {
  return startOfLocalDay(nextDay(endsOn), timeZone);
}

/** Has the deadline passed at this instant? */
export function deadlinePassed(endsOn: string, timeZone: string, now: Date): boolean {
  return now.getTime() >= deadlineEnd(endsOn, timeZone).getTime();
}

/** The local day of an instant in a zone, YYYY-MM-DD. */
export function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
