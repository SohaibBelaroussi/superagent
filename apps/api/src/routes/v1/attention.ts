import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { AttentionListSchema, type Decision, DecisionInputSchema, DecisionSchema } from '@superagent/shared';
import type { DecisionRow } from '../../db/schema';
import { optionalJsonBody } from '../../http/body';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    kind: row.kind,
    target: row.target,
    reason: row.reason,
    status: row.status,
    taskId: row.taskId,
    createdAt: row.createdAt.toISOString(),
  };
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const tags = ['attention'];
const decisionRequest = {
  params: z.object({ id: z.string().min(1).describe('An approval item id (URL-encoded)') }),
  headers: z.object({
    'idempotency-key': z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Retrying with the same key returns the first outcome instead of deciding twice'),
  }),
};
const decisionResponses = {
  200: json(DecisionSchema, 'The decision, applied'),
  404: problemResponse('Nothing waits for a decision under this id'),
  409: problemResponse('The call was decided already, or the key was used for another decision'),
  500: problemResponse('The decision could not be applied; nothing changed, so it can be retried'),
};

const listAttention = createRoute({
  method: 'get',
  path: '/attention',
  tags,
  summary: 'What needs you',
  description:
    'Tool calls waiting for your approval, questions from leads, tasks that stopped, results to review, ' +
    'and setup problems. Newest first.',
  responses: { 200: json(AttentionListSchema, 'Attention items') },
});

const approve = createRoute({
  method: 'post',
  path: '/attention/{id}/approve',
  tags,
  summary: 'Approve a tool call; the agent carries on',
  request: decisionRequest,
  responses: decisionResponses,
});

const decline = createRoute({
  method: 'post',
  path: '/attention/{id}/decline',
  tags,
  summary: 'Decline a tool call; the agent is told why and carries on without it',
  description: 'Optional JSON body: `{ "reason": "..." }`.',
  request: decisionRequest,
  responses: decisionResponses,
});

export function registerAttentionRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { attention, decisions } = deps;

  v1.openapi(listAttention, async (c) => c.json({ items: await attention.list() }, 200));

  const decide = async (
    id: string,
    kind: 'approve' | 'decline',
    reason: string | undefined,
    key: string | undefined,
  ) => toDecision(await decisions.decide(id, kind, reason, key, 'owner'));

  v1.openapi(approve, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await decide(id, 'approve', undefined, c.req.valid('header')['idempotency-key']), 200);
  });

  v1.openapi(decline, async (c) => {
    const { id } = c.req.valid('param');
    const { reason } = await optionalJsonBody(c.req, DecisionInputSchema, '{ "reason": "..." }');
    return c.json(await decide(id, 'decline', reason, c.req.valid('header')['idempotency-key']), 200);
  });
}
