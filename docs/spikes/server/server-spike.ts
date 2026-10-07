import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { MastraAuthProvider, registerApiRoute } from '@mastra/core/server';
import type { MastraAuthRequest } from '@mastra/core/server';
import { MastraServer, createAuthMiddleware, type HonoBindings, type HonoVariables } from '@mastra/hono';
import { createRoute } from '@mastra/server/server-adapter';
import { scripted } from './mock.ts';

type User = { id: string; name: string; tokenId: string };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenTable = new Map<string, User>([[sha256('sa_test_owner'), { id: 'owner', name: 'Owner', tokenId: 'tok_1' }]]);
let seenRequestShape = '';

class TokenAuth extends MastraAuthProvider<User> {
  constructor(opts: { protected?: any[] } = {}) {
    super({ name: 'token-auth', mapUserToResourceId: (u: User) => u.id, ...opts });
  }
  async authenticateToken(token: string, request: MastraAuthRequest): Promise<User | null> {
    seenRequestShape = request instanceof Request ? 'Request' : `object{${Object.keys(request).join(',')}}`;
    return tokenTable.get(sha256(token)) ?? null;
  }
  authorizeUser(user: User) {
    return !!user?.id;
  }
}

function routes() {
  return [
    registerApiRoute('/board/tasks', {
      method: 'GET',
      handler: async c => {
        const rc = c.get('requestContext');
        return c.json({ user: rc.get('user'), mastraUser: rc.get('mastra__user'), resourceId: rc.get('mastra__resourceId') });
      },
    }),
    registerApiRoute('/healthz', { method: 'GET', requiresAuth: false, handler: async c => c.json({ ok: true }) }),
    createRoute({
      method: 'POST',
      path: '/departments',
      responseType: 'json',
      bodySchema: z.object({ name: z.string().min(1) }),
      responseSchema: z.object({ id: z.string(), name: z.string(), by: z.string().optional() }),
      summary: 'Create department',
      tags: ['departments'],
      handler: async ({ name, requestContext }) => ({ id: 'dep_1', name, by: (requestContext.get('user') as User | undefined)?.id }),
    }),
    createRoute({
      method: 'GET',
      path: '/board/events',
      responseType: 'stream',
      streamFormat: 'sse',
      sseFlushOnConnect: true,
      summary: 'Board events (SSE)',
      tags: ['board'],
      handler: async () =>
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue({ type: 'task.created', taskId: 't1' });
            ctrl.enqueue(': keep-alive\n\n');
            ctrl.enqueue({ type: 'task.updated', taskId: 't1', status: 'running' });
            ctrl.close();
          },
        }),
    }),
  ];
}

function makeMastra(authOpts?: { protected?: any[] }) {
  const agent = new Agent({ id: 'chief', name: 'Chief', instructions: 'x', model: scripted([{ text: 'hi' }]) });
  return new Mastra({
    agents: { chief: agent },
    logger: false as any,
    server: { auth: new TokenAuth(authOpts), apiRoutes: routes() },
  });
}

const log = (label: string, v: unknown) => console.log(label.padEnd(58), typeof v === 'string' ? v : JSON.stringify(v));
const auth = { Authorization: 'Bearer sa_test_owner' };

// ---------- default prefix (/api) ----------
const mastra = makeMastra();
const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
const server = new MastraServer({ app, mastra, openapiPath: '/openapi.json' });
await server.init();
app.get('/native/open', c => c.json({ ok: true }));
app.get('/native/secure', createAuthMiddleware({ mastra }), c =>
  c.json({ user: c.get('requestContext').get('user'), mastraUser: c.get('requestContext').get('mastra__user') }),
);
app.get('/api/native-under-api', c => c.json({ ok: 'reachable' }));

async function hit(path: string, init?: RequestInit) {
  const r = await app.request(path, init);
  const text = await r.text();
  return `${r.status} ${text.slice(0, 160).replace(/\n/g, '\\n')}`;
}

log('GET /api/agents (no token)', await hit('/api/agents'));
log('GET /api/agents (token)', (await hit('/api/agents', { headers: auth })).slice(0, 40));
log('GET /api/agents?apiKey=token', (await hit('/api/agents?apiKey=sa_test_owner')).slice(0, 40));
log('authenticateToken request shape', seenRequestShape);
log('GET /board/tasks (no token)', await hit('/board/tasks'));
log('GET /board/tasks (token)', await hit('/board/tasks', { headers: auth }));
log('GET /healthz requiresAuth:false', await hit('/healthz'));
log('POST /departments (token, valid)', await hit('/departments', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eng' }) }));
log('POST /departments (token, invalid)', await hit('/departments', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }) }));
log('POST /departments (no token)', await hit('/departments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eng' }) }));
log('GET /board/events SSE (token)', await hit('/board/events', { headers: auth }));
log('GET /native/open', await hit('/native/open'));
log('GET /native/secure (no token)', await hit('/native/secure'));
log('GET /native/secure (token)', await hit('/native/secure', { headers: auth }));
log('GET /api/native-under-api (no token)', await hit('/api/native-under-api'));
const spec = JSON.parse((await (await app.request('/api/openapi.json', { headers: auth })).text()));
log('openapi at /api/openapi.json: custom paths', Object.keys(spec.paths ?? {}).filter(p => !p.startsWith('/agents') && !p.match(/^\/(workflows|memory|tools|vectors|logs|scores|observability|mcp|a2a|stored|workspaces?|processors|agent-builder|datasets|telemetry|system|channels|auth|responses|conversations|tool-providers|processor-providers|schedules|background-tasks|editor|editor-builder|legacy|dynamic-workflows)/)));
log('openapi /openapi.json (no token) status', (await app.request('/api/openapi.json')).status);

// ---------- /api custom route rejected ----------
try {
  const m2 = new Mastra({ logger: false as any, server: { auth: new TokenAuth(), apiRoutes: [registerApiRoute('/api/board', { method: 'GET', handler: async c => c.json({}) })] } });
  const s2 = new MastraServer({ app: new Hono(), mastra: m2 });
  await s2.init();
  log('registerApiRoute("/api/board") init', 'NO ERROR');
} catch (e: any) {
  log('registerApiRoute("/api/board") init', `THROWS: ${e.message.slice(0, 110)}`);
}

// ---------- custom prefix footgun ----------
{
  const m3 = makeMastra();
  const app3 = new Hono();
  await new MastraServer({ app: app3, mastra: m3, prefix: '/mastra' }).init();
  const r = await app3.request('/mastra/agents');
  log('prefix=/mastra GET /mastra/agents (no token)', `${r.status}`);
  const m4 = makeMastra({ protected: ['/mastra/*'] });
  const app4 = new Hono();
  await new MastraServer({ app: app4, mastra: m4, prefix: '/mastra' }).init();
  const r4 = await app4.request('/mastra/agents');
  log('prefix=/mastra + protected:["/mastra/*"] (no token)', `${r4.status}`);
}

// ---------- workers ----------
log('workers before startWorkers', mastra.workers.map((w: any) => `${w.name}:${w.isRunning ?? '?'}`).join(','));
await mastra.startWorkers();
log('workers after startWorkers', mastra.workers.map((w: any) => `${w.name}:${w.isRunning ?? '?'}`).join(','));
await mastra.shutdown({ drainTimeout: 500 });
log('shutdown', 'ok');
process.exit(0);
