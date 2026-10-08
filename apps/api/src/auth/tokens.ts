import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IMastraLogger } from '@mastra/core/logger';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client';
import { type ApiTokenRow, apiTokens } from '../db/schema';

/** The single user of this server. Every valid token authenticates as the owner. */
export const OWNER_ID = 'owner';

/** tokenId reported for the bootstrap token from SUPERAGENT_ADMIN_TOKEN. Only it can manage tokens. */
export const ADMIN_TOKEN_ID = 'admin';

export interface AuthUser {
  id: typeof OWNER_ID;
  name: string;
  tokenId: string;
  tokenName: string;
}

const TOKEN_PREFIX = 'sa_';

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Enough of the token to recognize it in a list, never enough to use it. */
export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 6);
}

interface CacheEntry {
  user: AuthUser | null;
  verifiedAt: number;
  expiresAt: number;
}

/** During a database outage, tokens verified within this window keep working. */
const STALE_GRACE_MS = 10 * 60_000;

export interface TokenServiceOptions {
  logger?: IMastraLogger;
  /** How long a verified token is trusted before the database is checked again. */
  cacheTtlMs?: number;
  /** How long an unknown token is remembered as invalid. */
  negativeCacheTtlMs?: number;
}

export class TokenService {
  private readonly adminHash: Buffer;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastTouched = new Map<string, number>();
  private readonly revokedListeners = new Set<(tokenId: string) => void>();
  private readonly cacheTtlMs: number;
  private readonly negativeCacheTtlMs: number;
  /** Bumped on every revocation so in-flight lookups know their result may be stale. */
  private revocations = 0;

  constructor(
    private readonly db: Db,
    adminToken: string,
    private readonly options: TokenServiceOptions = {},
  ) {
    this.adminHash = Buffer.from(hashToken(adminToken), 'hex');
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.negativeCacheTtlMs = options.negativeCacheTtlMs ?? 5_000;
  }

  /** Resolves a presented token to the owner, or null. Revocations take effect immediately in this process. */
  async verify(token: string): Promise<AuthUser | null> {
    if (!token || token.length > 512) return null;
    const hash = hashToken(token);
    if (timingSafeEqual(Buffer.from(hash, 'hex'), this.adminHash)) {
      return { id: OWNER_ID, name: 'Owner', tokenId: ADMIN_TOKEN_ID, tokenName: 'admin (env)' };
    }

    const now = Date.now();
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > now) {
      if (cached.user) this.touch(cached.user.tokenId, now);
      return cached.user;
    }

    let user: AuthUser | null;
    try {
      const generation = this.revocations;
      user = await this.lookup(hash);
      // A revocation that committed while this lookup ran may be missing from its result: look again
      // instead of caching a token that was just revoked.
      if (generation !== this.revocations) user = await this.lookup(hash);
    } catch (error) {
      // Database unavailable: keep recently verified tokens working instead of failing every request.
      if (cached?.user && now - cached.verifiedAt < STALE_GRACE_MS) return cached.user;
      throw error;
    }

    if (this.cache.size > 1_000) this.cache.clear();
    this.cache.set(hash, {
      user,
      verifiedAt: now,
      expiresAt: now + (user ? this.cacheTtlMs : this.negativeCacheTtlMs),
    });
    if (user) this.touch(user.tokenId, now);
    return user;
  }

  private async lookup(hash: string): Promise<AuthUser | null> {
    const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hash)).limit(1);
    return row && !row.revokedAt
      ? { id: OWNER_ID, name: 'Owner', tokenId: row.id, tokenName: row.name }
      : null;
  }

  async create(name: string): Promise<{ token: string; record: ApiTokenRow }> {
    const token = generateToken();
    const [record] = await this.db
      .insert(apiTokens)
      .values({ id: uuidv7(), name, tokenHash: hashToken(token), prefix: tokenPrefix(token) })
      .returning();
    if (!record) throw new Error('Token insert returned no row');
    return { token, record };
  }

  async list(): Promise<ApiTokenRow[]> {
    return this.db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt));
  }

  /**
   * Calls `listener` with the id of each token this process revokes, so connections opened with it (the
   * event stream, live views) close instead of outliving the token. One API process (D23) revokes them all.
   */
  onRevoked(listener: (tokenId: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
  }

  /** Returns false when no token has this id. Revoking an already revoked token is a no-op that returns true. */
  async revoke(id: string): Promise<boolean> {
    const revoked = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (revoked.length > 0) {
      this.revocations++;
      this.cache.clear();
      for (const listener of [...this.revokedListeners]) {
        try {
          listener(id);
        } catch (error) {
          this.options.logger?.warn('Closing connections of a revoked token failed', { tokenId: id, error });
        }
      }
      return true;
    }
    const [existing] = await this.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .limit(1);
    return existing !== undefined;
  }

  /** Records last use at most once a minute per token, without blocking the request. */
  private touch(tokenId: string, now: number): void {
    if (now - (this.lastTouched.get(tokenId) ?? 0) < 60_000) return;
    this.lastTouched.set(tokenId, now);
    this.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(apiTokens.id, tokenId))
      .catch((error: unknown) => this.options.logger?.warn('Could not record token use', { tokenId, error }));
  }
}
