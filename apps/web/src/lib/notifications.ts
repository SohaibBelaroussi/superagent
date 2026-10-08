import { useSyncExternalStore } from 'react';
import { storage } from './storage';

/** Whether you turned notifications on in this browser (they also need the browser's permission). */
const KEY = 'superagent.notify';

const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** The browser can show notifications here: it has the API, and the page is a secure context. */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;
}

/** On: you asked for them, and the browser allows them. */
export function notificationsOn(): boolean {
  return notificationsSupported() && storage.get(KEY) === 'on' && Notification.permission === 'granted';
}

/** Asks the browser once, and remembers your choice. Resolves to whether they are on now. */
export async function turnOnNotifications(): Promise<'on' | 'blocked' | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  const permission =
    Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return 'blocked';
  storage.set(KEY, 'on');
  changed();
  return 'on';
}

export function turnOffNotifications(): void {
  storage.remove(KEY);
  changed();
}

/** Re-renders the caller when notifications are turned on or off here. */
export function useNotificationsOn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notificationsOn,
    () => false,
  );
}
