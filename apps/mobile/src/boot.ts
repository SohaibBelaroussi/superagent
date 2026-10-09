import * as ExpoCrypto from 'expo-crypto';

/*
 * Runs before any other module of the app.
 */

/**
 * Zod compiles object parsers with `new Function` when it may; Hermes allows it but compiles slowly and
 * without a JIT, and the web app runs jitless already (its CSP forbids eval). Same parsing on both,
 * set before any schema is made.
 */
const zod = globalThis as { __zod_globalConfig?: Record<string, unknown> };
zod.__zod_globalConfig = { ...zod.__zod_globalConfig, jitless: true };

/**
 * Hermes has no Web Crypto. The shared code makes ids (idempotency keys) with `crypto.randomUUID`,
 * so the system's secure random generator stands in for it, through expo-crypto.
 */
const runtime = globalThis as { crypto?: Partial<Crypto> };
if (typeof runtime.crypto?.randomUUID !== 'function') {
  runtime.crypto = {
    ...runtime.crypto,
    randomUUID: ExpoCrypto.randomUUID as Crypto['randomUUID'],
    getRandomValues: ExpoCrypto.getRandomValues as Crypto['getRandomValues'],
  };
}
