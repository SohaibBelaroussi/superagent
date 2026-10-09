import { Storage } from 'expo-sqlite/kv-store';

/**
 * Settings that aren't secret (the theme, which notifications to show), read synchronously so the
 * first frame already follows them. Secrets go in the keystore (`../api/storage.ts`), never here.
 * Never throws: an unreadable store falls back to the defaults.
 */
export const preferences = {
  get(key: string): string | null {
    try {
      return Storage.getItemSync(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      Storage.setItemSync(key, value);
    } catch {
      // Not kept: the default comes back next time.
    }
  },
  remove(key: string): void {
    try {
      Storage.removeItemSync(key);
    } catch {
      // Nothing to remove.
    }
  },
};
