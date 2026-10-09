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
