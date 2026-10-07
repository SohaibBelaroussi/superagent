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

export const ProviderModelSchema = z.object({
  modelId: z.string(),
  kind: ModelKindSchema,
  source: z.enum(['discovered', 'manual']),
  enabled: z.boolean(),
  discoveredAt: z.string().nullable(),
  ref: z.string().describe('Model reference for agents and settings: sa/<provider>/<model>'),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderModelListSchema = z.object({ items: z.array(ProviderModelSchema) });

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

export const ToolGrantSchema = z.object({
  key: z.string().min(1).describe('Tool key from GET /v1/catalog/tools'),
  requireApproval: z
    .boolean()
    .default(false)
    .describe('Pause for the owner before each call. Approvals arrive in M5; until then true is rejected.'),
});
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export const AgentVersionSchema = z.object({
  version: z.number().int(),
  description: z.string(),
  instructions: z.string(),
  model: ModelRefSchema.nullable().describe('null: use the default model role'),
  tools: z.array(ToolGrantSchema),
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
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

/** Changing description, instructions, model or tools creates and activates a new version. */
export const UpdateAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: DescriptionSchema.optional(),
  instructions: InstructionsSchema.optional(),
  model: ModelRefSchema.nullable().optional(),
  tools: z.array(ToolGrantSchema).max(50).optional(),
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
});
export type CreateDepartmentInput = z.infer<typeof CreateDepartmentInputSchema>;

export const UpdateDepartmentInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  autoClose: z.boolean().optional(),
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
