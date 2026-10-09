import { createCipheriv, createPrivateKey, createSign, randomBytes } from 'node:crypto';
import type { PushPayload } from '@superagent/shared';

/** The context the Firebase service account is sealed under (SecretBox). */
export const accountContext = 'push:fcm:service-account';

/** The fields of a Firebase service account key that sending needs. */
export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Reads a service account key file's JSON, as Google gives it. Throws, saying what's wrong. */
export function parseServiceAccount(json: string): ServiceAccount {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('That isn’t JSON: paste the whole key file.');
  }
  const fields = (value ?? {}) as Record<string, unknown>;
  if (fields.type !== 'service_account') {
    throw new Error('That isn’t a service account key: its "type" should be "service_account".');
  }
  const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '');
  const account = {
    projectId: text('project_id'),
    clientEmail: text('client_email'),
    privateKey: text('private_key'),
  };
  if (!account.projectId || !account.clientEmail || !account.privateKey) {
    throw new Error('The key file has no project_id, client_email or private_key.');
  }
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(account.projectId))
    throw new Error('Its project_id isn’t a Firebase project id.');
  try {
    createPrivateKey(account.privateKey);
  } catch {
    throw new Error('Its private key can’t be read.');
  }
  return account;
}

/** Binds a payload to this use of the key. */
const AAD = Buffer.from('superagent-push-v1');

/**
 * A notification's payload for one device (D54): AES-256-GCM with the key the device gave, as base64 of
 * the nonce, the ciphertext and the tag. FCM carries it without being able to read it.
 */
export function encryptPayload(keyBase64: string, payload: PushPayload): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), nonce);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

export type SendResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface FcmOptions {
  /** https://fcm.googleapis.com */
  fcmUrl: string;
  /** https://oauth2.googleapis.com/token, also the JWT's audience. */
  oauthUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sends data messages through FCM's HTTP v1 API (D54), without an SDK: a JWT signed with the service
 * account's key is exchanged at Google's OAuth server for an access token, kept until shortly before
 * it expires.
 */
export class FcmSender {
  private access: { account: ServiceAccount; token: string; expiresAt: number } | null = null;

  constructor(private readonly options: FcmOptions) {}

  async send(account: ServiceAccount, pushToken: string, data: Record<string, string>): Promise<SendResult> {
    const token = await this.accessToken(account);
    const response = await this.fetch(
      `${this.options.fcmUrl}/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        // High priority wakes the app to draw it (data messages carry no notification of their own).
        body: JSON.stringify({
          message: { token: pushToken, data, android: { priority: 'HIGH', ttl: '86400s' } },
        }),
      },
    );
    if (response.ok) return { ok: true };
    const text = (await response.text()).slice(0, 500);
    if (response.status === 401) this.access = null;
    // The app was uninstalled, or its token replaced: its registration can go. Only FCM's own word for
    // it counts: a 404 alone could be a wrong project, and would drop every phone.
    const gone = text.includes('UNREGISTERED');
    return { ok: false, gone, error: `FCM answered ${response.status}: ${text}` };
  }

  /** Checks that Google accepts the service account, by getting a fresh access token with it. */
  async check(account: ServiceAccount): Promise<void> {
    this.access = null;
    await this.accessToken(account);
  }

  private async accessToken(account: ServiceAccount): Promise<string> {
    const now = Date.now();
    if (this.access && this.access.account === account && this.access.expiresAt > now + 60_000) {
      return this.access.token;
    }
    const iat = Math.floor(now / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({
        iss: account.clientEmail,
        scope: SCOPE,
        aud: this.options.oauthUrl,
        iat,
        exp: iat + 3600,
      }),
    )}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.privateKey);
    const response = await this.fetch(this.options.oauthUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${b64url(signature)}`,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(
        `Google refused the service account (${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('Google sent no access token');
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.access = { account, token: body.access_token, expiresAt: now + seconds * 1000 };
    return body.access_token;
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
  }
}
