import { describe, expect, it } from 'vitest';
import { addDays, dayIn, isTimezone, startOfDayIn } from '../src/lib/timezones';

describe('days in the owner’s timezone', () => {
  it('says which day an instant falls on there', () => {
    expect(dayIn(new Date('2026-10-08T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-09');
    expect(dayIn(new Date('2026-10-08T02:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-07');
    expect(dayIn(new Date('2026-10-08T12:00:00Z'), 'UTC')).toBe('2026-10-08');
  });

  it('finds when a day starts there', () => {
    expect(startOfDayIn('2026-10-08', 'Europe/Paris').toISOString()).toBe('2026-10-07T22:00:00.000Z');
    expect(startOfDayIn('2026-10-08', 'Asia/Kolkata').toISOString()).toBe('2026-10-07T18:30:00.000Z');
    // The days the clocks change.
    expect(startOfDayIn('2026-10-25', 'Europe/Paris').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(startOfDayIn('2026-10-26', 'Europe/Paris').toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(startOfDayIn('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfDayIn('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('starts each day on that day, a millisecond after the one before, wherever the clocks change', () => {
    const cases: Array<[string, string]> = [
      ['Europe/Paris', '2026-03-29'],
      ['Europe/Paris', '2026-10-25'],
      ['America/New_York', '2026-11-01'],
      // Clocks that skip or repeat midnight itself.
      ['America/Santiago', '2026-09-06'],
      ['America/Santiago', '2026-04-05'],
      ['America/Havana', '2026-03-08'],
      ['Australia/Lord_Howe', '2026-10-04'],
      ['Pacific/Chatham', '2026-09-27'],
    ];
    for (const [zone, day] of cases) {
      const start = startOfDayIn(day, zone);
      expect(dayIn(start, zone), `${zone} ${day}`).toBe(day);
      expect(dayIn(new Date(start.getTime() - 1), zone), `${zone} ${day}`).toBe(addDays(day, -1));
    }
  });

  it('uses the browser’s own days without a zone it knows', () => {
    expect(isTimezone('Not/AZone')).toBe(false);
    expect(dayIn(new Date(2026, 9, 8, 12), 'Not/AZone')).toBe('2026-10-08');
    expect(startOfDayIn('2026-10-08', 'Not/AZone')).toEqual(new Date(2026, 9, 8));
    expect(startOfDayIn('2026-10-08')).toEqual(new Date(2026, 9, 8));
  });

  it('moves a day across months and years', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-08', -29)).toBe('2026-09-09');
  });
});
