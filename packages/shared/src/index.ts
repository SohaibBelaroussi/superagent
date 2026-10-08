// Request and response schemas for the superagent control-plane API (/v1).
// Shared with future clients so both sides validate against the same definitions.
import { z } from 'zod';

/** RFC 9457 problem details, returned for every /v1 error. */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string().optional(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const TokenRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string().describe('First characters of the token, for recognizing it later'),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type TokenRecord = z.infer<typeof TokenRecordSchema>;

export const TokenListSchema = z.object({ items: z.array(TokenRecordSchema) });
export type TokenList = z.infer<typeof TokenListSchema>;

export const CreateTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(100).describe('A label such as "phone" or "laptop"'),
});
export type CreateTokenInput = z.infer<typeof CreateTokenInputSchema>;

export const CreatedTokenSchema = z.object({
  token: z.string().describe('The secret token. Shown only once.'),
  record: TokenRecordSchema,
});
export type CreatedToken = z.infer<typeof CreatedTokenSchema>;

export const MeSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.object({ id: z.string(), name: z.string() }),
});
export type Me = z.infer<typeof MeSchema>;

// --- Model providers (M1) ---

/** Lowercase letters, digits and dashes. Used in model references: sa/<provider>/<model>. */
export const ProviderSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'lowercase letters, digits and dashes (max 40)')
  .refine((slug) => slug !== 'unconfigured', 'this slug is reserved');

const BaseUrlSchema = z
  .string()
  .trim()
  .refine((url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol), 'must be an http(s) URL')
  .transform((url) => url.replace(/\/+$/, ''))
  .describe('OpenAI-compatible base URL, usually ending in /v1');

// Keys and header values travel in HTTP headers: line breaks or other control characters make HTTP
// clients throw, quoting the full (secret) value in the error message.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const headerSafe = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const HEADER_SAFE = 'must not contain line breaks or other control characters';

const ApiKeySchema = z.string().trim().min(1).max(4096).refine(headerSafe, HEADER_SAFE);

const HeadersSchema = z
  .record(
    z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'not a valid header name'),
    z.string().max(4096).refine(headerSafe, HEADER_SAFE),
  )
  .describe('Extra headers sent with every request');

export const ProviderSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  hasApiKey: z.boolean().describe('Keys are stored encrypted and never returned'),
  secretsReadable: z
    .boolean()
    .describe(
      'false when the stored key or headers cannot be decrypted (encryption key changed): set them again',
    ),
  headerNames: z.array(z.string()),
  strictJson: z.boolean().describe('Send strict JSON schemas for structured output'),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderListSchema = z.object({ items: z.array(ProviderSchema) });

