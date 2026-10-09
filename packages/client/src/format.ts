/** USD for people: "$0", "<$0.0001", "$0.0042", "$1.23", "$1,234". */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${Number(usd.toPrecision(2))}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** A model's price in USD per million tokens, to the hundredth of a cent: "$3.00", "$0.075", "$0.0375". */
export function formatPrice(usd: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(usd);
}

/** Token counts, compact: "950", "12.3k", "1.25M". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trim(count / 1000, count < 10_000 ? 2 : 1)}k`;
  return `${trim(count / 1_000_000, 2)}M`;
}

function trim(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "3h ago", "2d ago", then a date; "in 3h" for times ahead. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  const diff = now - at;
  const ahead = diff < 0;
  const span = Math.abs(diff);
  if (span < 45_000) return ahead ? 'in a moment' : 'just now';
  const short =
    span < HOUR
      ? `${Math.round(span / MINUTE)}m`
      : span < DAY
        ? `${Math.round(span / HOUR)}h`
        : span < 7 * DAY
          ? `${Math.round(span / DAY)}d`
          : undefined;
  if (short) return ahead ? `in ${short}` : `${short} ago`;
  return formatDate(iso, now);
}

/** "Oct 8", or "Oct 8, 2025" outside the current year. */
export function formatDate(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** "Oct 8, 2026, 2:05 PM" in the viewer's locale and timezone. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "45s", "12m", "3h 5m", "2d 4h". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) {
    const minutes = Math.round((ms % HOUR) / MINUTE);
    return minutes ? `${Math.floor(ms / HOUR)}h ${minutes}m` : `${Math.floor(ms / HOUR)}h`;
  }
  const hours = Math.round((ms % DAY) / HOUR);
  return hours ? `${Math.floor(ms / DAY)}d ${hours}h` : `${Math.floor(ms / DAY)}d`;
}

/** "a", "b" and "c". */
export function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "1 task", "3 tasks". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "512 B", "2.4 KB", "13 KB", "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A tool call's arguments, indented for reading: JSON as JSON (parsed when it came as a string). */
export function prettyArgs(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}
