/** Whether `timezone` is one this browser (and so the server's runtime) knows. */
export function isTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Every timezone this browser knows, with `include` (the current value) kept even if it doesn't. */
export function timezones(include?: string): string[] {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const all = new Set(['UTC', ...known]);
  if (include) all.add(include);
  return [...all].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What a clock in `timezone` reads at `date`. */
function wallClock(date: Date, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The day ("YYYY-MM-DD") `date` falls on in `timezone`; the browser's own day without one. */
export function dayIn(date: Date, timezone?: string): string {
  if (!timezone) return localDay(date);
  try {
    const { year, month, day } = wallClock(date, timezone);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  } catch {
    return localDay(date);
  }
}

/** The instant `day` ("YYYY-MM-DD") starts in `timezone`; the browser's own midnight without one. */
export function startOfDayIn(day: string, timezone?: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  const local = new Date(year, month - 1, date);
  if (!timezone) return local;
  try {
    const midnight = Date.UTC(year, month - 1, date);
    // How far the zone's clock is ahead of UTC at an instant, to the second.
    const offset = (at: number) => {
      const clock = wallClock(new Date(at), timezone);
      const wall = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
      return wall - Math.floor(at / 1000) * 1000;
    };
    // The offset near midnight, then at the instant that gives (it may change that night). Where the
    // clocks skip midnight, the day starts at the later one: the first that is on that day.
    const first = midnight - offset(midnight);
    const second = midnight - offset(first);
    const start = [Math.min(first, second), Math.max(first, second)].find(
      (at) => dayIn(new Date(at), timezone) === day,
    );
    return new Date(start ?? second);
  } catch {
    return local;
  }
}

/** `day` ("YYYY-MM-DD") moved by a number of days. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
