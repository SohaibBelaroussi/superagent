import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, apiUrl, configureClient, isAbortError, ProblemError } from '../src/http';

const Ok = z.object({ ok: z.boolean() });

describe('the client', () => {
  afterEach(() => configureClient({ baseUrl: '' }));

  it('calls the configured server through its fetch', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    configureClient({ baseUrl: 'https://superagent.example.ts.net/', fetch: fetchImpl });

    expect(apiUrl('/v1/me')).toBe('https://superagent.example.ts.net/v1/me');
    await expect(
      api(Ok, '/v1/board', { query: { departmentId: 'd1', empty: '', none: undefined } }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://superagent.example.ts.net/v1/board?departmentId=d1');
  });

  it('keeps paths relative by default (the web app, served by the API)', () => {
    expect(apiUrl('/v1/events')).toBe('/v1/events');
  });

  it('says what a network failure means in this app', async () => {
    configureClient({
      baseUrl: 'https://superagent.example.ts.net',
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
      networkErrorDetail: 'Can’t reach superagent. Is Tailscale on?',
    });
    const failure = api(Ok, '/v1/me');
    await expect(failure).rejects.toBeInstanceOf(ProblemError);
    await expect(failure).rejects.toMatchObject({
      status: 0,
      message: 'Can’t reach superagent. Is Tailscale on?',
    });
  });

  it('lets an abort through, whatever runtime made it', async () => {
    // React Native has no DOMException: its aborts are plain errors named AbortError.
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    configureClient({
      baseUrl: '',
      fetch: async () => {
        throw abort;
      },
    });
    await expect(api(Ok, '/v1/me')).rejects.toBe(abort);
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
