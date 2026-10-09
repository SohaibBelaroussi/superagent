import type { PushPayload } from '@superagent/shared';
import { AppState } from 'react-native';
import { loadPushKey } from '../api/storage';
import { openPush } from './crypto';
import { drawNotification } from './notifications';

type InApp = (payload: PushPayload) => void;
let inApp: InApp | null = null;

/** While the app is open, pushes come here (a banner inside it) instead of the notification shade. */
export function onPushInApp(listener: InApp | null): void {
  inApp = listener;
}

/**
 * A push as FCM delivers it (`{ v, c }`): read with this phone's key, then shown inside the app when
 * it's open, or drawn as a notification. One this phone can't read is dropped.
 */
export async function receivePush(data: Readonly<Record<string, unknown>>): Promise<void> {
  const key = await loadPushKey();
  if (!key) return;
  const payload = openPush(key, data);
  if (!payload) return;
  if (inApp && AppState.currentState === 'active') {
    inApp(payload);
    return;
  }
  const { kind, taskId, itemId, title, body } = payload;
  await drawNotification({ kind, taskId, itemId, title, body });
}
