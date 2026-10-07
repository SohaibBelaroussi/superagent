// Tables owned by superagent live in the `app` schema. Mastra keeps its own tables in `mastra`.
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
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

/** An MCP grant as stored on departments and agent versions. */
export type McpGrantRow = { server: string; tools?: string[]; requireApproval: boolean };

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

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
  /** Skills and MCP grants every agent of the department gets (decision D37). */
  skills: jsonb('skills').$type<string[]>().notNull().default([]),
  mcp: jsonb('mcp').$type<McpGrantRow[]>().notNull().default([]),
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
    tools: jsonb('tools')
      .$type<Array<{ key: string; requireApproval: boolean; identity?: string }>>()
      .notNull(),
    skills: jsonb('skills').$type<string[]>().notNull().default([]),
    mcp: jsonb('mcp').$type<McpGrantRow[]>().notNull().default([]),
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
    /** The schedule that created the task (no foreign key: deleting a schedule keeps its tasks). */
    scheduleId: uuid('schedule_id'),
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

// --- knowledge (M4) ---

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** An uploaded document. The original file lives in object storage; its text is split into chunks. */
export const knowledgeDocuments = app.table(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey(),
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    /** Null: shared with every department. */
    departmentId: uuid('department_id').references(() => departments.id),
    objectKey: text('object_key').notNull(),
    chunkCount: integer('chunk_count').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('knowledge_documents_department_idx').on(t.departmentId)],
);

export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;

/** Searchable pieces of a document. `search` is a full-text index; embeddings join later (decision D29). */
export const knowledgeChunks = app.table(
  'knowledge_chunks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    content: text('content').notNull(),
    search: tsvector('search').notNull().generatedAlwaysAs(sql`to_tsvector('simple', content)`),
  },
  (t) => [
    index('knowledge_chunks_search_idx').using('gin', t.search),
    uniqueIndex('knowledge_chunks_document_seq_idx').on(t.documentId, t.seq),
  ],
);

// --- memory (M4) ---

/** What the agents know about the owner: one row, kept by the chief and the owner (decision D30). */
export const ownerProfile = app.table('owner_profile', {
  id: text('id').primaryKey(),
  profile: jsonb('profile').$type<Record<string, unknown>>().notNull(),
  updatedAt: updatedAt(),
});

/** A department's notes: rules and lessons its lead keeps across tasks (decision D30). */
export const departmentNotes = app.table('department_notes', {
  departmentId: uuid('department_id')
    .primaryKey()
    .references(() => departments.id),
  notes: text('notes').notNull(),
  updatedAt: updatedAt(),
});

// --- schedules and decisions (M5) ---

/** Recurring tasks, fired by our own ticker (decision D31). */
export const schedules = app.table(
  'schedules',
  {
    id: uuid('id').primaryKey(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    title: text('title').notNull(),
    brief: text('brief').notNull(),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] }).notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status', { enum: ['active', 'paused'] }).notNull(),
    /** Null while paused. A fire claims the row by moving this forward (compare-and-set). */
    nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
    lastFireAt: timestamp('last_fire_at', { withTimezone: true }),
    lastTaskId: uuid('last_task_id'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('schedules_due_idx').on(t.status, t.nextFireAt)],
);

export type ScheduleRow = typeof schedules.$inferSelect;

