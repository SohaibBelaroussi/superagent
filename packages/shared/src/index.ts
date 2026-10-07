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

const HeadersSchema = z
  .record(z.string().min(1), z.string())
  .describe('Extra headers sent with every request');

export const ProviderSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  hasApiKey: z.boolean().describe('Keys are stored encrypted and never returned'),
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
  apiKey: z.string().min(1).max(4096).optional(),
  headers: HeadersSchema.optional(),
  strictJson: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type CreateProviderInput = z.infer<typeof CreateProviderInputSchema>;

/** The slug cannot change: model references point at it. `apiKey: null` / `headers: null` clear them. */
export const UpdateProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  baseUrl: BaseUrlSchema.optional(),
  apiKey: z.string().min(1).max(4096).nullable().optional(),
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
