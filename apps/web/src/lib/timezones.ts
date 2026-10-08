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
