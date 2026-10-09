import { PUSH_KIND_ORDER, registerPush, unregisterPush } from '@superagent/client';
import { type PushDevice, type PushKind, PushKindSchema } from '@superagent/shared';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { clearPushKey, loadPushKey, savePushKey } from '../api/storage';
import { preferences } from '../lib/preferences';
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

/*
 * What this phone last told the server: FCM's token (asking for it also announces it to the token
 * listener, which mustn't send it again with older kinds), and the kinds (kept, so a registration the
 * server dropped can be made again as it was).
 */
let sentToken: string | null = null;
/** Registrations under way: they send the token themselves. */
let registering = 0;
const KINDS = 'push.kinds';

function chosenKinds(): PushKind[] | null {
  try {
    const parsed = PushKindSchema.array().safeParse(JSON.parse(preferences.get(KINDS) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function send(token: string, key: string, kinds: PushKind[]): Promise<PushDevice> {
  const previous = sentToken;
  sentToken = token;
  try {
    const device = await registerPush({ platform: 'android', pushToken: token, key, kinds });
    preferences.set(KINDS, JSON.stringify(device.kinds));
    return device;
  } catch (error) {
    sentToken = previous;
    throw error;
  }
}

/**
 * Registers this phone for `kinds`, or changes them: the permission, FCM's token, and the key payloads
 * are encrypted with (made once, kept in the keystore until push is turned off). The key is stored
 * before the server knows it, so a push that arrives at once can be read.
 */
export async function registerThisPhone(kinds: PushKind[]): Promise<PushDevice> {
  registering += 1;
  try {
    await allow();
    const token = await pushToken();
    let key = await loadPushKey();
    if (!key) {
      key = newPushKey();
      await savePushKey(key);
    }
    return await send(token, key, kinds);
  } finally {
    registering -= 1;
  }
}

/** Stops this phone's pushes, and forgets their key. */
export async function unregisterThisPhone(): Promise<void> {
  await unregisterPush();
  await forgetLocally();
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
}

/**
 * FCM's token for this install, if the server doesn't have it yet (FCM replaced it, or this is the
 * first start since). Null when there was nothing to send. No permission is asked.
 */
export async function sendNewToken(token: string, kinds: PushKind[]): Promise<PushDevice | null> {
  if (token === sentToken || registering > 0) return null;
  // Claimed before anything is awaited: the same token announced twice goes once.
  const previous = sentToken;
  sentToken = token;
  try {
    const key = await loadPushKey();
    if (!key) {
      sentToken = previous;
      return null;
    }
    return await send(token, key, kinds);
  } catch (error) {
    sentToken = previous;
    throw error;
  }
}

/**
 * The server dropped this phone's registration while it still holds a key (FCM reported its old token
 * gone): registers it again as it was, if Android still allows notifications. Null when it can't.
 */
export async function restoreRegistration(): Promise<PushDevice | null> {
  const key = await loadPushKey();
  const kinds = chosenKinds() ?? [...PUSH_KIND_ORDER];
  if (!key) return null;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return null;
  await setUpNotifications();
  return send(await pushToken(), key, kinds);
}

async function forgetLocally(): Promise<void> {
  sentToken = null;
  preferences.remove(KINDS);
  await clearPushKey();
}

/** Signed out: the server dropped the registration with the token; the phone drops the rest. */
export async function forgetPush(): Promise<void> {
  await forgetLocally();
  if (!pushAvailable()) return;
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
  await Notifications.setBadgeCountAsync(0).catch(() => {});
}
