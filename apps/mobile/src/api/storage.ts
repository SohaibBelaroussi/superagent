import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

/** What signing in leaves on the phone: the server, and the device token it gave (D53). */
const StoredSessionSchema = z.object({
  server: z.string().min(1),
  token: z.string().min(1),
  tokenId: z.string().min(1),
  tokenName: z.string(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

const KEY = 'superagent.session';
/** In the keystore (Keystore on Android, the Keychain on iOS), readable once the phone is unlocked. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
    if (!raw) return null;
    const parsed = StoredSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** False when the keystore refused it: the app is signed in until it closes, then asks again. */
export async function saveSession(session: StoredSession): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(session), OPTIONS);
    return true;
  } catch {
    return false;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Nothing stored.
  }
}

const PUSH_KEY = 'superagent.push-key';
/** Read when a push arrives, which can be while the phone is locked (after its first unlock). */
const PUSH_KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** The key this phone's notifications are encrypted with (D54), if it gets them. */
export async function loadPushKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PUSH_KEY, PUSH_KEY_OPTIONS);
  } catch {
    return null;
  }
}

export async function savePushKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_KEY, key, PUSH_KEY_OPTIONS);
}

export async function clearPushKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PUSH_KEY, PUSH_KEY_OPTIONS);
  } catch {
    // Nothing stored.
  }
}
