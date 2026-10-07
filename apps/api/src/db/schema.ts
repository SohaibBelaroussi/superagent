// Tables owned by superagent live in the `app` schema. Mastra keeps its own tables in `mastra`.
import { boolean, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const app = pgSchema('app');

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

export const apiTokens = app.table('api_tokens', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type ApiTokenRow = typeof apiTokens.$inferSelect;

/** OpenAI-compatible model providers. Secrets are sealed with SecretBox (AES-256-GCM). */
export const providers = app.table('providers', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: text('api_key_enc'),
  headersEnc: text('headers_enc'),
  strictJson: boolean('strict_json').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ProviderRow = typeof providers.$inferSelect;

export const providerModels = app.table(
  'provider_models',
  {
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    kind: text('kind', { enum: ['chat', 'embedding'] }).notNull(),
    source: text('source', { enum: ['discovered', 'manual'] }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.modelId] })],
);

export type ProviderModelRow = typeof providerModels.$inferSelect;

/** Small key/value store for server settings (model roles, timezone, concurrency). */
export const settings = app.table('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});
