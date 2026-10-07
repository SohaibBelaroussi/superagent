// Live M8 check: a real model uses a plugin's skill (reading one of its reference files) and calls the
// plugin's stdio MCP server, which runs in its own container. Needs LIVE_LLM_* in .env and the MCP
// image ("docker compose --profile mcp build mcp").
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type ServerType, serve } from '@hono/node-server';
import { createRunner, type Runner, RunnerConfigSchema } from '@superagent/runner';
import type { Department, Plugin, PluginPreview, Provider, Task, TaskEvent } from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { loadDotEnv } from '../../src/env';
import { writeTar } from '../../src/modules/capabilities/plugins/tar';
import { jsonHeaders, startTestSystem } from '../int/helpers';

loadDotEnv();
const live = {
  baseUrl: process.env.LIVE_LLM_BASE_URL ?? '',
  apiKey: process.env.LIVE_LLM_API_KEY ?? '',
  model: process.env.LIVE_LLM_MODEL ?? '',
};
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hasImage = (() => {
  try {
    docker('image', 'inspect', 'superagent-mcp:1');
    return true;
  } catch {
    return false;
  }
})();
const configured = Boolean(live.baseUrl && live.apiKey && live.model && hasImage);
const SETTLED: ReadonlyArray<Task['phase']> = ['review', 'done', 'waiting', 'failed', 'cancelled'];
const RUN_ID = randomBytes(4).toString('hex');
const PREFIX = `sa-live-${RUN_ID}`;
const VOLUMES = `sa-live-mcp-${RUN_ID}`;
const TOKEN = `live-${'m'.repeat(40)}`;
const FIXTURE = join(import.meta.dirname, '../fixtures/plugins/demo-kit');

describe.skipIf(!configured)('live capabilities', () => {
  let runner: Runner;
  let runnerServer: ServerType;
  let files: Server;
  let system: System;
  let ops: Department;
  let archiveUrl = '';
  let archiveSha = '';
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    const entries: Array<{ path: string; mode: number; data: Buffer }> = [];
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const path = join(at, name);
        if (statSync(path).isDirectory()) walk(path);
        else
          entries.push({
            path: relative(FIXTURE, path).replaceAll('\\', '/'),
            mode: 0o644,
            data: readFileSync(path),
          });
      }
    };
    walk(FIXTURE);
    const archive = gzipSync(writeTar(entries));
    archiveSha = createHash('sha256').update(archive).digest('hex');
    files = createServer((_req, res) => res.writeHead(200).end(archive));
    await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
    archiveUrl = `http://127.0.0.1:${(files.address() as AddressInfo).port}/demo-kit.tar.gz`;
    runner = createRunner(
      RunnerConfigSchema.parse({
        RUNNER_TOKEN: TOKEN,
        RUNNER_NAME_PREFIX: PREFIX,
        RUNNER_WORKSPACES_VOLUME: `sa-live-ws-${RUN_ID}`,
        RUNNER_MCP_VOLUME_PREFIX: VOLUMES,
        RUNNER_MCP_PROXY: '',
        LOG_LEVEL: 'warn',
      }),
    );
    runnerServer = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: runner.app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
    system = await startTestSystem({
      env: {
        RUNNER_URL: `http://127.0.0.1:${(runnerServer.address() as AddressInfo).port}`,
        RUNNER_TOKEN: TOKEN,
      },
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

    const preview = (await (
      await send('POST', '/v1/plugins/preview', {
        source: { kind: 'url', url: archiveUrl, sha256: archiveSha, allowPrivateNetwork: true },
      })
    ).json()) as PluginPreview;
    let plugin = (await (
      await send('POST', '/v1/plugins', { previewId: preview.id, network: 'none' })
    ).json()) as Plugin;
    const deadline = Date.now() + 120_000;
    while (plugin.status === 'installing' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      plugin = (await (await send('GET', `/v1/plugins/${plugin.id}`)).json()) as Plugin;
    }
    expect(plugin.status, plugin.statusDetail ?? '').toBe('installed');
    ops = (await (
      await send('POST', '/v1/departments', {
        slug: 'ops',
        name: 'Operations',
        skills: ['demo-kit'],
        mcp: [{ server: 'demo-kit-notes' }],
      })
    ).json()) as Department;
    const res = await send('POST', '/v1/agents', {
      key: 'ops-lead',
      name: 'Ops lead',
      role: 'lead',
      departmentId: ops.id,
      description: 'Runs operations and writes release notes.',
      instructions:
        'Do the work yourself with your skills and tools, then report. Follow skills exactly, including their reference files.',
    });
    expect(res.status, await res.clone().text()).toBe(201);
  }, 240_000);

  afterAll(async () => {
    await system?.close();
    runnerServer?.close();
    files?.close();
    runner?.stop();
    const leftovers = docker('ps', '-aq', '--filter', `label=superagent.runner=${PREFIX}-mcp`).trim();
    if (leftovers) docker('rm', '-f', ...leftovers.split(/\s+/));
    const volumes = docker('volume', 'ls', '-q', '--filter', `name=${VOLUMES}`).trim();
    if (volumes) docker('volume', 'rm', '-f', ...volumes.split(/\s+/));
  });

  it("uses a plugin's skill and calls its MCP server", async () => {
    const created = (await (
      await send('POST', '/v1/tasks', {
        departmentId: ops.id,
        title: 'Release notes',
        brief:
          'Use the release-notes skill to write release notes for these changes: fixed the login bug, added a ' +
          'dark mode. Its house style guide has a magic word: include it. Then greet Ada with your greet tool and ' +
          'include exactly what it returned in your report.',
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
    console.info(`[live] result: ${(task.result ?? '').slice(0, 800)}`);
    expect(events.map((e) => e.type)).toContain('reported');
    expect(task.result ?? '').toMatch(/PERIWINKLE/i);
    expect(task.result ?? '').toContain('Hello, Ada!');
  }, 360_000);
});
