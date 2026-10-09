/*
 * Before anything loads, as `src/boot.ts` does on a phone: zod parses jitless, and a secure random
 * generator stands where Hermes has none (Node's own here).
 */
import { webcrypto } from 'node:crypto';

const zod = globalThis as { __zod_globalConfig?: Record<string, unknown> };
zod.__zod_globalConfig = { ...zod.__zod_globalConfig, jitless: true };

const runtime = globalThis as { crypto?: unknown };
if (!runtime.crypto) runtime.crypto = webcrypto;
