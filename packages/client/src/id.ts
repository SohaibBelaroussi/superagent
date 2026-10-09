/**
 * A random id (idempotency keys). `crypto.randomUUID` exists only in secure contexts, and the app may be
 * opened over plain HTTP on a tailnet address; `getRandomValues` works everywhere.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
