import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  BrowserIdentityListSchema,
  BrowserIdentitySchema,
  BrowserSessionListSchema,
  BrowserSessionSchema,
  CreateBrowserIdentityInputSchema,
} from '@superagent/shared';
import type { MiddlewareHandler } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import { ApiError, problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const idParams = z.object({ id: z.uuid() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Frames are dropped for a live view this far behind; events always go. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const listIdentities = createRoute({
  method: 'get',
  path: '/browser-identities',
  tags: ['browser'],
  summary: 'Browser identities',
  description:
    'Signed-in browser profiles. An agent whose browser grant names one browses signed in where it was signed in.',
  responses: { 200: json(BrowserIdentityListSchema, 'Identities') },
});

const createIdentity = createRoute({
  method: 'post',
  path: '/browser-identities',
  tags: ['browser'],
  summary: 'Create a browser identity',
  description:
    'An empty profile. Sign it in with a sign-in session (POST /browser-identities/{id}/session and its live view).',
  request: { body: { content: { 'application/json': { schema: CreateBrowserIdentityInputSchema } } } },
  responses: {
    201: json(BrowserIdentitySchema, 'Created'),
    409: problemResponse('An identity with this name exists'),
  },
});

const getIdentity = createRoute({
  method: 'get',
  path: '/browser-identities/{id}',
  tags: ['browser'],
  summary: 'A browser identity',
  request: { params: idParams },
  responses: {
    200: json(BrowserIdentitySchema, 'The identity'),
    404: problemResponse('No such identity'),
  },
});

const deleteIdentity = createRoute({
  method: 'delete',
  path: '/browser-identities/{id}',
  tags: ['browser'],
  summary: 'Delete a browser identity',
  description: 'Deletes its profile: its cookies and sign-ins are gone.',
  request: { params: idParams },
  responses: {
    204: { description: 'Deleted' },
    404: problemResponse('No such identity'),
    409: problemResponse('A browser uses it, or an agent is granted it'),
  },
});

const openSignIn = createRoute({
  method: 'post',
  path: '/browser-identities/{id}/session',
  tags: ['browser'],
  summary: 'Open a sign-in session',
  description:
    "Opens the identity's browser for the owner. Drive it from the live view (GET /browser-identities/{id}/stream, " +
    'a WebSocket): navigate, click and type to sign in to sites. Close it to save the sign-ins.',
  request: { params: idParams },
  responses: {
    201: json(BrowserSessionSchema, 'Open'),
    404: problemResponse('No such identity'),
    409: problemResponse('Another browser is using the identity'),
    503: problemResponse('Browsers are off or the runner is unreachable'),
  },
});

const closeSignIn = createRoute({
  method: 'delete',
  path: '/browser-identities/{id}/session',
  tags: ['browser'],
  summary: 'Close a sign-in session',
  description: "Closes the identity's sign-in browser; its cookies are saved first.",
  request: { params: idParams },
  responses: {
    204: { description: 'Closed' },
    404: problemResponse('No sign-in session for this identity'),
  },
});

const listBrowsers = createRoute({
  method: 'get',
  path: '/browsers',
  tags: ['browser'],
  summary: 'Open browsers',
  description: "Tasks' browsers, sign-in sessions and the page reader. Each closes after a while unused.",
  responses: { 200: json(BrowserSessionListSchema, 'Browsers') },
});

const getTaskBrowser = createRoute({
  method: 'get',
  path: '/tasks/{id}/browser',
  tags: ['browser'],
  summary: "A task's browser",
  description: 'Watch it with the live view: GET /tasks/{id}/browser/stream (a WebSocket).',
  request: { params: idParams },
  responses: {
    200: json(BrowserSessionSchema, 'The browser'),
    404: problemResponse('No such task, or its browser is not open'),
  },
});

const closeTaskBrowser = createRoute({
  method: 'delete',
  path: '/tasks/{id}/browser',
  tags: ['browser'],
  summary: "Close a task's browser",
  description: "Its identity's cookies are saved; an agent's next browser call opens a new one.",
  request: { params: idParams },
  responses: {
    204: { description: 'Closed' },
    404: problemResponse('No such task, or its browser is not open'),
  },
});

export function registerBrowserRoutes(
  v1: OpenAPIHono<AppEnv>,
  deps: AppDeps,
  upgradeWebSocket: UpgradeWebSocket,
): void {
  const { browsers, identities, tasks } = deps;

  v1.openapi(listIdentities, async (c) => c.json({ items: await identities.list() }, 200));

  v1.openapi(createIdentity, async (c) => c.json(await identities.create(c.req.valid('json')), 201));

  v1.openapi(getIdentity, async (c) => c.json(await identities.get(c.req.valid('param').id), 200));

  v1.openapi(deleteIdentity, async (c) => {
    // Under the config lock: an agent write must not grant the identity while it goes.
    await deps.settings.lock.run(() => identities.remove(c.req.valid('param').id));
    return c.body(null, 204);
  });

  v1.openapi(openSignIn, async (c) => c.json(await browsers.openSignIn(c.req.valid('param').id), 201));

  v1.openapi(closeSignIn, async (c) => {
    const { id } = c.req.valid('param');
    await identities.row(id);
    if (!(await browsers.close(id, 'the owner closed it'))) {
      throw new ApiError(404, 'session_not_open', 'This identity has no sign-in session open');
    }
    return c.body(null, 204);
  });

  v1.openapi(listBrowsers, async (c) => c.json({ items: await browsers.list() }, 200));

  v1.openapi(getTaskBrowser, async (c) => {
    const task = await tasks.get(c.req.valid('param').id);
    const browser = await browsers.ofTask(task.id);
    if (!browser) throw new ApiError(404, 'browser_not_open', `Task #${task.number} has no browser open`);
    return c.json(browser, 200);
  });

  v1.openapi(closeTaskBrowser, async (c) => {
    const task = await tasks.get(c.req.valid('param').id);
    if (!(await browsers.close(task.id, 'the owner closed it'))) {
      throw new ApiError(404, 'browser_not_open', `Task #${task.number} has no browser open`);
    }
    return c.body(null, 204);
  });

  // Live views: WebSockets, so plain routes (not in the OpenAPI document). They sit on this router,
  // behind requireAuth like every /v1 route: a client sends the token as a bearer header, or as
  // ?apiKey= where it can't set headers (browsers).
  // The browser's key is the task's id, or the identity's for its sign-in session.
  const live = () =>
    upgradeWebSocket((c) => {
      const key = c.req.param('id') as string;
      let viewer: ReturnType<typeof browsers.attach> | undefined;
      return {
        onOpen(_event, ws: WSContext) {
          viewer = browsers.attach(key, {
            send(data) {
              const raw = ws.raw as { bufferedAmount?: number } | undefined;
              if (data.startsWith('{') || (raw?.bufferedAmount ?? 0) < MAX_BUFFERED_BYTES) ws.send(data);
            },
          });
        },
        onMessage(event) {
          if (typeof event.data === 'string') viewer?.receive(event.data);
        },
        onClose() {
          viewer?.detach();
        },
        onError() {
          viewer?.detach();
        },
      };
    });

  const existingTask: MiddlewareHandler<AppEnv> = async (c, next) => {
    const id = c.req.param('id') ?? '';
    if (!UUID.test(id)) throw new ApiError(404, 'task_not_found', 'No such task');
    await tasks.get(id);
    await next();
  };
  const existingIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
    const id = c.req.param('id') ?? '';
    if (!UUID.test(id)) throw new ApiError(404, 'identity_not_found', 'No browser identity with this id');
    await identities.row(id);
    await next();
  };

  v1.get('/tasks/:id/browser/stream', existingTask, live());
  v1.get('/browser-identities/:id/stream', existingIdentity, live());
}
