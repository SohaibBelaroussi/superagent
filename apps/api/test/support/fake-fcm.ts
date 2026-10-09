// A fake of what push sends to (D54): Google's OAuth token endpoint, which checks the JWT's signature
// against the service account's public key, and FCM's HTTP v1 send API. It records the messages.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SentMessage {
  projectId: string;
  token: string;
  data: Record<string, string>;
  android: unknown;
}

export interface FakeFcm {
  /** PUSH_FCM_URL */
  fcmUrl: string;
  /** PUSH_OAUTH_URL */
  oauthUrl: string;
  /** A service account key file whose key the fake knows. */
  serviceAccount(projectId?: string): string;
  /** A key file signed with a key Google wouldn't know. */
  strangerAccount(): string;
  messages: SentMessage[];
  /** Access tokens handed out. */
  tokensIssued: number;
  /** Push tokens FCM no longer knows: sending to them answers 404 UNREGISTERED. */
  gone: Set<string>;
  /** Answers this many sends with 503, as FCM does when it's struggling. */
  failSends: number;
  /** Google refuses every service account (its OAuth server is down, or the key was deleted). */
  refuseTokens: boolean;
  /** Forgets the access tokens it issued: the next send answers 401. */
  revokeAccess(): void;
  close(): Promise<void>;
}

const pem = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

export async function startFakeFcm(): Promise<FakeFcm> {
  const known = pem();
  const stranger = pem();
  const messages: SentMessage[] = [];
  const gone = new Set<string>();
  const issued = new Set<string>();
  const state = { tokensIssued: 0, failSends: 0, refuseTokens: false };

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'POST' && req.url === '/token') {
      const assertion = new URLSearchParams(raw).get('assertion') ?? '';
      const [header, claims, signature] = assertion.split('.');
      const valid =
        header !== undefined &&
        claims !== undefined &&
        signature !== undefined &&
        createVerify('RSA-SHA256')
          .update(`${header}.${claims}`)
          .verify(known.publicKey, Buffer.from(signature, 'base64url'));
      const scope = valid
        ? (JSON.parse(Buffer.from(claims, 'base64url').toString()) as { scope?: string }).scope
        : '';
      if (state.refuseTokens) return send(503, { error: 'temporarily_unavailable' });
      if (!valid || scope !== 'https://www.googleapis.com/auth/firebase.messaging') {
        return send(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      }
      state.tokensIssued += 1;
      const token = `ya29.fake-${state.tokensIssued}`;
      issued.add(token);
      return send(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
    }

    const sendPath = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(req.url ?? '');
    if (req.method === 'POST' && sendPath) {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!issued.has(bearer)) return send(401, { error: { status: 'UNAUTHENTICATED' } });
      if (state.failSends > 0) {
        state.failSends -= 1;
        return send(503, { error: { code: 503, status: 'UNAVAILABLE' } });
      }
      const { message } = JSON.parse(raw) as {
        message: { token: string; data: Record<string, string>; android: unknown };
      };
      if (gone.has(message.token)) {
        return send(404, {
          error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
        });
      }
      messages.push({ projectId: decodeURIComponent(sendPath[1] ?? ''), ...message });
      return send(200, { name: `projects/${sendPath[1]}/messages/${messages.length}` });
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const account = (key: string, projectId: string) =>
    JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key_id: 'abc123',
      private_key: key,
      client_email: `push@${projectId}.iam.gserviceaccount.com`,
      token_uri: 'https://oauth2.googleapis.com/token',
    });

  return {
    fcmUrl: `http://127.0.0.1:${port}`,
    oauthUrl: `http://127.0.0.1:${port}/token`,
    serviceAccount: (projectId = 'superagent-test') => account(known.privateKey, projectId),
    strangerAccount: () => account(stranger.privateKey, 'superagent-test'),
    messages,
    get tokensIssued() {
      return state.tokensIssued;
    },
    gone,
    get failSends() {
      return state.failSends;
    },
    set failSends(count: number) {
      state.failSends = count;
    },
    get refuseTokens() {
      return state.refuseTokens;
    },
    set refuseTokens(refuse: boolean) {
      state.refuseTokens = refuse;
    },
    revokeAccess: () => issued.clear(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
