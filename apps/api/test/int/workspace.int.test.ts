import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createRunner, type Runner, RunnerConfigSchema } from '@superagent/runner';
import type {
  AttentionList,
  Department,
  Provider,
  SandboxList,
  Task,
  TaskEvent,
  WorkspaceListing,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { RunnerClient } from '../../src/modules/workspace/runner-client';
import { RunnerSandbox } from '../../src/modules/workspace/sandbox';
import { CODE, type FakeOpenAI, type RecordedRequest, startFakeOpenAI } from '../support/fake-openai';
import { jsonHeaders, startTestSystem } from './helpers';

// Any Debian-based image will do for the runner's scripts; the real "dev" image adds Python and git.
const IMAGE = 'node:24.21.0-bookworm-slim';
const RUN_ID = randomBytes(4).toString('hex');
const PREFIX = `sa-int-${RUN_ID}`;
const VOLUME = `sa-int-ws-${RUN_ID}`;
const TOKEN = `runner-${'r'.repeat(40)}`;
const IDLE_MS = 60_000;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('task workspaces', () => {
  let runner: Runner;
  let server: ServerType;
  let runnerUrl: string;
  let system: System;
  let fake: FakeOpenAI;
  let eng: Department;

  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const getTask = async (id: string) => (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task;
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;
  const waitFor = async <T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
  ): Promise<T> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const settled = (id: string) =>
    waitFor(
      () => eventsOf(id),
      (events) => events.some((e) => e.type === 'reported'),
      'the report',
    );
  const coderCalls = (mark: number) =>
    fake.requests
      .slice(mark)
      .filter((r: RecordedRequest) => r.path === '/chat/completions')
      .filter((r) => JSON.stringify(r.body?.messages).includes('[code]'));

  async function boot(databaseUrl?: string) {
    system = await startTestSystem({ databaseUrl, env: { RUNNER_URL: runnerUrl, RUNNER_TOKEN: TOKEN } });
  }

  beforeAll(async () => {
    try {
      docker('image', 'inspect', IMAGE);
    } catch {
      docker('pull', IMAGE);
    }
    runner = createRunner(
      RunnerConfigSchema.parse({
        RUNNER_TOKEN: TOKEN,
        RUNNER_IMAGES: JSON.stringify({ dev: IMAGE }),
        RUNNER_NAME_PREFIX: PREFIX,
        RUNNER_WORKSPACES_VOLUME: VOLUME,
        RUNNER_IDLE_STOP_MS: String(IDLE_MS),
        LOG_LEVEL: 'warn',
      }),
    );
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: runner.app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
    runnerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fake = await startFakeOpenAI(['fake-chat']);
    await boot();
    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    eng = (await (
      await send('POST', '/v1/departments', { slug: 'eng', name: 'Engineering' })
    ).json()) as Department;
    for (const agent of [
      {
        key: 'eng-lead',
        name: 'Engineering lead',
        role: 'lead',
        description: 'Plans engineering work.',
        instructions: 'Delegate coding to the coder.',
      },
      {
        key: 'coder',
        name: 'Coder',
        role: 'specialist',
        description: 'Writes and runs code.',
        instructions: 'Write code in your workspace and run it.',
        tools: [{ key: 'files' }, { key: 'shell' }],
      },
    ]) {
      const res = await send('POST', '/v1/agents', { ...agent, departmentId: eng.id });
      expect(res.status, await res.clone().text()).toBe(201);
    }
  }, 240_000);

  afterAll(async () => {
    await system?.close();
    await fake?.close();
    server?.close();
    runner?.stop();
    const leftovers = docker('ps', '-aq', '--filter', `label=superagent.runner=${PREFIX}`).trim();
    if (leftovers) docker('rm', '-f', ...leftovers.split(/\s+/));
    try {
      docker('volume', 'rm', '-f', VOLUME);
    } catch {
      // still in use by a container being removed
    }
  });

  it('lets a coder write and run code in its task sandbox, and shows the owner its files', async () => {
    const mark = fake.requests.length;
    const task = (await (
      await send('POST', '/v1/tasks', {
        departmentId: eng.id,
        title: 'Hello',
        brief: 'Write and run hello. [code]',
      })
    ).json()) as Task;
    await settled(task.id);

    // The coder ran it: the command's output came back to it.
    expect(JSON.stringify(coderCalls(mark).map((r) => r.body?.messages))).toContain('42');
    const listing = (await (await send('GET', `/v1/tasks/${task.id}/files`)).json()) as WorkspaceListing;
    expect(listing.items.map((i) => i.path)).toContain(CODE.path);
    const file = await send('GET', `/v1/tasks/${task.id}/files/${CODE.path}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await file.text()).toBe(CODE.content);

    const sandboxes = (await (await send('GET', '/v1/sandboxes')).json()) as SandboxList;
    expect(sandboxes.items.find((s) => s.taskId === task.id)).toMatchObject({
      taskNumber: task.number,
      taskTitle: 'Hello',
      state: 'running',
      profile: 'dev',
    });
  });

  it("keeps each sandbox to its own task's folder, with no network", async () => {
    const client = new RunnerClient(runnerUrl, TOKEN);
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    await client.fs(
      a,
      { op: 'write', path: 'secret-a.txt', contentBase64: Buffer.from('only for a').toString('base64') },
      { profile: 'dev' },
    );
    const look = await client.exec(b, {
      profile: 'dev',
      command:
        'id -u; ls -A /workspace | wc -l; find / -name secret-a.txt -not -path "/proc/*" 2>/dev/null | wc -l; ' +
        `node -e "require('net').connect(${new URL(system.config.DATABASE_URL).port || 5432},'host.docker.internal')` +
        `.on('connect',()=>{console.log('reached');process.exit(0)}).on('error',e=>console.log('blocked',e.code))"`,
    });
    const [uid, entries, found, net] = look.stdout.trim().split('\n');
    expect(uid).toBe('1000');
    expect(entries).toBe('0');
    expect(found).toBe('0');
    expect(net).toMatch(/^blocked/);
    // Nothing escapes the workspace through the owner's file routes either.
    expect((await send('GET', `/v1/tasks/${crypto.randomUUID()}/files`)).status).toBe(404);
    const [task] = ((await (await send('GET', '/v1/tasks?limit=1')).json()) as { items: Task[] }).items;
    for (const path of ['..', '../x', '/etc/passwd']) {
      const res = await send('GET', `/v1/tasks/${task?.id}/files?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(400);
    }
    expect((await send('GET', `/v1/tasks/${task?.id}/files/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
    await client.remove(a);
    await client.remove(b);
  });

  it('runs background commands, and finds them again from a new process manager', async () => {
    const client = new RunnerClient(runnerUrl, TOKEN);
    const taskId = crypto.randomUUID();
    const sandbox = new RunnerSandbox(client, taskId, 'dev');
    const handle = await sandbox.processes.spawn(
      'for i in 1 2 3; do echo tick $i; sleep 0.3; done; echo done >&2',
    );
    // As if the API had restarted: a fresh sandbox object finds the process in the container.
    const again = await new RunnerSandbox(client, taskId, 'dev').processes.get(handle.pid);
    expect(again?.command).toContain('tick');
    const result = await handle.wait();
    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(result.stdout).toBe('tick 1\ntick 2\ntick 3\n');
    expect(result.stderr).toBe('done\n');
    const failed = await sandbox.executeCommand('echo out; exit 3');
    expect(failed).toMatchObject({ success: false, exitCode: 3, stdout: 'out\n' });
    const slow = await sandbox.executeCommand('sleep 5; echo late', [], { timeout: 500 });
    expect(slow).toMatchObject({ success: false, timedOut: true });
    await client.remove(taskId);
  });

  it('keeps a task in its sandbox across an API restart, and reaps idle ones', async () => {
    const task = (await (
      await send('POST', '/v1/tasks', {
        departmentId: eng.id,
        title: 'Again',
        brief: 'Write and run hello. [code]',
      })
    ).json()) as Task;
    await settled(task.id);
    const before = ((await (await send('GET', '/v1/sandboxes')).json()) as SandboxList).items.find(
      (s) => s.taskId === task.id,
    );
    const databaseUrl = system.config.DATABASE_URL;
    await system.close();
    await boot(databaseUrl);

    // The owner sends more work: the lead and coder pick it up in the same container, files intact.
    const mark = fake.requests.length;
    expect(
      (await send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Run it again. [code]' })).status,
    ).toBe(200);
    await waitFor(
      () => eventsOf(task.id),
      (events) => events.filter((e) => e.type === 'reported').length >= 2,
      'the second report',
    );
    expect(JSON.stringify(coderCalls(mark).map((r) => r.body?.messages))).toContain('42');
    const after = ((await (await send('GET', '/v1/sandboxes')).json()) as SandboxList).items.find(
      (s) => s.taskId === task.id,
    );
    expect(after?.createdAt).toBe(before?.createdAt);

    // Idle long enough, with nothing running: the reaper stops it. Files stay readable.
    await runner.manager.reap(Date.now() + IDLE_MS * 2);
    const reaped = ((await (await send('GET', '/v1/sandboxes')).json()) as SandboxList).items.find(
      (s) => s.taskId === task.id,
    );
    expect(reaped?.state).toBe('stopped');
    expect((await send('GET', `/v1/tasks/${task.id}/files/${CODE.path}`)).status).toBe(200);

    // Removed: its files stay, read through a throwaway reader.
    expect((await send('DELETE', `/v1/sandboxes/${task.id}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/sandboxes/${task.id}`)).status).toBe(404);
    expect(await (await send('GET', `/v1/tasks/${task.id}/files/${CODE.path}`)).text()).toBe(CODE.content);
    expect((await getTask(task.id)).phase).toBe('review');
  });

  it('says when agents need sandboxes but none are configured', async () => {
    const plain = await startTestSystem();
    try {
      const call = (method: string, path: string, body?: unknown) =>
        plain.app.request(path, {
          method,
          headers: jsonHeaders(),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const lab = (await (
        await call('POST', '/v1/departments', { slug: 'lab', name: 'Lab' })
      ).json()) as Department;
      await call('POST', '/v1/agents', {
        key: 'lab-coder',
        name: 'Lab coder',
        role: 'specialist',
        departmentId: lab.id,
        description: 'Codes.',
        instructions: 'Code.',
        tools: [{ key: 'shell' }],
      });
      const attention = (await (await call('GET', '/v1/attention')).json()) as AttentionList;
      expect(attention.items.find((i) => i.id === 'health:sandboxes')).toMatchObject({
        kind: 'health',
        title: 'Sandboxes are off',
      });
      expect((await call('GET', '/v1/sandboxes')).status).toBe(503);
    } finally {
      await plain.close();
    }
  });
});
