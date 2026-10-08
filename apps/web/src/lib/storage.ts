/**
 * Local storage that never throws: private windows, blocked site data and sandboxed previews make
 * the accessor itself throw, and the app must still work (signed out, default theme).
 */
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing stored, nothing to remove.
    }
  },
};
