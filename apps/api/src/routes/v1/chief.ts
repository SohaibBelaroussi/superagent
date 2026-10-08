import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi';
import {
  ChiefMessageInputSchema,
  ChiefMessageResultSchema,
  ChiefStopResultSchema,
  ConversationPageSchema,
  ConversationQuerySchema,
} from '@superagent/shared';
import { LIVE_EVENTS_DESCRIPTION, liveStream } from '../../http/live';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

const tags = ['chief'];
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const listMessages = createRoute({
  method: 'get',
  path: '/chief/messages',
  tags,
  summary: 'Your conversation with the chief of staff',
  description:
    "Your messages, the chief's answers with the tools it used, and the departments' reports to it (each " +
    'with the task it is about), oldest first. Go back with ?before=<nextCursor>. Follow it live: GET /chief/stream.',
  request: { query: ConversationQuerySchema },
  responses: { 200: json(ConversationPageSchema, 'Messages, oldest first') },
});

const sendMessage = createRoute({
  method: 'post',
  path: '/chief/messages',
  tags,
  summary: 'Write to the chief of staff',
  description:
    'Starts its next turn: right away when it is idle, else once its current turn is over (messages sent ' +
    'meanwhile go together). Its answer comes on GET /chief/stream, then in the history.',
  request: { body: { required: true, content: { 'application/json': { schema: ChiefMessageInputSchema } } } },
  responses: {
    202: json(ChiefMessageResultSchema, 'Taken'),
    400: problemResponse('Invalid message'),
    503: problemResponse('The server is shutting down'),
  },
});

const stop = createRoute({
  method: 'post',
  path: '/chief/stop',
  tags,
  summary: "Stop the chief's answer",
  description: 'Stops the turn it is taking. Messages waiting for that turn to end then start the next one.',
  responses: { 200: json(ChiefStopResultSchema, 'Whether a turn was stopped') },
});

export function registerChiefRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  v1.openapi(listMessages, async (c) =>
    c.json(await deps.conversations.chiefPage(c.req.valid('query')), 200),
  );

  v1.openapi(sendMessage, async (c) => {
    const delivery = await deps.dispatch.messageChief(c.req.valid('json').message);
    return c.json({ delivery }, 202);
  });

  v1.openapi(stop, (c) => c.json({ stopped: deps.dispatch.stopChief() }, 200));

  v1.get('/chief/stream', (c) =>
    liveStream(c, deps, async (stream, signal) => {
      for await (const event of deps.conversations.followChief(signal)) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    }),
  );

  v1.openAPIRegistry.registerPath({
    method: 'get',
    path: '/chief/stream',
    tags,
    summary: 'Your conversation with the chief, live (Server-Sent Events)',
    description: LIVE_EVENTS_DESCRIPTION,
    responses: { 200: { description: 'text/event-stream' } },
  });
}
