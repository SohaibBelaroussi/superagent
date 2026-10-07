import { timingSafeEqual } from 'node:crypto';
import {
  EnsureBrowserInputSchema,
  EnsureSandboxInputSchema,
  ExecInputSchema,
  FsRequestSchema,
  SandboxProfileSchema,
} from '@superagent/shared/runner';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { BrowserContainers } from './browsers';
import type { RunnerConfig } from './config';
import { dockerMessage } from './docker';
import { type Logger, RunnerError, type SandboxManager } from './sandboxes';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) throw new RunnerError(413, 'too_large', 'Request body too large');
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new RunnerError(400, 'invalid_request', 'Expected a JSON body');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new RunnerError(400, 'invalid_request', parsed.error.issues.map((i) => i.message).join('; '));
  }
  return parsed.data;
}

function profileOf(query: string | undefined): string {
  const parsed = SandboxProfileSchema.safeParse(query);
  if (!parsed.success) throw new RunnerError(400, 'invalid_request', 'Bad profile');
  return parsed.data;
}

/** The runner's internal HTTP API. Every route but /health needs the shared bearer token. */
export function createRunnerApp(
  manager: SandboxManager,
  browsers: BrowserContainers,
  config: RunnerConfig,
  log: Logger,
): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof RunnerError) {
      return c.json({ code: error.code, message: error.message }, error.status as 400);
    }
    log.error('Runner request failed', { path: c.req.path, error: dockerMessage(error) });
    return c.json({ code: 'docker_error', message: dockerMessage(error) }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!sameToken(token, config.RUNNER_TOKEN)) {
      return c.json({ code: 'unauthorized', message: 'Missing or wrong runner token' }, 401);
    }
    await next();
  });

  // Whether sandboxes and browsers can actually run. /health only says the runner is up.
  app.get('/ready', async (c) => {
    const sandboxes = await manager.ready();
    return c.json({ ...sandboxes, browser: sandboxes.docker && (await browsers.ready()) });
  });

  app.get('/sandboxes', async (c) => c.json({ items: await manager.list() }));

  app.get('/sandboxes/:taskId', async (c) => {
    const sandbox = await manager.get(c.req.param('taskId'));
    if (!sandbox) throw new RunnerError(404, 'sandbox_not_found', 'This task has no sandbox');
    return c.json(sandbox);
  });

  app.post('/sandboxes/:taskId', async (c) => {
    const { profile } = await body(c.req.raw, EnsureSandboxInputSchema);
    return c.json(await manager.ensure(c.req.param('taskId'), profile));
  });

  app.delete('/sandboxes/:taskId', async (c) => {
    if (!(await manager.remove(c.req.param('taskId')))) {
      throw new RunnerError(404, 'sandbox_not_found', 'This task has no sandbox');
    }
    return c.body(null, 204);
  });

  app.post('/sandboxes/:taskId/exec', async (c) => {
    const input = await body(c.req.raw, ExecInputSchema);
    return c.json(await manager.exec(c.req.param('taskId'), input, c.req.raw.signal));
  });

  app.get('/sandboxes/:taskId/processes', async (c) =>
    c.json({ items: await manager.processes(c.req.param('taskId')) }),
  );

  app.get('/sandboxes/:taskId/processes/:execId', async (c) => {
    const offset = (name: string) => Math.max(Number.parseInt(c.req.query(name) ?? '0', 10) || 0, 0);
    const maxBytes = Number.parseInt(c.req.query('maxBytes') ?? String(256 * 1024), 10) || 256 * 1024;
    return c.json(
      await manager.process(
        c.req.param('taskId'),
        c.req.param('execId'),
        { out: offset('outFrom'), err: offset('errFrom') },
        maxBytes,
      ),
    );
  });

  app.delete('/sandboxes/:taskId/processes/:execId', async (c) =>
    c.json({ killed: await manager.killProcess(c.req.param('taskId'), c.req.param('execId')) }),
  );

  app.post('/sandboxes/:taskId/fs', async (c) => {
    const request = await body(c.req.raw, FsRequestSchema);
    return c.json(
      await manager.fs(c.req.param('taskId'), request, {
        profile: profileOf(c.req.query('profile')),
        peek: c.req.query('peek') === '1',
      }),
    );
  });

  // Browsers (decision D34). Their DevTools connections are WebSocket upgrades, served by
  // BrowserContainers.relay with a ticket from POST /browsers/:taskId, not by these routes.
  app.get('/browsers', async (c) => c.json({ items: await browsers.list() }));

  app.get('/browsers/:taskId', async (c) => {
    const browser = await browsers.get(c.req.param('taskId'));
    if (!browser) throw new RunnerError(404, 'browser_not_found', 'This task has no browser');
    return c.json(browser);
  });

  app.post('/browsers/:taskId', async (c) => {
    const { identityId } = await body(c.req.raw, EnsureBrowserInputSchema);
    return c.json(await browsers.ensure(c.req.param('taskId'), identityId));
  });

  app.delete('/browsers/:taskId', async (c) => {
    if (!(await browsers.remove(c.req.param('taskId')))) {
      throw new RunnerError(404, 'browser_not_found', 'This task has no browser');
    }
    return c.body(null, 204);
  });

  /** Deletes an identity's profile volume (404 if it had none). */
  app.delete('/identities/:identityId', async (c) => {
    if (!(await browsers.removeIdentity(c.req.param('identityId')))) {
      throw new RunnerError(404, 'not_found', 'This identity has no profile');
    }
    return c.body(null, 204);
  });

  return app;
}
