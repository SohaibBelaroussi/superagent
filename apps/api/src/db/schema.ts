// Tables owned by superagent live in the `app` schema. Mastra keeps its own tables in `mastra`.
import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const app = pgSchema('app');

export const apiTokens = app.table('api_tokens', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type ApiTokenRow = typeof apiTokens.$inferSelect;
