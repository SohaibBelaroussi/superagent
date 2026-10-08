import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { storage } from './storage';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'superagent.theme';
const listeners = new Set<() => void>();
/** The choice when storage is blocked: kept for this page's lifetime. */
let unsaved: ThemeChoice | null = null;

function read(): ThemeChoice {
  const saved = storage.get(KEY) ?? unsaved;
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

function systemTheme(): 'light' | 'dark' {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/** Puts the theme's class on <html> (the same one public/theme.js sets before the first paint). */
function apply(choice: ThemeChoice): void {
  const theme = choice === 'system' ? systemTheme() : choice;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved choice, and a setter that applies and saves it. Follows the system while on "system". */
export function useTheme(): { choice: ThemeChoice; setChoice(choice: ThemeChoice): void } {
  const choice = useSyncExternalStore(subscribe, read, () => 'system' as const);

  useEffect(() => {
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const follow = () => apply('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    unsaved = next;
    if (next === 'system') storage.remove(KEY);
    else storage.set(KEY, next);
    apply(next);
    for (const listener of listeners) listener();
  }, []);

  return { choice, setChoice };
}
