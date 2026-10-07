// Tables owned by superagent live in the `app` schema. Mastra keeps its own tables in `mastra`.
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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

/** Departments group a lead agent and its specialists. Archived, never deleted. */
export const departments = app.table('departments', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  autoClose: boolean('auto_close').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export type DepartmentRow = typeof departments.$inferSelect;

/**
 * Agent definitions are ours (decision D14) and compile into Mastra agents. `key` becomes the Mastra
 * agent id and the `agent-<key>` delegation tool name, so it never changes. One active lead per department.
 */
export const agentDefinitions = app.table(
  'agent_definitions',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    role: text('role', { enum: ['lead', 'specialist'] }).notNull(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    activeVersion: integer('active_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agent_definitions_one_active_lead')
      .on(table.departmentId)
      .where(sql`${table.role} = 'lead' and ${table.archivedAt} is null`),
  ],
);

export type AgentDefinitionRow = typeof agentDefinitions.$inferSelect;

/** Immutable versions of an agent's behaviour. Editing creates a new version; rollback activates an old one. */
export const agentVersions = app.table(
  'agent_versions',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    description: text('description').notNull(),
    instructions: text('instructions').notNull(),
    model: jsonb('model').$type<{ provider: string; model: string } | null>(),
    tools: jsonb('tools').$type<Array<{ key: string; requireApproval: boolean }>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.version] })],
);

export type AgentVersionRow = typeof agentVersions.$inferSelect;

/** The task ledger (decision D16): one row per task, a Mastra thread per task, a short number for humans. */
export const tasks = app.table(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    number: integer('number').generatedAlwaysAsIdentity().notNull().unique(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    title: text('title').notNull(),
    brief: text('brief').notNull(),
    phase: text('phase', {
      enum: ['inbox', 'queued', 'working', 'waiting', 'review', 'done', 'failed', 'cancelled'],
    }).notNull(),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] }).notNull(),
    source: text('source', { enum: ['owner', 'chief', 'schedule'] }).notNull(),
    leadAgentId: uuid('lead_agent_id').references(() => agentDefinitions.id),
    threadId: text('thread_id').notNull().unique(),
    resourceId: text('resource_id').notNull(),
    checklist: jsonb('checklist').$type<Array<{ text: string; done: boolean }>>().notNull().default([]),
    progress: integer('progress'),
    result: text('result'),
    revision: integer('revision').notNull().default(0),
    idempotencyKey: text('idempotency_key').unique(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [index('tasks_department_phase').on(table.departmentId, table.phase)],
);

export type TaskRow = typeof tasks.$inferSelect;

/** Append-only history. `seq` orders everything and is the SSE event id clients resume from. */
export const taskEvents = app.table(
  'task_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actor: text('actor').notNull(),
    phase: text('phase').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [index('task_events_task').on(table.taskId, table.seq)],
);

export type TaskEventRow = typeof taskEvents.$inferSelect;

export const artifacts = app.table('artifacts', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['text', 'link'] }).notNull(),
  title: text('title').notNull(),
  content: text('content'),
  url: text('url'),
  createdAt: createdAt(),
});

export type ArtifactRow = typeof artifacts.$inferSelect;
