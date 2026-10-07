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
