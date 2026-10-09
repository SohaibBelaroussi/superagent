import { gcm } from '@noble/ciphers/aes.js';
import { type PushPayload, PushPayloadSchema } from '@superagent/shared';

/*
 * The phone's half of D54: a key made here, sealed on the server, and every notification's payload
 * encrypted with it (AES-256-GCM), so Google sees only ciphertext. The data FCM delivers is
 * `{ v: '1', c: base64(nonce | ciphertext | tag) }`.
 */

/** What the server binds every payload to (the additional data of the GCM seal). */
const AAD = 'superagent-push-v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromAscii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
/** UTF-8 to text without `TextDecoder`, which Hermes may lack. Malformed input throws. */
const utf8 = (bytes: Uint8Array) =>
  decodeURIComponent(Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));

/** A new key for this phone's notifications: 32 random bytes, base64. */
export function newPushKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * What a push says, read with this phone's key. Null when it can't be read: not ours, sealed with a
 * key this phone no longer has, tampered with, or not a payload this version knows.
 */
export function openPush(key: string, data: Readonly<Record<string, unknown>>): PushPayload | null {
  if (data.v !== '1' || typeof data.c !== 'string') return null;
  try {
    const sealed = fromBase64(data.c);
    if (sealed.length < NONCE_BYTES + TAG_BYTES) return null;
    const cipher = gcm(fromBase64(key), sealed.subarray(0, NONCE_BYTES), fromAscii(AAD));
    const parsed = PushPayloadSchema.safeParse(
      JSON.parse(utf8(cipher.decrypt(sealed.subarray(NONCE_BYTES)))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
