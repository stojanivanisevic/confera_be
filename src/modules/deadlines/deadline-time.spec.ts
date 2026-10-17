import { deadlineEnd, deadlinePassed, localDay, startOfLocalDay } from './deadline-time';

/** FR-DL-01: a deadline ends at the end of its day in the conference's time zone (M3-BE-05). */
describe('deadlines in the time zone of the conference', () => {
  const BELGRADE = 'Europe/Belgrade';

  it('23:59 of the deadline day is in time, 00:00 of the next day is not (winter, UTC+1)', () => {
    // 15 January 2027 ends at 2027-01-15T23:00:00Z.
    expect(deadlineEnd('2027-01-15', BELGRADE).toISOString()).toBe('2027-01-15T23:00:00.000Z');
    expect(deadlinePassed('2027-01-15', BELGRADE, new Date('2027-01-15T22:59:59.999Z'))).toBe(
      false,
    );
    expect(deadlinePassed('2027-01-15', BELGRADE, new Date('2027-01-15T23:00:00.000Z'))).toBe(true);
  });

  it('in summer the day ends an hour earlier in UTC (UTC+2)', () => {
    expect(deadlineEnd('2027-06-30', BELGRADE).toISOString()).toBe('2027-06-30T22:00:00.000Z');
  });

  it('on the day the clocks go forward (28 March 2027) the day has 23 hours', () => {
    expect(startOfLocalDay('2027-03-28', BELGRADE).toISOString()).toBe('2027-03-27T23:00:00.000Z');
    expect(deadlineEnd('2027-03-28', BELGRADE).toISOString()).toBe('2027-03-28T22:00:00.000Z');
    // The evening before the change, still winter time.
    expect(deadlineEnd('2027-03-27', BELGRADE).toISOString()).toBe('2027-03-27T23:00:00.000Z');
  });

  it('on the day the clocks go back (31 October 2027) the day has 25 hours', () => {
    expect(startOfLocalDay('2027-10-31', BELGRADE).toISOString()).toBe('2027-10-30T22:00:00.000Z');
    expect(deadlineEnd('2027-10-31', BELGRADE).toISOString()).toBe('2027-10-31T23:00:00.000Z');
    expect(deadlinePassed('2027-10-31', BELGRADE, new Date('2027-10-31T22:59:59Z'))).toBe(false);
  });

  it('22:30 UTC on 12 October is already 13 October in Belgrade', () => {
    expect(localDay(new Date('2026-10-12T22:30:00Z'), BELGRADE)).toBe('2026-10-13');
    expect(deadlinePassed('2026-10-12', BELGRADE, new Date('2026-10-12T22:30:00Z'))).toBe(true);
  });

  it('a zone far from Belgrade, and one that skips midnight', () => {
    expect(deadlineEnd('2027-01-15', 'Pacific/Auckland').toISOString()).toBe(
      '2027-01-15T11:00:00.000Z',
    );
    expect(deadlineEnd('2027-01-15', 'UTC').toISOString()).toBe('2027-01-16T00:00:00.000Z');
    // Chile moves its clocks forward at midnight in September: the day starts at 01:00.
    const start = startOfLocalDay('2026-09-06', 'America/Santiago');
    expect(localDay(start, 'America/Santiago')).toBe('2026-09-06');
    expect(localDay(new Date(start.getTime() - 1), 'America/Santiago')).toBe('2026-09-05');
  });

  it('refuses what is not a day', () => {
    expect(() => deadlineEnd('15.01.2027', BELGRADE)).toThrow(RangeError);
  });
});
