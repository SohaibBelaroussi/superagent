import { registerPush, unregisterPush } from '@superagent/client';
import type { PushDevice, PushKind } from '@superagent/shared';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { clearPushKey, loadPushKey, savePushKey } from '../api/storage';
import { newPushKey } from './crypto';
import { setUpNotifications } from './notifications';

/** Push reaches Android phones now; iPhones need APNs and Apple's developer program (later). */
export const pushAvailable = () => Platform.OS === 'android';

/** Why push couldn't be turned on, in the phone's terms. */
export class PushSetupError extends Error {
  constructor(
    readonly reason: 'denied' | 'no-firebase',
    message: string,
  ) {
    super(message);
  }
}

/** The permission, asked for only once the channels exist (Android 13 asks only then). */
async function allow(): Promise<void> {
  await setUpNotifications();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return;
  const asked = current.canAskAgain ? await Notifications.requestPermissionsAsync() : current;
  if (!asked.granted) {
    throw new PushSetupError('denied', 'Notifications are off for superagent in Android’s settings.');
  }
}

/** FCM's token for this install. A build without a Firebase project has none. */
async function pushToken(): Promise<string> {
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return String(token.data);
  } catch {
    throw new PushSetupError(
      'no-firebase',
      'This build of the app has no Firebase project (google-services.json), so it can’t get notifications.',
    );
  }
}

/**
 * Registers this phone for `kinds`, or changes them: the permission, FCM's token, and the key payloads
 * are encrypted with (made once, kept in the keystore until push is turned off). The key is stored
 * before the server knows it, so a push that arrives at once can be read.
 */
export async function registerThisPhone(kinds: PushKind[], token?: string): Promise<PushDevice> {
  await allow();
  const fcmToken = token ?? (await pushToken());
  let key = await loadPushKey();
  if (!key) {
    key = newPushKey();
    await savePushKey(key);
  }
  return registerPush({ platform: 'android', pushToken: fcmToken, key, kinds });
}

/** Stops this phone's pushes, and forgets their key. */
export async function unregisterThisPhone(): Promise<void> {
  await unregisterPush();
  await clearPushKey();
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
}

/** FCM replaced this install's token: the server gets the new one (no permission asked). */
export async function sendNewToken(kinds: PushKind[], token: string): Promise<PushDevice | null> {
  const key = await loadPushKey();
  if (!key) return null;
  return registerPush({ platform: 'android', pushToken: token, key, kinds });
}

/** Signed out: the server dropped the registration with the token; the phone drops the rest. */
export async function forgetPush(): Promise<void> {
  await clearPushKey();
  if (!pushAvailable()) return;
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
  await Notifications.setBadgeCountAsync(0).catch(() => {});
}
