// What a live view's keys mean to Chromium (CDP's Input.dispatchKeyEvent).

/** Windows virtual key codes for keys that type no text (CDP needs them to act on the key). */
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

/**
 * A key's Windows virtual key code, which Chromium needs to act on a key that types nothing and to run
 * a shortcut (Ctrl+A, Ctrl+C), as Windows reports it:
 * - the named keys above;
 * - a letter or digit by what it is on the layout in use, so Ctrl+A selects all on AZERTY and Ctrl+Z
 *   undoes on QWERTZ;
 * - on a layout without Latin letters (Cyrillic, Greek), by the key's place (`code`).
 */
export function virtualKey(key?: string, code?: string): number | undefined {
  if (key !== undefined && Object.hasOwn(VIRTUAL_KEYS, key)) return VIRTUAL_KEYS[key];
  if (key && /^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  const physical = code ? (/^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1]) : undefined;
  return physical?.charCodeAt(0);
}
