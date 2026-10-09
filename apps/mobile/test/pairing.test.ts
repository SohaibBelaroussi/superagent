import { describe, expect, it } from '@jest/globals';
import { deviceName, normalizeServer, parsePairingLink } from '../src/api/pairing';

const CODE = `sa_pair_${'p'.repeat(43)}`;
const link = (server: string, code = CODE) =>
  `superagent://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;

describe('pairing links', () => {
  it('reads the server and the code', () => {
    expect(parsePairingLink(link('https://superagent.example.ts.net/'))).toEqual({
      server: 'https://superagent.example.ts.net',
      code: CODE,
    });
  });

  it('ignores what isn’t a pairing link', () => {
    expect(parsePairingLink('https://example.com')).toBeNull();
    expect(parsePairingLink('superagent://tasks/1')).toBeNull();
    expect(parsePairingLink('not a link')).toBeNull();
  });

  it('refuses a link without a usable code', () => {
    expect(parsePairingLink(link('https://superagent.example.ts.net', 'sa_short'))).toEqual({
      error: expect.stringContaining('no code'),
    });
  });

  it('keeps plain HTTP to this computer, in development builds only', () => {
    expect(parsePairingLink(link('http://localhost:5173'))).toEqual({
      server: 'http://localhost:5173',
      code: CODE,
    });
    // The Android emulator's name for this computer.
    expect(normalizeServer('http://10.0.2.2:4111')).toEqual({ server: 'http://10.0.2.2:4111' });
    expect(parsePairingLink(link('http://192.168.1.20:4111'))).toEqual({
      error: expect.stringContaining('https://'),
    });
    expect(parsePairingLink(link('ftp://example.com'))).toEqual({
      error: expect.stringContaining('https://'),
    });
  });
});

describe('server addresses', () => {
  it('assumes https and keeps the origin', () => {
    expect(normalizeServer('superagent.example.ts.net/')).toEqual({
      server: 'https://superagent.example.ts.net',
    });
    expect(normalizeServer(' https://superagent.example.ts.net/v1 ')).toEqual({
      server: 'https://superagent.example.ts.net',
    });
    expect(normalizeServer('')).toEqual({ error: expect.any(String) });
  });
});

describe('the phone’s name', () => {
  it('says which phone it is', () => {
    expect(deviceName()).toBe('App: Pixel 9, Android 16');
  });
});
