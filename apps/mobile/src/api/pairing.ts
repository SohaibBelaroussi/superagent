import Constants from 'expo-constants';
import * as Device from 'expo-device';

/** What a pairing code from the web app's Devices page carries (D53). */
export interface PairingLink {
  server: string;
  code: string;
}

const CODE = /^sa_pair_[A-Za-z0-9_-]{43}$/;

/** Which build this is (app.config.ts): development and test builds may use plain HTTP to localhost. */
export const variant: string = (Constants.expoConfig?.extra?.variant as string | undefined) ?? 'development';

/**
 * A server address as typed or carried by a link: its origin, `https://` when no scheme is given.
 * Plain HTTP only reaches localhost, and only in development and test builds.
 */
export function normalizeServer(input: string): { server: string } | { error: string } {
  const text = input.trim().replace(/\/+$/, '');
  if (!text) return { error: 'Enter the server’s address.' };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: 'That isn’t an address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'The address starts with https://.' };
  }
  if (url.protocol === 'http:') {
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (variant === 'production' || !local) {
      return { error: 'Use the server’s https:// address (its tailnet name from `tailscale serve`).' };
    }
  }
  return { server: url.origin };
}

/**
 * Reads a pairing link (`superagent://pair?server=…&code=…`), scanned or pasted. Null when it isn't
 * one; an error when it is one the app can't use.
 */
export function parsePairingLink(text: string): PairingLink | { error: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const target = (url.host || url.pathname).replace(/^\/+/, '');
  if (url.protocol !== 'superagent:' || target !== 'pair') return null;
  const code = url.searchParams.get('code') ?? '';
  if (!CODE.test(code)) return { error: 'This pairing link has no code the app can use. Make a new one.' };
  const server = normalizeServer(url.searchParams.get('server') ?? '');
  if ('error' in server) return server;
  return { server: server.server, code };
}

/** "App: Pixel 9, Android 16": how this phone's token appears in the web app's device list. */
export function deviceName(): string {
  const system = [Device.osName, Device.osVersion].filter(Boolean).join(' ');
  const parts = [Device.modelName, system].filter((part): part is string => Boolean(part));
  return `App: ${parts.length ? parts.join(', ') : 'a phone'}`;
}