export const CreateProviderInputSchema = z.object({
  slug: ProviderSlugSchema,
  name: z.string().trim().min(1).max(100),
  baseUrl: BaseUrlSchema,
  apiKey: ApiKeySchema.optional(),
  headers: HeadersSchema.optional(),
  strictJson: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type CreateProviderInput = z.infer<typeof CreateProviderInputSchema>;

/** The slug cannot change: model references point at it. `apiKey: null` / `headers: null` clear them. */
export const UpdateProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  baseUrl: BaseUrlSchema.optional(),
  apiKey: ApiKeySchema.nullable().optional(),
  headers: HeadersSchema.nullable().optional(),
  strictJson: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateProviderInput = z.infer<typeof UpdateProviderInputSchema>;

export const ModelKindSchema = z.enum(['chat', 'embedding']);
export type ModelKind = z.infer<typeof ModelKindSchema>;

/** What a model costs, in USD per million tokens. */
export const ModelPriceSchema = z.object({
  inputUsd: z.number().min(0).max(100_000).describe('USD per million input tokens'),
  cachedInputUsd: z
    .number()
    .min(0)
    .max(100_000)
    .nullable()
    .describe('USD per million input tokens read from the cache (the input price when null)'),
  outputUsd: z.number().min(0).max(100_000).describe('USD per million output tokens'),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const ProviderModelSchema = z.object({
  modelId: z.string(),
  kind: ModelKindSchema,
  source: z.enum(['discovered', 'manual']),
  enabled: z.boolean(),
  discoveredAt: z.string().nullable(),
  ref: z.string().describe('Model reference for agents and settings: sa/<provider>/<model>'),
  price: ModelPriceSchema.nullable().describe(
    'Set with PUT /v1/providers/{id}/prices; calls cost nothing without',
  ),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderModelListSchema = z.object({ items: z.array(ProviderModelSchema) });

export const SetModelPriceInputSchema = ModelPriceSchema.extend({
  modelId: z.string().trim().min(1).max(200),
  cachedInputUsd: ModelPriceSchema.shape.cachedInputUsd.optional(),
});
export type SetModelPriceInput = z.input<typeof SetModelPriceInputSchema>;

// --- Usage and cost (M9) ---

/** Token and cost totals of a set of model calls. */
export const UsageTotalsSchema = z.object({
  calls: z.number().int().describe('Model calls'),
  inputTokens: z.number().int(),
  cachedInputTokens: z.number().int().describe('Part of the input tokens'),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int().describe('Part of the output tokens'),
  totalTokens: z.number().int().describe('Input plus output'),
  costUsd: z.number().describe('USD, at the prices of the day of each call'),
  unpricedCalls: z.number().int().describe('Calls to models that had no price: not in costUsd'),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageGroupSchema = z.enum(['department', 'task', 'agent', 'model', 'day']);
export type UsageGroup = z.infer<typeof UsageGroupSchema>;

export const UsageQuerySchema = z.object({
  group: UsageGroupSchema.default('department'),
  from: z.iso.datetime({ offset: true }).optional().describe('Calls at or after this time'),
  to: z.iso.datetime({ offset: true }).optional().describe('Calls before this time'),
  departmentId: z.uuid().optional().describe("Only this department's tasks"),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const UsageReportSchema = z.object({
  group: UsageGroupSchema,
  from: z.string().nullable(),
  to: z.string().nullable(),
  items: z.array(
    UsageTotalsSchema.extend({
      key: z
        .string()
        .nullable()
        .describe(
          "A department or task id, an agent, provider/model, or a day (owner's timezone); null: none",
        ),
      label: z.string(),
    }),
  ),
  total: UsageTotalsSchema,
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

export const AddModelInputSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  kind: ModelKindSchema.default('chat'),
});
export type AddModelInput = z.infer<typeof AddModelInputSchema>;

export const ProviderTestInputSchema = z.object({
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Chat model to test; defaults to the first chat model'),
  embeddingModel: z.string().min(1).max(200).optional().describe('Also test this embedding model'),
});
export type ProviderTestInput = z.infer<typeof ProviderTestInputSchema>;

export const ProviderCheckSchema = z.object({
  name: z.enum(['chat', 'stream', 'tools', 'embedding']),
  ok: z.boolean(),
  ms: z.number(),
  detail: z.string().optional(),
  error: z.string().optional(),
});
export type ProviderCheck = z.infer<typeof ProviderCheckSchema>;

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  model: z.string().nullable(),
  embeddingModel: z.string().nullable(),
  checks: z.array(ProviderCheckSchema),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

// --- Settings (M1) ---

export const ModelRefSchema = z.object({
  provider: ProviderSlugSchema,
  model: z.string().min(1).max(200),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const ModelRolesSchema = z.object({
  default: ModelRefSchema.nullable().describe('Agents use this unless their definition picks a model'),
  fast: ModelRefSchema.nullable().describe('Titles, memory compression, judges'),
  embedding: ModelRefSchema.nullable().describe('Semantic recall and knowledge search'),
});
export type ModelRoles = z.infer<typeof ModelRolesSchema>;
export type ModelRole = keyof ModelRoles;

export const ConcurrencySchema = z.object({
  global: z.number().int().min(1).max(100),
  perAgent: z.number().int().min(1).max(50),
});

export const SettingsSchema = z.object({
  models: ModelRolesSchema,
  timezone: z.string().describe('IANA timezone for schedules'),
  concurrency: ConcurrencySchema.describe('Background task limits (applied at startup)'),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsInputSchema = z.object({
  models: ModelRolesSchema.partial().optional(),
  timezone: z.string().optional(),
  concurrency: ConcurrencySchema.partial().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

// --- Departments and agents (M2) ---

/** Agent keys become Mastra agent ids and the `agent-<key>` tool name leads use to delegate. */
export const AgentKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, 'lowercase letters, digits and dashes (max 48)');

export const DepartmentSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'lowercase letters, digits and dashes (max 40)');

export const AgentRoleSchema = z.enum(['lead', 'specialist']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** A browser identity's name: how agent definitions refer to it. */
export const BrowserIdentityNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'lowercase letters, digits and dashes (max 40)');

/** A plugin's name (Agent Plugins names may contain dots); grants and skill references use it. */
export const PluginNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/, 'lowercase letters, digits, dots and dashes (max 64)');

/** A skill to attach: a plugin's name (all its skills) or "<plugin>/<skill>". */
export const SkillRefSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$/,
    'a plugin name, or "<plugin>/<skill>"',
  );

/** An MCP server's slug: the prefix of its tools' names. */
export const McpServerSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'lowercase letters, digits and dashes (max 32)');

export const McpGrantSchema = z.object({
  server: McpServerSlugSchema.describe('An MCP server (GET /v1/mcp-servers)'),
  tools: z
    .array(z.string().min(1).max(128))
    .max(200)
    .optional()
    .describe("Only these of the server's tools, by their MCP names (default: all)"),
  requireApproval: z
    .boolean()
    .default(false)
    .describe('Pause before each call until the owner approves it (GET /v1/attention)'),
});
export type McpGrant = z.infer<typeof McpGrantSchema>;

export const ToolGrantSchema = z.object({
  key: z.string().min(1).describe('Tool key from GET /v1/catalog/tools'),
  requireApproval: z
    .boolean()
    .default(false)
    .describe('Pause before each call until the owner approves it (GET /v1/attention)'),
  identity: BrowserIdentityNameSchema.optional().describe(
    'Browser grant only: the identity (a signed-in browser profile, GET /v1/browser-identities) its browser uses',
  ),
});
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export const AgentVersionSchema = z.object({
  version: z.number().int(),
  description: z.string(),
  instructions: z.string(),
  model: ModelRefSchema.nullable().describe('null: use the default model role'),
  tools: z.array(ToolGrantSchema),
  skills: z.array(SkillRefSchema).describe("Skills it can use, besides its department's"),
  mcp: z.array(McpGrantSchema).describe("MCP servers' tools it can use, besides its department's"),
  createdAt: z.string(),
});
export type AgentVersion = z.infer<typeof AgentVersionSchema>;

export const AgentSummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  role: AgentRoleSchema,
  description: z.string(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  role: AgentRoleSchema,
  departmentId: z.string(),
  activeVersion: z.number().int(),
  current: AgentVersionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentListSchema = z.object({ items: z.array(AgentDefinitionSchema) });
export const AgentVersionListSchema = z.object({ items: z.array(AgentVersionSchema) });

const InstructionsSchema = z.string().trim().min(1).max(20_000);
const DescriptionSchema = z.string().trim().min(1).max(500);

export const CreateAgentInputSchema = z.object({
  key: AgentKeySchema,
  name: z.string().trim().min(1).max(100),
  role: AgentRoleSchema,
  departmentId: z.string().min(1),
  description: DescriptionSchema.describe(
    'What this agent is good at; the lead uses it to choose a specialist',
  ),
  instructions: InstructionsSchema,
  model: ModelRefSchema.nullable().default(null),
  tools: z.array(ToolGrantSchema).max(50).default([]),
  skills: z.array(SkillRefSchema).max(50).default([]),
  mcp: z.array(McpGrantSchema).max(20).default([]),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

/** Changing description, instructions, model, tools, skills or MCP grants creates and activates a new version. */
export const UpdateAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: DescriptionSchema.optional(),
  instructions: InstructionsSchema.optional(),
  model: ModelRefSchema.nullable().optional(),
  tools: z.array(ToolGrantSchema).max(50).optional(),
  skills: z.array(SkillRefSchema).max(50).optional(),
  mcp: z.array(McpGrantSchema).max(20).optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

export const DepartmentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  autoClose: z.boolean().describe('Close finished tasks without owner review (used from M3)'),
  lead: AgentSummarySchema.nullable(),
  members: z.array(AgentSummarySchema).describe('Active specialists'),
  skills: z.array(SkillRefSchema).describe('Skills every agent of the department can use'),
  mcp: z.array(McpGrantSchema).describe("MCP servers' tools every agent of the department can use"),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type Department = z.infer<typeof DepartmentSchema>;

export const DepartmentListSchema = z.object({ items: z.array(DepartmentSchema) });

export const CreateDepartmentInputSchema = z.object({
  slug: DepartmentSlugSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  autoClose: z.boolean().default(false),
  skills: z.array(SkillRefSchema).max(50).default([]),
  mcp: z.array(McpGrantSchema).max(20).default([]),
});
export type CreateDepartmentInput = z.infer<typeof CreateDepartmentInputSchema>;

export const UpdateDepartmentInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  autoClose: z.boolean().optional(),
  skills: z.array(SkillRefSchema).max(50).optional(),
  mcp: z.array(McpGrantSchema).max(20).optional(),
});
export type UpdateDepartmentInput = z.infer<typeof UpdateDepartmentInputSchema>;

// --- Tool catalog (M2) ---

export const CatalogToolSchema = z.object({
  key: z.string(),
  pack: z.string(),
  description: z.string(),
});
export type CatalogTool = z.infer<typeof CatalogToolSchema>;

export const CatalogToolListSchema = z.object({ items: z.array(CatalogToolSchema) });

// --- Tasks, board and events (M3) ---

/**
 * inbox: not dispatched yet · queued: sent to the lead · working: the lead is on it ·
 * waiting: needs the owner · review: done, awaiting the owner · done · failed · cancelled.
 */
export const TaskPhaseSchema = z.enum([
  'inbox',
  'queued',
  'working',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const ChecklistItemSchema = z.object({
  text: z.string().trim().min(1).max(300),
  done: z.boolean().default(false),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  number: z.number().int().describe('Short number for humans: #42'),
  departmentId: z.string(),
  title: z.string(),
  brief: z.string(),
  phase: TaskPhaseSchema,
  priority: TaskPrioritySchema,
  source: z.enum(['owner', 'chief', 'schedule']),
  scheduleId: z.string().nullable().describe('The schedule that created it, if any'),
  leadAgentId: z.string().nullable(),
  threadId: z.string().describe('Mastra thread where the lead works on this task'),
  checklist: z.array(ChecklistItemSchema),
  progress: z.number().int().nullable(),
  result: z.string().nullable().describe("The lead's final report"),
  revision: z.number().int(),
  dueAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  usage: UsageTotalsSchema.describe("Every model call made for it: the lead's, its specialists', memory's"),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskListSchema = z.object({
  items: z.array(TaskSchema),
  nextCursor: z.string().nullable(),
});

export const CreateTaskInputSchema = z.object({
  departmentId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(20_000),
  priority: TaskPrioritySchema.default('normal'),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  dispatch: z.boolean().default(true).describe('Send it to the department lead right away'),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

/** Owner edits. Phase moves allowed for the owner: done, cancelled, or queued (send it to the lead again). */
export const UpdateTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  priority: TaskPrioritySchema.optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  phase: z.enum(['done', 'cancelled', 'queued']).optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const TaskMessageInputSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  mode: z
    .enum(['steer', 'queue'])
    .default('steer')
    .describe('steer: deliver now (wakes the lead if idle) · queue: after the current turn'),
});
export type TaskMessageInput = z.infer<typeof TaskMessageInputSchema>;

export const TaskEventSchema = z.object({
  seq: z.number().int().describe('Global, increasing; use as Last-Event-ID'),
  taskId: z.string(),
  taskNumber: z.number().int(),
  departmentId: z.string(),
  type: z.string(),
  actor: z.string(),
  phase: TaskPhaseSchema.describe('Task phase after this event'),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const TaskEventListSchema = z.object({ items: z.array(TaskEventSchema) });

export const ArtifactSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(['text', 'link']),
  title: z.string(),
  content: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactListSchema = z.object({ items: z.array(ArtifactSchema) });

export const BoardSchema = z.object({
  columns: z.array(z.object({ phase: TaskPhaseSchema, tasks: z.array(TaskSchema) })),
});
export type Board = z.infer<typeof BoardSchema>;

// --- M4: knowledge ---

export const KnowledgeDocumentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().describe('Bytes'),
  departmentId: z.uuid().nullable().describe('Null: shared with every department'),
  chunkCount: z.number().int().describe('Passages indexed for search'),
  createdAt: z.iso.datetime(),
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

export const KnowledgeDocumentListSchema = z.object({ items: z.array(KnowledgeDocumentSchema) });
export type KnowledgeDocumentList = z.infer<typeof KnowledgeDocumentListSchema>;

export const KnowledgeHitSchema = z.object({
  documentId: z.uuid(),
  title: z.string(),
  departmentId: z.uuid().nullable(),
  passage: z.number().int().describe('Position of the passage in the document'),
  content: z.string(),
  score: z.number(),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;

export const KnowledgeSearchResultSchema = z.object({ items: z.array(KnowledgeHitSchema) });
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;

// --- M4: memory ---

/**
 * What the agents know about the owner. The chief of staff keeps it (working memory of the `owner`
 * resource) and every department agent gets a read-only copy. Every field is optional: the chief
 * updates it piece by piece.
 */
export const OwnerProfileSchema = z.object({
  name: z.string().max(200).optional(),
  language: z.string().max(100).optional().describe('Language to answer in'),
  timezone: z.string().max(100).optional(),
  communicationStyle: z.string().max(1000).optional().describe('How the owner likes answers'),
  preferences: z.array(z.string().max(500)).max(50).optional(),
  about: z.string().max(4000).optional().describe('Work, projects and anything else worth knowing'),
});
export type OwnerProfile = z.infer<typeof OwnerProfileSchema>;

/** A partial update: fields given are replaced (lists included), null removes a field. */
export const OwnerProfilePatchSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  language: z.string().max(100).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  communicationStyle: z.string().max(1000).nullable().optional(),
  preferences: z.array(z.string().max(500)).max(50).nullable().optional(),
  about: z.string().max(4000).nullable().optional(),
});
export type OwnerProfilePatch = z.infer<typeof OwnerProfilePatchSchema>;

export const DepartmentMemorySchema = z.object({
  departmentId: z.uuid(),
  notes: z
    .string()
    .nullable()
    .describe("The department's working notes (markdown), kept by its lead across tasks; null before any"),
});
export type DepartmentMemory = z.infer<typeof DepartmentMemorySchema>;

export const UpdateDepartmentMemoryInputSchema = z.object({
  notes: z.string().max(20_000).describe('Replaces the notes (markdown)'),
});
export type UpdateDepartmentMemoryInput = z.infer<typeof UpdateDepartmentMemoryInputSchema>;

// --- M5: schedules ---

export const ScheduleStatusSchema = z.enum(['active', 'paused']);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

/** A recurring task: each time the cron fires, a task with this brief goes to the department's lead. */
export const ScheduleSchema = z.object({
  id: z.uuid(),
  departmentId: z.uuid(),
  department: z.object({ slug: z.string(), name: z.string() }).nullable(),
  title: z.string(),
  brief: z.string(),
  priority: TaskPrioritySchema,
  cron: z.string().describe('5 fields (minute hour day month weekday), or 6 with seconds first'),
  timezone: z.string(),
  status: ScheduleStatusSchema,
  nextFireAt: z.iso.datetime().nullable().describe('Null while paused'),
  lastFireAt: z.iso.datetime().nullable(),
  lastTaskId: z.uuid().nullable(),
  createdBy: z.string().describe('owner, or agent:<key>'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleListSchema = z.object({ items: z.array(ScheduleSchema) });
export type ScheduleList = z.infer<typeof ScheduleListSchema>;

export const CreateScheduleInputSchema = z.object({
  departmentId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(20_000),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().optional().describe("Defaults to the owner's timezone (settings)"),
  priority: TaskPrioritySchema.default('normal'),
});
export type CreateScheduleInput = z.infer<typeof CreateScheduleInputSchema>;

export const UpdateScheduleInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  brief: z.string().trim().min(1).max(20_000).optional(),
  cron: z.string().trim().min(9).max(100).optional(),
  timezone: z.string().optional(),
  priority: TaskPrioritySchema.optional(),
  status: ScheduleStatusSchema.optional(),
});
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInputSchema>;

// --- M5: attention ---

/**
 * Something that needs the owner: a tool call waiting for approval, a lead's question, a task that
 * stalled, a result to review, or a problem with the setup.
 */
export const AttentionItemSchema = z.object({
  id: z.string().describe('approval:<runId>:<toolCallId>, task:<id> or health:<check>'),
  kind: z.enum(['approval', 'question', 'problem', 'review', 'health']),
  title: z.string(),
  detail: z.string().nullable(),
  taskId: z.string().nullable(),
  taskNumber: z.number().int().nullable(),
  departmentId: z.string().nullable(),
  agent: z.string().nullable().describe('For approvals: the agent whose run is waiting'),
  tool: z.string().nullable(),
  args: z.unknown().optional(),
  since: z.iso.datetime(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const AttentionListSchema = z.object({ items: z.array(AttentionItemSchema) });
export type AttentionList = z.infer<typeof AttentionListSchema>;

export const DecisionInputSchema = z.object({
  reason: z.string().max(1000).optional().describe('For a decline: what the agent is told'),
});
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

export const DecisionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['approve', 'decline']),
  target: z.string().describe('The attention item decided'),
  reason: z.string().nullable(),
  status: z
    .enum(['pending', 'applied'])
    .describe('pending: the server stopped while applying it, so the call may or may not have resumed'),
  taskId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// --- Workspaces and sandboxes (M6) ---

export const WorkspaceEntrySchema = z.object({
  path: z.string().describe("Relative to the task's workspace folder"),
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().nullable(),
  modifiedAt: z.iso.datetime(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const WorkspaceListingSchema = z.object({
  items: z.array(WorkspaceEntrySchema),
  /** More entries exist than were listed. */
  truncated: z.boolean(),
});
export type WorkspaceListing = z.infer<typeof WorkspaceListingSchema>;

export const SandboxSchema = z.object({
  id: z.uuid().describe("The task's id: one sandbox per task"),
  taskId: z.uuid(),
  taskNumber: z.number().int().nullable(),
  taskTitle: z.string().nullable(),
  profile: z.string(),
  state: z.enum(['running', 'stopped']),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable().describe('Last command or file operation the runner saw'),
});
export type Sandbox = z.infer<typeof SandboxSchema>;

export const SandboxListSchema = z.object({ items: z.array(SandboxSchema) });
export type SandboxList = z.infer<typeof SandboxListSchema>;

// --- Browsers (M7) ---

export const BrowserIdentitySchema = z.object({
  id: z.uuid(),
  name: BrowserIdentityNameSchema,
  description: z.string(),
  holder: z
    .object({
      kind: z
        .enum(['task', 'owner'])
        .describe(
          "task: a task's browser; owner: a sign-in session (POST /v1/browser-identities/{id}/session)",
        ),
      taskId: z.uuid().nullable(),
      taskNumber: z.number().int().nullable(),
      until: z.iso.datetime().describe('The lock lapses then unless its browser is still in use'),
    })
    .nullable()
    .describe('Who uses the identity now: one browser at a time, others wait'),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BrowserIdentity = z.infer<typeof BrowserIdentitySchema>;

export const BrowserIdentityListSchema = z.object({ items: z.array(BrowserIdentitySchema) });
export type BrowserIdentityList = z.infer<typeof BrowserIdentityListSchema>;

export const CreateBrowserIdentityInputSchema = z.object({
  name: BrowserIdentityNameSchema,
  description: z.string().trim().max(500).default(''),
});
export type CreateBrowserIdentityInput = z.input<typeof CreateBrowserIdentityInputSchema>;

/** A browser the API has open: a task's, an identity's sign-in session, or the page reader's. */
export const BrowserSessionSchema = z.object({
  kind: z
    .enum(['task', 'sign-in', 'reader'])
    .describe("reader: the shared browser fetch_page falls back to for pages the page service can't read"),
  taskId: z.uuid().nullable().describe('The task it belongs to (task browsers only)'),
  taskNumber: z.number().int().nullable(),
  identity: BrowserIdentityNameSchema.nullable().describe('The identity it is signed in as, if any'),
  url: z.string().nullable(),
  title: z.string().nullable(),
  takenOver: z.boolean().describe("The owner has taken over in the live view: agents' browser tools wait"),
  viewers: z.number().int().describe('Live views open on it'),
  openedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
});
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

export const BrowserSessionListSchema = z.object({ items: z.array(BrowserSessionSchema) });
export type BrowserSessionList = z.infer<typeof BrowserSessionListSchema>;

/**
 * What a live view sends (WebSocket text, JSON). Mouse and keyboard events go to the page only while
 * the owner has taken over (always, in a sign-in session). Coordinates are in the frames' pixels.
 */
export const BrowserViewerInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouse'),
    eventType: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['none', 'left', 'middle', 'right']).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  z.object({
    type: z.literal('keyboard'),
    eventType: z.enum(['keyDown', 'keyUp', 'char']),
    key: z.string().max(32).optional(),
    code: z.string().max(32).optional(),
    text: z.string().max(16).optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  z.object({ type: z.literal('takeover'), on: z.boolean() }),
  z.object({ type: z.literal('navigate'), url: z.string().min(1).max(4096) }),
]);
export type BrowserViewerInput = z.infer<typeof BrowserViewerInputSchema>;

/**
 * What a live view receives: JPEG frames as bare base64 strings, and these JSON events. Mastra's
 * live-view clients understand the frames, `status`, `url` and `viewport`.
 */
export const BrowserViewerEventSchema = z.union([
  z.object({
    status: z.enum(['connected', 'streaming', 'browser_closed', 'taken_over', 'released']),
  }),
  z.object({ url: z.string() }),
  z.object({ viewport: z.object({ width: z.number(), height: z.number() }) }),
  z.object({ error: z.string(), message: z.string() }),
]);
export type BrowserViewerEvent = z.infer<typeof BrowserViewerEventSchema>;

// --- Capabilities: secrets, MCP servers, skills, plugins (M8) ---

export const SecretNameSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{0,63}$/,
    'upper-case letters, digits and underscores, starting with a letter (max 64)',
  );

export const SecretSchema = z.object({
  name: SecretNameSchema,
  description: z.string(),
  plugin: PluginNameSchema.nullable().describe(
    'The plugin that created it (it goes when the plugin is uninstalled)',
  ),
  usedBy: z.array(McpServerSlugSchema).describe('MCP servers whose headers or environment use it'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Secret = z.infer<typeof SecretSchema>;

export const SecretListSchema = z.object({ items: z.array(SecretSchema) });
export type SecretList = z.infer<typeof SecretListSchema>;

export const PutSecretInputSchema = z.object({
  value: z.string().min(1).max(16_384).describe('Stored encrypted; never returned'),
  description: z.string().trim().max(500).optional(),
});
export type PutSecretInput = z.infer<typeof PutSecretInputSchema>;

/** A header or environment value: given as is, or taken from the secrets vault. */
export const ConfigValueSchema = z.union([
  z.object({ value: z.string().max(4096) }),
  z.object({ secret: SecretNameSchema }),
]);
export type ConfigValue = z.infer<typeof ConfigValueSchema>;

const HeaderNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'a header name');
const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'an environment variable name');

export const McpToolSchema = z.object({
  name: z.string().describe("The tool's name on its server (grants list these)"),
  key: z.string().describe('The name agents see: <server slug>_<tool>'),
  description: z.string(),
  annotations: z.record(z.string(), z.unknown()).optional().describe("The server's hints: not trusted"),
});
export type McpTool = z.infer<typeof McpToolSchema>;

export const McpServerSchema = z.object({
  id: z.uuid(),
  slug: McpServerSlugSchema,
  name: z.string(),
  description: z.string(),
  plugin: PluginNameSchema.nullable().describe('The plugin it came with; null when added by hand'),
  transport: z.enum(['http', 'stdio']),
  url: z.string().nullable().describe('HTTP servers: its Streamable HTTP endpoint'),
  headers: z.record(HeaderNameSchema, ConfigValueSchema).describe('Secret values show only their names'),
  allowPrivateNetwork: z
    .boolean()
    .describe('HTTP servers: may be on a private address (the LAN, the tailnet)'),
  command: z.array(z.string()).nullable().describe('stdio servers: what runs in the container'),
  package: z.string().nullable().describe('stdio servers from npm or PyPI: the pinned package'),
  env: z.record(EnvNameSchema, ConfigValueSchema),
  enabled: z.boolean(),
  status: z.enum(['pending', 'ready', 'failed']).describe('ready: its tools are known'),
  statusDetail: z.string().nullable(),
  tools: z.array(McpToolSchema),
  toolsRefreshedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpServerListSchema = z.object({ items: z.array(McpServerSchema) });
export type McpServerList = z.infer<typeof McpServerListSchema>;

export const CreateMcpServerInputSchema = z.object({
  slug: McpServerSlugSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  url: z.url().describe('Its Streamable HTTP endpoint (https, unless on a private network)'),
  headers: z.record(HeaderNameSchema, ConfigValueSchema).default({}),
  allowPrivateNetwork: z
    .boolean()
    .default(false)
    .describe(
      'Allow a private address (a server on the LAN or the tailnet). Public addresses only otherwise',
    ),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
});
export type CreateMcpServerInput = z.input<typeof CreateMcpServerInputSchema>;

export const UpdateMcpServerInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  url: z.url().optional(),
  headers: z.record(HeaderNameSchema, ConfigValueSchema).optional(),
  env: z.record(EnvNameSchema, ConfigValueSchema).optional().describe('stdio servers only'),
  allowPrivateNetwork: z.boolean().optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});
export type UpdateMcpServerInput = z.infer<typeof UpdateMcpServerInputSchema>;

export const SkillSchema = z.object({
  id: z.uuid(),
  ref: SkillRefSchema.describe('How grants refer to it: "<plugin>/<skill>"'),
  plugin: PluginNameSchema,
  name: z.string(),
  description: z.string(),
  license: z.string().nullable(),
  compatibility: z.string().nullable().describe('What it says it needs (tools, network)'),
  files: z.array(z.string()).describe('Its files, relative to its folder'),
  bytes: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const SkillListSchema = z.object({ items: z.array(SkillSchema.omit({ files: true })) });
export type SkillList = z.infer<typeof SkillListSchema>;

/**
 * Where a plugin comes from. GitHub: a repository (optionally a folder in it) at a ref, pinned to its
 * commit when previewed; a marketplace repository needs the entry's name. URL: a .tar.gz with its sha256.
 */
export const PluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 'owner/repo'),
    path: z
      .string()
      .regex(/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/, 'a folder in the repository')
      .optional(),
    ref: z.string().min(1).max(200).default('HEAD').describe('A branch, tag or commit'),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.url().describe('A .tar.gz of the plugin (its root, or one folder holding it)'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "the archive's sha256 (hex)"),
    allowPrivateNetwork: z.boolean().default(false),
  }),
]);
export type PluginSource = z.input<typeof PluginSourceSchema>;

export const PluginFormatSchema = z.enum(['agent-plugins', 'codex', 'claude', 'skills']);

export const PluginInputSchema = z.object({
  name: z.string().describe('What to send in install inputs'),
  description: z.string(),
  sensitive: z
    .boolean()
    .describe(
      "A credential. Values that go into a server's environment or headers are kept in the secrets vault either way",
    ),
  required: z.boolean(),
  default: z.string().nullable().describe('Used when no value is given'),
});
export type PluginInput = z.infer<typeof PluginInputSchema>;

export const PluginPreviewSchema = z.object({
  id: z.uuid().describe('Install it with POST /v1/plugins { previewId }'),
  expiresAt: z.iso.datetime(),
  source: PluginSourceSchema,
  sha: z.string().nullable().describe('The commit it is pinned to (GitHub sources)'),
  format: PluginFormatSchema,
  name: PluginNameSchema,
  title: z.string(),
  version: z.string().nullable(),
  description: z.string(),
  license: z.string().nullable(),
  homepage: z.string().nullable(),
  installed: z.boolean().describe('A plugin with this name is installed (uninstall it first)'),
  skills: z.array(
    z.object({ name: z.string(), description: z.string(), files: z.number().int(), bytes: z.number().int() }),
  ),
  mcpServers: z.array(
    z.object({
      key: z.string().describe('Its name in the plugin'),
      slug: McpServerSlugSchema,
      transport: z.enum(['http', 'stdio']),
      command: z.array(z.string()).nullable(),
      package: z.string().nullable(),
      url: z.string().nullable(),
      env: z.array(z.string()).describe('Environment variables it is given'),
    }),
  ),
  inputs: z.array(PluginInputSchema).describe('Values to provide at install'),
  skipped: z.array(z.object({ component: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
  files: z.number().int(),
  bytes: z.number().int(),
});
export type PluginPreview = z.infer<typeof PluginPreviewSchema>;

export const PreviewPluginInputSchema = z.object({ source: PluginSourceSchema });
export type PreviewPluginInput = z.input<typeof PreviewPluginInputSchema>;

export const InstallPluginInputSchema = z.object({
  previewId: z.uuid(),
  network: z
    .enum(['egress', 'none'])
    .default('egress')
    .describe("Its stdio MCP servers' network: public addresses through the egress proxy, or none"),
  inputs: z.record(z.string(), z.string().max(16_384)).default({}),
  servers: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        env: z.record(EnvNameSchema, ConfigValueSchema).optional(),
        headers: z.record(HeaderNameSchema, ConfigValueSchema).optional(),
      }),
    )
    .default({})
    .describe('Per MCP server (by its key in the plugin): turn it off, or add environment values or headers'),
});
export type InstallPluginInput = z.input<typeof InstallPluginInputSchema>;

export const PluginSchema = z.object({
  id: z.uuid(),
  name: PluginNameSchema,
  title: z.string(),
  version: z.string().nullable(),
  description: z.string(),
  format: PluginFormatSchema,
  source: PluginSourceSchema,
  sha: z.string().nullable(),
  license: z.string().nullable(),
  status: z
    .enum(['installing', 'installed', 'failed'])
    .describe('failed: its MCP servers could not be set up (its skills still work)'),
  statusDetail: z.string().nullable(),
  network: z.enum(['egress', 'none']),
  skills: z.array(SkillRefSchema),
  mcpServers: z.array(McpServerSlugSchema),
  warnings: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Plugin = z.infer<typeof PluginSchema>;

export const PluginListSchema = z.object({ items: z.array(PluginSchema) });
export type PluginList = z.infer<typeof PluginListSchema>;

/** Everything an agent or a department can be given, and how to grant it. */
export const CapabilitiesSchema = z.object({
  tools: z.array(CatalogToolSchema).describe('Agents\' "tools": [{ key }]'),
  skills: z
    .array(
      z.object({ ref: SkillRefSchema, plugin: PluginNameSchema, name: z.string(), description: z.string() }),
    )
    .describe("Agents' and departments' \"skills\": [ref], or a plugin's name for all its skills"),
  mcpServers: z
    .array(
      z.object({
        slug: McpServerSlugSchema,
        name: z.string(),
        transport: z.enum(['http', 'stdio']),
        status: z.enum(['pending', 'ready', 'failed']),
        enabled: z.boolean(),
        tools: z.array(McpToolSchema),
      }),
    )
    .describe('Agents\' and departments\' "mcp": [{ server, tools?, requireApproval? }]'),
  plugins: z.array(
    z.object({
      name: PluginNameSchema,
      title: z.string(),
      version: z.string().nullable(),
      status: z.string(),
    }),
  ),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

// --- Conversations (W2) ---

/**
 * Where a tool call stands. `pending`: called, with no result yet (it may still be running, or its run
 * ended without one); `approval`: waiting for the owner; `declined`: the owner said no.
 */
export const ToolCallStatusSchema = z.enum(['pending', 'approval', 'done', 'failed', 'declined']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallPartSchema = z.object({
  type: z.literal('tool'),
  callId: z.string(),
  tool: z.string(),
  delegate: z
    .string()
    .nullable()
    .describe('The specialist a lead delegated to (tool agent-<key>), else null'),
  args: z.unknown().describe('The arguments; a string preview when they are very large'),
  status: ToolCallStatusSchema,
  result: z
    .unknown()
    .optional()
    .describe("The result (a delegation's: the specialist's answer); a string preview when very large"),
  error: z.string().nullable(),
});
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  ToolCallPartSchema,
  z.object({ type: z.literal('source'), url: z.string(), title: z.string().nullable() }),
  z.object({ type: z.literal('file'), name: z.string().nullable(), mediaType: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const ConversationReportSchema = z.object({
  kind: z
    .string()
    .describe('task-done, task-blocked, task-failed, approval-needed, task-stalled, task-interrupted, …'),
  source: z.string().describe('Who sent it: dept:<slug>'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable(),
  taskId: z.string().nullable(),
  taskNumber: z.number().int().nullable(),
  taskTitle: z
    .string()
    .nullable()
    .describe('The text starts "#<number> <title>: ", so the title tells where the summary begins'),
});
export type ConversationReport = z.infer<typeof ConversationReportSchema>;

export const ConversationRoleSchema = z
  .enum(['owner', 'agent', 'report', 'brief', 'note'])
  .describe(
    "owner: from you · agent: an agent's answer (see author) · report: a lead's report to the chief · " +
      'brief: a task as its lead got it · note: anything else worth showing',
  );
export type ConversationRole = z.infer<typeof ConversationRoleSchema>;

export const ConversationMessageSchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  role: ConversationRoleSchema,
  author: z
    .string()
    .nullable()
    .describe('For agent messages, the agent\'s key ("chief" for the chief of staff), else null'),
  parts: z.array(MessagePartSchema),
  report: ConversationReportSchema.nullable(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationPageSchema = z.object({
  items: z.array(ConversationMessageSchema).describe('Oldest first'),
  nextCursor: z.string().nullable().describe('Pass as ?before= for older messages; null when there are none'),
});
export type ConversationPage = z.infer<typeof ConversationPageSchema>;

export const ConversationQuerySchema = z.object({
  before: z.iso.datetime().optional().describe("The previous page's nextCursor"),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type ConversationQuery = z.infer<typeof ConversationQuerySchema>;

export const ChiefMessageInputSchema = z.object({ message: z.string().trim().min(1).max(20_000) });
export type ChiefMessageInput = z.infer<typeof ChiefMessageInputSchema>;

export const ChiefMessageResultSchema = z.object({
  delivery: z
    .enum(['started', 'queued'])
    .describe('started: the chief is answering · queued: it answers once its current turn is over'),
});
export type ChiefMessageResult = z.infer<typeof ChiefMessageResultSchema>;

export const ChiefStopResultSchema = z.object({
  stopped: z.boolean().describe('False when the chief was not answering'),
});
export type ChiefStopResult = z.infer<typeof ChiefStopResultSchema>;

/**
 * What a conversation's live stream sends (the SSE event name is the type). A turn is `run-start`, then
 * its text, reasoning, tool calls and the messages that reach it, then `run-end`; afterwards its
 * messages are in the conversation's history.
 */
export const LiveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), running: z.boolean() }),
  z.object({
    type: z.literal('run-start'),
    runId: z.string(),
    agent: z.string().nullable().describe('The agent taking the turn (its key), when known'),
  }),
  z.object({
    type: z.literal('text'),
    runId: z.string(),
    id: z.string().describe('The block the text belongs to; a new id starts a new block'),
    delta: z.string(),
  }),
  z.object({ type: z.literal('reasoning'), runId: z.string(), id: z.string(), delta: z.string() }),
  z.object({
    type: z.literal('tool'),
    runId: z.string(),
    part: ToolCallPartSchema.describe('The call as it stands; replaces an earlier one with the same callId'),
  }),
  z.object({
    type: z.literal('answer'),
    runId: z.string(),
    messageId: z
      .string()
      .describe(
        "The history message the turn's answer is stored as while it is written; the turn shows it live",
      ),
  }),
  z.object({ type: z.literal('message'), runId: z.string(), message: ConversationMessageSchema }),
  z.object({
    type: z.literal('run-end'),
    runId: z.string(),
    outcome: z.enum(['finished', 'failed', 'stopped', 'suspended']),
    error: z.string().nullable(),
    messageIds: z
      .array(z.string())
      .describe("The ids of the turn's answers in the history: once they are there, the turn is"),
  }),
]);
export type LiveEvent = z.infer<typeof LiveEventSchema>;
