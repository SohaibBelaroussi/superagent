// Live M7 check: a real model's researcher browses a JavaScript site in its task's browser, through the
// egress proxy. Needs LIVE_LLM_* in .env, the browser image ("docker compose --profile browser build
// browser") and the egress proxy running ("docker compose up -d egress", which creates the network).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createRunner, type Runner, RunnerConfigSchema } from '@superagent/runner';
import type { Department, Provider, Task, TaskEvent } from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { loadDotEnv } from '../../src/env';
import { jsonHeaders, startTestSystem } from '../int/helpers';

loadDotEnv();
const live = {
  baseUrl: process.env.LIVE_LLM_BASE_URL ?? '',
  apiKey: process.env.LIVE_LLM_API_KEY ?? '',
  model: process.env.LIVE_LLM_MODEL ?? '',
};
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const exists = (...args: string[]) => {
  try {
    docker(...args);
    return true;
  } catch {
    return false;
  }
};
const ready =
  exists('image', 'inspect', 'superagent-browser:1') && exists('network', 'inspect', 'superagent-browsers');
const configured = Boolean(live.baseUrl && live.apiKey && live.model && ready);
const SETTLED: ReadonlyArray<Task['phase']> = ['review', 'done', 'waiting', 'failed', 'cancelled'];
const RUN_ID = randomBytes(4).toString('hex');
const PREFIX = `sa-live-${RUN_ID}`;
const TOKEN = `live-${'b'.repeat(40)}`;

describe.skipIf(!configured)('live browsers', () => {
  let runner: Runner;
  let server: ServerType;
  let system: System;
  let web: Department;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    // The real browsers network: its only way out is the egress proxy.
    runner = createRunner(
      RunnerConfigSchema.parse({
        RUNNER_TOKEN: TOKEN,
        RUNNER_NAME_PREFIX: PREFIX,
        RUNNER_WORKSPACES_VOLUME: `sa-live-ws-${RUN_ID}`,
        LOG_LEVEL: 'warn',
      }),
    );
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: runner.app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
    runner.attach(server as Server);
    system = await startTestSystem({
      env: { RUNNER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, RUNNER_TOKEN: TOKEN },
    });
    const provider = (await (
      await send('POST', '/v1/providers', {
        slug: 'live',
        name: 'Live',
        baseUrl: live.baseUrl,
        apiKey: live.apiKey,
      })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'live', model: live.model } } });
    web = (await (
      await send('POST', '/v1/departments', { slug: 'web', name: 'Web', description: 'Reads the web.' })
    ).json()) as Department;
    for (const agent of [
      {
        key: 'web-lead',
        name: 'Web lead',
        role: 'lead',
        description: 'Plans web research and reports results.',
        instructions:
          'Delegate all browsing to the researcher, then report exactly what it found. Keep it short.',
      },
      {
        key: 'researcher',
        name: 'Researcher',
        role: 'specialist',
        description: 'Reads websites with a real browser, including pages built by JavaScript.',
        instructions:
          'Use the browser: open the page, take snapshots to read it and find element refs, click to move on. ' +
          'Return exactly what was asked, quoting the page.',
        tools: [{ key: 'browser' }],
      },
    ]) {
      expect((await send('POST', '/v1/agents', { ...agent, departmentId: web.id })).status).toBe(201);
    }
  }, 120_000);

  afterAll(async () => {
    await system?.close();
    server?.close();
    runner?.stop();
    const leftovers = docker('ps', '-aq', '--filter', `label=superagent.runner=${PREFIX}-browser`).trim();
    if (leftovers) docker('rm', '-f', ...leftovers.split(/\s+/));
  });

  it('reads a JavaScript site over two pages', async () => {
    const created = (await (
      await send('POST', '/v1/tasks', {
        departmentId: web.id,
        title: 'Quotes on a JavaScript site',
        brief:
          'Open https://quotes.toscrape.com/js/ (its quotes are rendered by JavaScript). Report the author of ' +
          'the first quote on the page, then go to the next page and report the author of its first quote.',
      })
    ).json()) as Task;
    const deadline = Date.now() + 300_000;
    let task = created;
    while (!SETTLED.includes(task.phase) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      task = (await (await send('GET', `/v1/tasks/${created.id}`)).json()) as Task;
    }
    const events = (
      (await (await send('GET', `/v1/tasks/${created.id}/events`)).json()) as { items: TaskEvent[] }
    ).items;
    console.info(`[live] task: #${task.number} ${task.phase}`);
    console.info(`[live] events: ${events.map((e) => e.type).join(' > ')}`);
    console.info(`[live] result: ${(task.result ?? '').slice(0, 600)}`);
    expect(events.map((e) => e.type)).toContain('reported');
    expect(task.result ?? '').toMatch(/Einstein/i);
    expect(task.result ?? '').toMatch(/Monroe/i);
  }, 360_000);
});
