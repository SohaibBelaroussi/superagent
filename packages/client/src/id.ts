/**
 * A random id (idempotency keys). `crypto.randomUUID` exists only in secure contexts, and the web app
 * may be opened over plain HTTP on a tailnet address; `getRandomValues` works everywhere. React Native
 * has neither until the app provides them (the phone app does, at startup).
 */
export function randomId(): string {
  const random = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  if (typeof random?.getRandomValues !== 'function') {
    throw new Error('No secure random generator in this runtime (globalThis.crypto)');
  }
  const bytes = random.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
