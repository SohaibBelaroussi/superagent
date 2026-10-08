import { describe, expect, it } from 'vitest';
import { checkCron, DEFAULT_CRON_DRAFT, describeCron, formatClock, fromCron, toCron } from '../src/lib/cron';

const draft = (overrides: Partial<typeof DEFAULT_CRON_DRAFT>) => ({ ...DEFAULT_CRON_DRAFT, ...overrides });

describe('schedules as the form builds them', () => {
  it('turns a frequency and a time into a cron, and back', () => {
    const cases: Array<[Partial<typeof DEFAULT_CRON_DRAFT>, string]> = [
      [{ frequency: 'daily', time: '07:30' }, '30 7 * * *'],
      [{ frequency: 'weekdays', time: '09:00' }, '0 9 * * 1-5'],
      [{ frequency: 'weekly', time: '18:05', days: [4, 1, 4] }, '5 18 * * 1,4'],
      [{ frequency: 'monthly', time: '08:00', dayOfMonth: 15 }, '0 8 15 * *'],
      [{ frequency: 'hourly', everyHours: 1, minute: 0 }, '0 * * * *'],
      [{ frequency: 'hourly', everyHours: 6, minute: 15 }, '15 */6 * * *'],
    ];
    for (const [input, cron] of cases) {
      expect(toCron(draft(input))).toBe(cron);
      expect(toCron(fromCron(cron))).toBe(cron);
    }
  });

  it('isn’t a cron until it is complete', () => {
    expect(toCron(draft({ frequency: 'weekly', days: [] }))).toBeNull();
    expect(toCron(draft({ frequency: 'daily', time: '' }))).toBeNull();
    expect(toCron(draft({ frequency: 'custom', custom: '   ' }))).toBeNull();
  });

  it('takes anything else as written', () => {
    expect(fromCron('0 9 1-7 * 1')).toMatchObject({ frequency: 'custom', custom: '0 9 1-7 * 1' });
    expect(fromCron('*/30 9-17 * * 1-5').frequency).toBe('custom');
    expect(fromCron('0 0 9 * * *').frequency).toBe('custom');
  });
});

describe('a schedule in words', () => {
  it('reads the shapes the form builds plainly', () => {
    // Times as this machine's locale writes them ("9:00 AM" or "09:00").
    expect(describeCron('0 9 * * 1-5')).toBe(`Every weekday at ${formatClock('09:00')}`);
    expect(describeCron('30 7 * * *')).toBe(`Every day at ${formatClock('07:30')}`);
    expect(describeCron('0 9 * * 1,3,5')).toBe(
      `Every Monday, Wednesday and Friday at ${formatClock('09:00')}`,
    );
    expect(describeCron('0 18 1 * *')).toBe(`On the 1st of every month at ${formatClock('18:00')}`);
    expect(describeCron('0 8 22 * *')).toBe(`On the 22nd of every month at ${formatClock('08:00')}`);
    expect(describeCron('0 8 31 * *')).toBe(
      `On the 31st of every month at ${formatClock('08:00')} (months without one are skipped)`,
    );
    expect(describeCron('0 */4 * * *')).toBe('Every 4 hours, on the hour');
    expect(describeCron('15 * * * *')).toBe('Every hour, 15 minutes past');
  });

  it('describes any other cron, and says nothing for one that isn’t', () => {
    expect(describeCron('*/30 9-17 * * 1-5')).toMatch(/30 minutes/);
    expect(describeCron('not a cron')).toBeNull();
  });
});

describe('what the server will say about a schedule', () => {
  const thursday = new Date('2026-10-08T10:00:00Z');

  it('gives its next runs in its timezone', () => {
    const check = checkCron('0 9 * * 1-5', 'Asia/Qatar', thursday);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    // 13:00 in Doha already: Friday, then Monday and Tuesday (06:00 UTC).
    expect(check.next.map((date) => date.toISOString())).toEqual([
      '2026-10-09T06:00:00.000Z',
      '2026-10-12T06:00:00.000Z',
      '2026-10-13T06:00:00.000Z',
    ]);
  });

  it('refuses what fires more often than every 5 minutes, a bad cron and an unknown timezone', () => {
    expect(checkCron('* * * * *', 'UTC', thursday)).toEqual({
      ok: false,
      error: 'A schedule can run at most every 5 minutes.',
    });
    expect(checkCron('*/5 * * * *', 'UTC', thursday).ok).toBe(true);
    expect(checkCron('0 9 * *', 'UTC', thursday)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/five fields/),
    });
    expect(checkCron('0 9 * * *', 'Mars/Olympus', thursday)).toEqual({
      ok: false,
      error: '“Mars/Olympus” isn’t a timezone.',
    });
  });
});
