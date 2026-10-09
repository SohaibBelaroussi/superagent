/*
 * In-memory stand-ins for the phone's native modules (test/setup.ts mocks them with these), and what
 * a test reads back: the keystore, the preferences, the clipboard, the browser.
 */
import { jest } from '@jest/globals';

const secure = new Map<string, string>();
const kv = new Map<string, string>();
let clipboardText = '';
let networkListeners: Array<(state: { isConnected: boolean }) => void> = [];

export const secureStore = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  getItemAsync: jest.fn(async (key: string) => secure.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secure.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    secure.delete(key);
  }),
};

export const kvStore = {
  getItemSync: (key: string) => kv.get(key) ?? null,
  setItemSync: (key: string, value: string) => {
    kv.set(key, value);
  },
  removeItemSync: (key: string) => kv.delete(key),
};

export const network = {
  addNetworkStateListener: (listener: (state: { isConnected: boolean }) => void) => {
    networkListeners.push(listener);
    return {
      remove: () => {
        networkListeners = networkListeners.filter((item) => item !== listener);
      },
    };
  },
  getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }),
};

export const clipboard = {
  getStringAsync: jest.fn(async () => clipboardText),
  setStringAsync: jest.fn(async (text: string) => {
    clipboardText = text;
    return true;
  }),
};

export const browser = {
  openBrowserAsync: jest.fn(async (_url: string) => ({ type: 'opened' })),
};

/** What the keystore holds under `key`, parsed. */
export function stored(key = 'superagent.session'): Record<string, string> | null {
  const raw = secure.get(key);
  return raw ? (JSON.parse(raw) as Record<string, string>) : null;
}

/** Everything the keystore holds, as text: to check what never lands there. */
export function keystoreText(): string {
  return [...secure.values()].join('\n');
}

export function putInKeystore(key: string, value: string): void {
  secure.set(key, value);
}

export function copyToClipboard(text: string): void {
  clipboardText = text;
}

export function resetDevice(): void {
  secure.clear();
  kv.clear();
  clipboardText = '';
  networkListeners = [];
  jest.clearAllMocks();
}
