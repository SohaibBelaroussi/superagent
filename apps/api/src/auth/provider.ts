import { MastraAuthProvider } from '@mastra/core/server';
import { type AuthUser, OWNER_ID, type TokenService } from './tokens';

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

  authorizeUser(user: AuthUser): boolean {
    return user?.id === OWNER_ID;
  }
}
