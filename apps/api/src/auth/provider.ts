import { MastraAuthProvider } from '@mastra/core/server';
import { type AuthUser, OWNER_ID, type TokenService } from './tokens';

/** The one route a pairing code may call: claiming the device token it stands for (D53). */
export const PAIRING_CLAIM = { method: 'POST', path: '/v1/tokens/claim' } as const;

/** The request as Mastra hands it to the provider: Hono's raw `Request`, wrapped. */
interface AuthRequest {
  raw?: Request;
}

/**
 * Authenticates every request (Mastra's /api routes and our /v1 routes) against our API tokens.
 * Deliberately no `mapUserToResourceId`: it would pin all memory calls to a single resource,
 * while departments and tasks use their own resource ids.
 */
export class ApiTokenAuth extends MastraAuthProvider<AuthUser> {
  constructor(private readonly tokens: TokenService) {
    super({ name: 'superagent-api-token' });
  }

  async authenticateToken(token: string): Promise<AuthUser | null> {
    return this.tokens.verify(token);
  }

  authorizeUser(user: AuthUser, request?: unknown): boolean {
    if (user?.id !== OWNER_ID) return false;
    if (user.pairingId === undefined) return true;
    // A pairing code claims its device token, and does nothing else (403 elsewhere).
    const raw = (request as AuthRequest | undefined)?.raw;
    if (!(raw instanceof Request)) return false;
    return raw.method === PAIRING_CLAIM.method && new URL(raw.url).pathname === PAIRING_CLAIM.path;
  }
}
