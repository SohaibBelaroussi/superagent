import { randomBytes } from 'node:crypto';
import type { AttentionList } from '@superagent/shared';
import { afterAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { jsonHeaders, startTestSystem } from './helpers';

describe('the encryption key check', () => {
  let system: System | undefined;
  const send = (method: string, path: string, body?: unknown) =>
    (system as System).app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const keyCheck = async () =>
    ((await (await send('GET', '/ready')).json()) as { checks: { encryptionKey: string } }).checks
      .encryptionKey;
  const restart = async (env: Record<string, string> = {}) => {
    const databaseUrl = (system as System).config.DATABASE_URL;
    await system?.close();
    system = await startTestSystem({ databaseUrl, env });
  };

  afterAll(async () => {
    await system?.close();
  });

  it("reports at boot whether the key opens the database's secrets (a restore with another .env)", async () => {
    system = await startTestSystem();
    // Nothing sealed yet: any key will do.
    expect(await keyCheck()).toBe('empty');
    expect((await send('PUT', '/v1/secrets/KEY_CHECK', { value: 'sealed-with-the-first-key' })).status).toBe(
      200,
    );

    await restart();
    expect(await keyCheck()).toBe('ok');
    let attention = (await (await send('GET', '/v1/attention')).json()) as AttentionList;
    expect(attention.items.map((item) => item.id)).not.toContain('health:encryption-key');

    await restart({ SUPERAGENT_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(await keyCheck()).toBe('mismatch');
    attention = (await (await send('GET', '/v1/attention')).json()) as AttentionList;
    expect(attention.items.find((item) => item.id === 'health:encryption-key')?.title).toMatch(
      /encryption key doesn't open/,
    );
  }, 60_000);
});
