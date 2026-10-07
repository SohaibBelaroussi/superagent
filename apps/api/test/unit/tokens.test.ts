import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, TokenService, tokenPrefix } from '../../src/auth/tokens';
import type { Db } from '../../src/db/client';

const ADMIN = `sa_admin_${'a'.repeat(40)}`;

/** A database that fails the test if anything touches it. */
const untouchableDb = new Proxy({} as Db, {
  get() {
    throw new Error('database should not be used');
  },
});

describe('token helpers', () => {
  it('generates 256-bit url-safe tokens with the sa_ prefix', () => {
    const token = generateToken();
    expect(token).toMatch(/^sa_[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
  });

  it('hashes deterministically to hex sha256', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('keeps a short prefix for display only', () => {
    expect(tokenPrefix('sa_ABCDEFGHIJKLMNOP')).toBe('sa_ABCDEF');
  });
});

describe('TokenService.verify', () => {
  const service = new TokenService(untouchableDb, ADMIN);

  it('accepts the admin token without a database lookup', async () => {
    await expect(service.verify(ADMIN)).resolves.toMatchObject({ id: 'owner', tokenId: 'admin' });
  });

  it('rejects empty and oversized tokens without a database lookup', async () => {
    await expect(service.verify('')).resolves.toBeNull();
    await expect(service.verify('x'.repeat(513))).resolves.toBeNull();
  });
});
