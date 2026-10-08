import { useSyncExternalStore } from 'react';
import { storage } from './storage';

/** Whether you turned notifications on in this browser (they also need the browser's permission). */
const KEY = 'superagent.notify';

const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** Another tab turning them on or off changes the stored choice: tell this one's listeners too. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The browser has the API, and the page is a secure context. Mobile browsers have the API but refuse to
 * build a notification from a page (they need a service worker): turning them on finds that out.
 */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;
}

/** On: you asked for them, and the browser allows them. */
export function notificationsOn(): boolean {
  return notificationsSupported() && storage.get(KEY) === 'on' && Notification.permission === 'granted';
}

/**
 * Shows one notification. False when the browser refuses to (most mobile browsers throw here), and
 * then they are turned off, so it isn't tried again.
 */
export function showNotification(title: string, options: NotificationOptions, onClick?: () => void): boolean {
  try {
    const notification = new Notification(title, options);
    if (onClick) {
      notification.onclick = () => {
        onClick();
        notification.close();
      };
    }
    return true;
  } catch {
    turnOffNotifications();
    return false;
  }
}

export type TurnOnResult = 'on' | 'blocked' | 'dismissed' | 'unsupported';

/**
 * Asks the browser (once), then shows a first notification to be sure this browser can: only then are
 * they on.
 */
export async function turnOnNotifications(): Promise<TurnOnResult> {
  if (!notificationsSupported()) return 'unsupported';
  const permission =
    Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'dismissed';
  if (!storage.set(KEY, 'on')) return 'unsupported';
  if (
    !showNotification('Notifications are on', {
      body: 'This is how superagent tells you something needs you.',
      tag: 'superagent:on',
    })
  ) {
    return 'unsupported';
  }
  changed();
  return 'on';
}

export function turnOffNotifications(): void {
  storage.remove(KEY);
  changed();
}

/** Re-renders the caller when notifications are turned on or off, here or in another tab. */
export function useNotificationsOn(): boolean {
  return useSyncExternalStore(subscribe, notificationsOn, () => false);
}
