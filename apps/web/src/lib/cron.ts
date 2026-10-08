import { Cron } from 'croner';
import cronstrue from 'cronstrue';
import { isTimezone } from './timezones';

/*
 * Schedules are crons (5 fields: minute hour day month weekday, or 6 with seconds first). The form
 * builds the common ones from a frequency and a time, and takes any other cron as written. Next runs
 * come from croner with the options the server uses (Mastra validates and computes fires with it), so
 * what the form shows is what the server will do.
 */

/** How often a schedule runs, as the form offers it. */
export type Frequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hourly' | 'custom';

export interface CronDraft {
  frequency: Frequency;
  /** "HH:MM": daily, weekdays, weekly and monthly. */
  time: string;
  /** Weekly: cron weekdays, 0 (Sunday) to 6. */
  days: number[];
  /** Monthly: 1 to 31; a month without that day is skipped. */
  dayOfMonth: number;
  /** Hourly: every this many hours, from midnight. */
  everyHours: number;
  /** Hourly: minutes past the hour. */
  minute: number;
  /** Custom: the cron as written. */
  custom: string;
}

export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export const DEFAULT_CRON_DRAFT: CronDraft = {
  frequency: 'weekdays',
  time: '09:00',
  days: [1],
  dayOfMonth: 1,
  everyHours: 1,
  minute: 0,
  custom: '0 9 * * 1-5',
};

/** The server's limit: a schedule fires at most every 5 minutes. */
export const MIN_INTERVAL_MS = 5 * 60_000;
/** How many fires the server checks against that limit. */
const SAMPLED_FIRES = 50;

const NUMBER = /^\d+$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function parseTime(time: string): [hour: number, minute: number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? [hour, minute] : null;
}

const sortedDays = (days: readonly number[]) => [...new Set(days)].sort((a, b) => a - b);

/** The cron for a draft, or null while it isn't complete (no time, a weekly one with no day). */
export function toCron(draft: CronDraft): string | null {
  if (draft.frequency === 'custom') return draft.custom.trim().replace(/\s+/g, ' ') || null;
  if (draft.frequency === 'hourly') {
    return `${draft.minute} ${draft.everyHours === 1 ? '*' : `*/${draft.everyHours}`} * * *`;
  }
  const time = parseTime(draft.time);
  if (!time) return null;
  const [hour, minute] = time;
  switch (draft.frequency) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return draft.days.length > 0 ? `${minute} ${hour} * * ${sortedDays(draft.days).join(',')}` : null;
    case 'monthly':
      return `${minute} ${hour} ${draft.dayOfMonth} * *`;
  }
}

/** The form's view of a cron: one of the shapes it builds, or custom. */
export function fromCron(cron: string): CronDraft {
  const trimmed = cron.trim();
  const custom: CronDraft = { ...DEFAULT_CRON_DRAFT, frequency: 'custom', custom: trimmed };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return custom;
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
  if (month !== '*' || !NUMBER.test(minute) || Number(minute) > 59) return custom;
  const base = { ...DEFAULT_CRON_DRAFT, custom: trimmed };

  if (day === '*' && weekday === '*') {
    if (hour === '*') return { ...base, frequency: 'hourly', everyHours: 1, minute: Number(minute) };
    const step = /^\*\/(\d+)$/.exec(hour);
    const every = Number(step?.[1]);
    if (step && (HOUR_STEPS as readonly number[]).includes(every)) {
      return { ...base, frequency: 'hourly', everyHours: every, minute: Number(minute) };
    }
  }
  if (!NUMBER.test(hour) || Number(hour) > 23) return custom;
  const time = `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
  const timed = { ...base, time };
  if (day === '*' && weekday === '*') return { ...timed, frequency: 'daily' };
  if (day === '*' && weekday === '1-5') return { ...timed, frequency: 'weekdays' };
  if (day === '*' && /^[0-6](,[0-6])*$/.test(weekday)) {
    return { ...timed, frequency: 'weekly', days: sortedDays(weekday.split(',').map(Number)) };
  }
  if (weekday === '*' && NUMBER.test(day) && Number(day) >= 1 && Number(day) <= 31) {
    return { ...timed, frequency: 'monthly', dayOfMonth: Number(day) };
  }
  return custom;
}

/** Whether this browser's locale writes times on a 24-hour clock. */
function uses24Hours(): boolean {
  const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h23' || cycle === 'h24';
}

/** "09:30" as this browser writes a time of day: "9:30 AM" or "09:30". */
export function formatClock(time: string): string {
  const parsed = parseTime(time);
  if (!parsed) return time;
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(2000, 0, 1, parsed[0], parsed[1]),
  );
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "Monday", "Monday and Thursday", "Monday, Wednesday and Friday". */
function dayList(days: readonly number[]): string {
  const names = sortedDays(days).map((day) => WEEKDAYS[day] ?? String(day));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/** A cron in words ("Every weekday at 9:00 AM"), or null when it isn't a valid cron. */
export function describeCron(cron: string): string | null {
  const draft = fromCron(cron);
  switch (draft.frequency) {
    case 'daily':
      return `Every day at ${formatClock(draft.time)}`;
    case 'weekdays':
      return `Every weekday at ${formatClock(draft.time)}`;
    case 'weekly':
      return `Every ${dayList(draft.days)} at ${formatClock(draft.time)}`;
    case 'monthly':
      return `On the ${ordinal(draft.dayOfMonth)} of every month at ${formatClock(draft.time)}`;
    case 'hourly': {
      const every = draft.everyHours === 1 ? 'Every hour' : `Every ${draft.everyHours} hours`;
      return draft.minute === 0
        ? `${every}, on the hour`
        : `${every}, ${draft.minute} ${draft.minute === 1 ? 'minute' : 'minutes'} past`;
    }
    case 'custom':
      try {
        return cronstrue.toString(draft.custom, {
          throwExceptionOnParseError: true,
          use24HourTimeFormat: uses24Hours(),
        });
      } catch {
        return null;
      }
  }
}

export type CronCheck = { ok: true; next: Date[] } | { ok: false; error: string };

/**
 * What the server will say about a cron in a timezone: valid, and its fires at least 5 minutes apart
 * (checked over the next fires, as the server does). With the next three fires when it is.
 */
export function checkCron(cron: string, timezone: string, after: Date = new Date()): CronCheck {
  if (!isTimezone(timezone)) return { ok: false, error: `“${timezone}” isn’t a timezone.` };
  let runs: Date[];
  try {
    runs = new Cron(cron, { timezone }).nextRuns(SAMPLED_FIRES + 1, after);
  } catch {
    return {
      ok: false,
      error: 'That isn’t a cron. It takes five fields: minute, hour, day of month, month and weekday.',
    };
  }
  if (runs.length === 0) return { ok: false, error: 'It never runs.' };
  for (let i = 1; i < runs.length; i += 1) {
    const gap = (runs[i]?.getTime() ?? 0) - (runs[i - 1]?.getTime() ?? 0);
    if (gap < MIN_INTERVAL_MS) return { ok: false, error: 'A schedule can run at most every 5 minutes.' };
  }
  return { ok: true, next: runs.slice(0, 3) };
}

/** A fire time in the schedule's timezone: "Mon 12 Oct, 9:00 AM". */
export function formatFire(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}
