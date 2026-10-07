// Live M6 check: a real model's coder writes and runs a program in its task's sandbox (the "dev"
// image: build it with `docker compose --profile app build sandbox-dev`). Needs LIVE_LLM_* in .env.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createRunner, type Runner, RunnerConfigSchema } from '@superagent/runner';
import type { Department, Provider, Task, TaskEvent, WorkspaceListing } from '@superagent/shared';
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
const IMAGE = 'superagent-sandbox-dev:1';
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hasImage = (() => {
  try {
    docker('image', 'inspect', IMAGE);
    return true;
  } catch {
    return false;
  }
})();
const configured = Boolean(live.baseUrl && live.apiKey && live.model && hasImage);
const SETTLED: ReadonlyArray<Task['phase']> = ['review', 'done', 'waiting', 'failed', 'cancelled'];
const RUN_ID = randomBytes(4).toString('hex');
const TOKEN = `live-${'r'.repeat(40)}`;

describe.skipIf(!configured)('live sandboxes', () => {
  let runner: Runner;
  let server: ServerType;
  let system: System;
  let eng: Department;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    runner = createRunner(
      RunnerConfigSchema.parse({
        RUNNER_TOKEN: TOKEN,
        RUNNER_IMAGES: JSON.stringify({ dev: IMAGE }),
        RUNNER_NAME_PREFIX: `sa-live-${RUN_ID}`,
        RUNNER_WORKSPACES_VOLUME: `sa-live-ws-${RUN_ID}`,
        LOG_LEVEL: 'warn',
      }),
    );
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: runner.app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
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
    eng = (await (
      await send('POST', '/v1/departments', { slug: 'eng', name: 'Engineering', description: 'Writes code.' })
    ).json()) as Department;
    for (const agent of [
      {
        key: 'eng-lead',
        name: 'Engineering lead',
        role: 'lead',
        description: 'Plans engineering work and reports results.',
        instructions: 'Delegate all coding to the coder, then report what it found. Keep it short.',
      },
      {
        key: 'coder',
        name: 'Coder',
        role: 'specialist',
        description: 'Writes programs in its workspace and runs them.',
        instructions:
          'Write the code to a file in your workspace, run it with execute_command, and return the exact output.',
        tools: [{ key: 'files' }, { key: 'shell' }],
      },
    ]) {
      expect((await send('POST', '/v1/agents', { ...agent, departmentId: eng.id })).status).toBe(201);
    }
  }, 120_000);

  afterAll(async () => {
    await system?.close();
    server?.close();
    const leftovers = docker('ps', '-aq', '--filter', `label=superagent.runner=sa-live-${RUN_ID}`).trim();
    if (leftovers) docker('rm', '-f', ...leftovers.split(/\s+/));
    try {
      docker('volume', 'rm', '-f', `sa-live-ws-${RUN_ID}`);
    } catch {
      // in use while a container is removed
    }
  });

  it('writes and runs a program in the task sandbox', async () => {
    const created = (await (
      await send('POST', '/v1/tasks', {
        departmentId: eng.id,
        title: 'First primes',
        brief:
          'Write a Python script primes.py that prints the first 10 prime numbers, one per line, run it, and report its output.',
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
    const listing = (await (
      await send('GET', `/v1/tasks/${created.id}/files?depth=3`)
    ).json()) as WorkspaceListing;
    console.info(`[live] task: #${task.number} ${task.phase}`);
    console.info(`[live] events: ${events.map((e) => e.type).join(' > ')}`);
    console.info(`[live] files: ${listing.items.map((i) => i.path).join(', ')}`);
    console.info(`[live] result: ${(task.result ?? '').slice(0, 400)}`);
    expect(events.map((e) => e.type)).toContain('reported');
    expect(listing.items.some((i) => i.path.endsWith('.py'))).toBe(true);
    expect(task.result ?? '').toContain('29');
  }, 360_000);
});
