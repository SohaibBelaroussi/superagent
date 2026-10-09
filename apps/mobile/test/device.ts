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

type Listener<T> = (value: T) => void;
interface Shown {
  identifier: string;
  content: {
    title: string;
    body: string;
    subtitle?: string;
    data: Record<string, unknown>;
    categoryIdentifier?: string;
  };
  trigger: { channelId: string } | null;
}

/**
 * expo-notifications, as far as the app uses it: the channels and actions it sets up, the
 * notifications it draws (`shade`), the permission, FCM's token, and the listeners a test fires.
 */
const notificationState = {
  shade: new Map<string, Shown>(),
  channels: new Map<string, { name: string; lockscreenVisibility?: number }>(),
  categories: new Map<string, Array<{ identifier: string }>>(),
  permission: { granted: false, canAskAgain: true },
  /** What the permission prompt answers. */
  answer: true,
  prompts: 0,
  fcmToken: 'fcm-token-1' as string | null,
  badge: 0,
  responseListeners: [] as Array<Listener<unknown>>,
  tokenListeners: [] as Array<Listener<{ type: string; data: string }>>,
};

export const notifications = {
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0, PUBLIC: 1, SECRET: -1 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: jest.fn(),
  registerTaskAsync: jest.fn(async () => null),
  setNotificationChannelAsync: jest.fn(
    async (id: string, channel: { name: string; lockscreenVisibility?: number }) => {
      notificationState.channels.set(id, channel);
      return channel;
    },
  ),
  setNotificationCategoryAsync: jest.fn(async (id: string, actions: Array<{ identifier: string }>) => {
    notificationState.categories.set(id, actions);
    return { identifier: id, actions };
  }),
  scheduleNotificationAsync: jest.fn(async (request: Shown) => {
    notificationState.shade.set(request.identifier, request);
    return request.identifier;
  }),
  dismissNotificationAsync: jest.fn(async (identifier: string) => {
    notificationState.shade.delete(identifier);
  }),
  dismissAllNotificationsAsync: jest.fn(async () => {
    notificationState.shade.clear();
  }),
  getPermissionsAsync: jest.fn(async () => ({ ...notificationState.permission })),
  requestPermissionsAsync: jest.fn(async () => {
    notificationState.prompts += 1;
    notificationState.permission = {
      granted: notificationState.answer,
      canAskAgain: notificationState.answer,
    };
    return { ...notificationState.permission };
  }),
  // As on Android, asking for the token also announces it to the token listeners.
  getDevicePushTokenAsync: jest.fn(async () => {
    if (!notificationState.fcmToken) throw new Error('Default FirebaseApp is not initialized');
    const token = { type: 'android', data: notificationState.fcmToken };
    for (const listener of [...notificationState.tokenListeners]) listener(token);
    return token;
  }),
  setBadgeCountAsync: jest.fn(async (count: number) => {
    notificationState.badge = count;
    return true;
  }),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn((listener: Listener<unknown>) => {
    notificationState.responseListeners.push(listener);
    return {
      remove: () =>
        notificationState.responseListeners.splice(notificationState.responseListeners.indexOf(listener), 1),
    };
  }),
  addPushTokenListener: jest.fn((listener: Listener<{ type: string; data: string }>) => {
    notificationState.tokenListeners.push(listener);
    return {
      remove: () =>
        notificationState.tokenListeners.splice(notificationState.tokenListeners.indexOf(listener), 1),
    };
  }),
};

export const phone = notificationState;

/** expo-task-manager: the tasks the app defines, for a test to run as Android would. */
export const tasks = new Map<
  string,
  (body: { data: unknown; error: null; executionInfo: unknown }) => unknown
>();
export const taskManager = {
  defineTask: (
    name: string,
    executor: (body: { data: unknown; error: null; executionInfo: unknown }) => unknown,
  ) => {
    tasks.set(name, executor);
  },
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
  notificationState.shade.clear();
  notificationState.channels.clear();
  notificationState.categories.clear();
  notificationState.permission = { granted: false, canAskAgain: true };
  notificationState.answer = true;
  notificationState.prompts = 0;
  notificationState.fcmToken = 'fcm-token-1';
  notificationState.badge = 0;
  notificationState.responseListeners = [];
  notificationState.tokenListeners = [];
  secure.clear();
  kv.clear();
  clipboardText = '';
  networkListeners = [];
  jest.clearAllMocks();
}
