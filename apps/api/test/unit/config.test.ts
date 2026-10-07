import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config';

const base = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/superagent',
  SUPERAGENT_ADMIN_TOKEN: 'x'.repeat(32),
  SUPERAGENT_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 4111,
      LOG_LEVEL: 'info',
      DEFAULT_TIMEZONE: 'Asia/Qatar',
      CORS_ORIGINS: [],
    });
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ ...base, STUDIO_TOKEN: '', PORT: '', CORS_ORIGINS: '' });
    expect(config.STUDIO_TOKEN).toBeUndefined();
    expect(config.PORT).toBe(4111);
    expect(config.CORS_ORIGINS).toEqual([]);
  });

  it('reports every invalid key at once', () => {
    const run = () => loadConfig({ DATABASE_URL: 'mysql://nope', SUPERAGENT_ADMIN_TOKEN: 'short' });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/DATABASE_URL[\s\S]*SUPERAGENT_ADMIN_TOKEN/);
  });

  it('requires a 32-byte encryption key', () => {
    expect(() =>
      loadConfig({ ...base, SUPERAGENT_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/SUPERAGENT_ENCRYPTION_KEY/);
  });

  it('rejects connection strings that are not valid URLs', () => {
    expect(() =>
      loadConfig({ ...base, DATABASE_URL: 'postgres://superagent:ab/cd@postgres:5432/db' }),
    ).toThrow(/percent-encode/);
  });

  it('rejects unknown timezones', () => {
    expect(() => loadConfig({ ...base, DEFAULT_TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA timezone/);
  });

  it('splits and trims CORS origins', () => {
    const config = loadConfig({ ...base, CORS_ORIGINS: 'http://localhost:3000, https://app.example ,' });
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:3000', 'https://app.example']);
  });
});