/** The owner's decisions on attention items, once each: a retried request returns the first outcome. */
export const decisions = app.table(
  'decisions',
  {
    id: uuid('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    kind: text('kind', { enum: ['approve', 'decline'] }).notNull(),
    target: text('target').notNull(),
    reason: text('reason'),
    // pending while Mastra is told, then applied; a decision Mastra refused is deleted.
    status: text('status', { enum: ['pending', 'applied'] }).notNull(),
    taskId: uuid('task_id'),
    createdAt: createdAt(),
  },
  (t) => [index('decisions_target_idx').on(t.target)],
);

export type DecisionRow = typeof decisions.$inferSelect;

/**
 * Browser identities (decision D34): signed-in browser profiles. The profile itself is a runner volume;
 * this row names it and holds its lock, since one browser at a time may use a profile. The lock is a
 * lease its holder renews while its browser is open, so a crashed holder frees it within minutes.
 */
export const browserIdentities = app.table('browser_identities', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  /** task: a task's browser (locked_by_task); owner: the owner's sign-in session. */
  lockedBy: text('locked_by', { enum: ['task', 'owner'] }),
  lockedByTask: uuid('locked_by_task'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type BrowserIdentityRow = typeof browserIdentities.$inferSelect;

/** The secrets vault (decision D35): values sealed with SecretBox, bound to the secret's id. */
export const secrets = app.table('secrets', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  valueEnc: text('value_enc').notNull(),
  /** Created by a plugin's install inputs: removed with the plugin. */
  pluginId: uuid('plugin_id').references(() => plugins.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type SecretRow = typeof secrets.$inferSelect;

/** Installed plugins (decision D38): pinned packages of skills and MCP servers. */
export const plugins = app.table('plugins', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  title: text('title').notNull(),
  version: text('version'),
  description: text('description').notNull().default(''),
  format: text('format', { enum: ['agent-plugins', 'codex', 'claude', 'skills'] }).notNull(),
  source: jsonb('source').$type<Record<string, unknown>>().notNull(),
  sha: text('sha'),
  license: text('license'),
  status: text('status', { enum: ['installing', 'installed', 'failed'] }).notNull(),
  statusDetail: text('status_detail'),
  /** Its stdio MCP servers' network: through the egress proxy, or none. */
  network: text('network', { enum: ['egress', 'none'] }).notNull(),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PluginRow = typeof plugins.$inferSelect;

/** A plugin's pinned files (its manifests, skills and bundled servers), kept in the database. */
export const pluginFiles = app.table(
  'plugin_files',
  {
    pluginId: uuid('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    mode: integer('mode').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    content: bytea('content').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.path] })],
);

/** Skills (decision D37), each a folder of a plugin's files. */
export const skills = app.table(
  'skills',
  {
    id: uuid('id').primaryKey(),
    pluginId: uuid('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Its folder among the plugin's files. */
    dir: text('dir').notNull(),
    license: text('license'),
    compatibility: text('compatibility'),
    fileCount: integer('file_count').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('skills_plugin_name').on(t.pluginId, t.name)],
);

export type SkillRow = typeof skills.$inferSelect;

/** MCP servers (decision D36): added by hand (HTTP) or with a plugin (HTTP or stdio). */
export const mcpServers = app.table('mcp_servers', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  pluginId: uuid('plugin_id').references(() => plugins.id, { onDelete: 'cascade' }),
  /** Its name in the plugin's MCP configuration. */
  key: text('key'),
  transport: text('transport', { enum: ['http', 'stdio'] }).notNull(),
  url: text('url'),
  headers: jsonb('headers')
    .$type<Record<string, { value: string } | { secret: string }>>()
    .notNull()
    .default({}),
  allowPrivateNetwork: boolean('allow_private_network').notNull().default(false),
  /** stdio: bundled (the plugin's own files), npm or uv (a package installed at install time). */
  runtime: text('runtime', { enum: ['bundled', 'npm', 'uv'] }),
  package: text('package'),
  command: jsonb('command').$type<string[]>(),
  cwd: text('cwd'),
  env: jsonb('env').$type<Record<string, { value: string } | { secret: string }>>().notNull().default({}),
  timeoutMs: integer('timeout_ms').notNull().default(60_000),
  enabled: boolean('enabled').notNull().default(true),
  status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull(),
  statusDetail: text('status_detail'),
  /** Its tools as discovered (name, description, schemas, annotations), without the server's instructions. */
  tools: jsonb('tools').$type<McpToolDefinition[]>().notNull().default([]),
  toolsRefreshedAt: timestamp('tools_refreshed_at', { withTimezone: true }),
  /** Bumped by every change its client must see (URL, headers, secrets, tools). */
  revision: integer('revision').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type McpServerRow = typeof mcpServers.$inferSelect;

/** A tool as an MCP server describes it (the JSON @mastra/mcp's listToolDefinitions returns). */
export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
