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
import { RunnerFilesystem } from '../../src/modules/workspace/filesystem';
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
        'ls /sys/class/net | tr "\\n" " "; echo; ' +
        `node -e "require('net').connect(443,'1.1.1.1')` +
        `.on('connect',()=>{console.log('reached');process.exit(0)}).on('error',e=>console.log('blocked',e.code))"`,
    });
    const [uid, entries, found, interfaces, net] = look.stdout.trim().split('\n');
    expect(uid).toBe('1000');
    expect(entries).toBe('0');
    expect(found).toBe('0');
    expect(interfaces?.trim()).toBe('lo');
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

  it('reads files safely: no pipes, every byte of long output, binaries marked as such', async () => {
    const client = new RunnerClient(runnerUrl, TOKEN);
    const taskId = crypto.randomUUID();
    const sandbox = new RunnerSandbox(client, taskId, 'dev');
    // A pipe would block a reader forever: it is refused at once.
    await sandbox.executeCommand(
      'mkfifo pipe; printf "x\\tevil" > target-name; ln -s "$(cat target-name)" link; printf "a\\0b" > data.bin; printf "\\211PNG\\0" > chart.png; echo hi > notes',
    );
    const started = Date.now();
    await expect(client.fs(taskId, { op: 'read', path: 'pipe' }, { profile: 'dev' })).rejects.toMatchObject({
      code: 'not_regular',
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    // Names and link targets with tabs list as they are.
    const listed = await client.fs(taskId, { op: 'list', path: '.' }, { profile: 'dev' });
    expect(listed.entries?.find((e) => e.path === 'link')).toMatchObject({
      type: 'symlink',
      target: 'x\tevil',
    });
    // Binaries aren't passed off as text, whatever their name.
    const files = new RunnerFilesystem(client, taskId, 'dev');
    expect((await files.stat('chart.png')).mimeType).toBe('image/png');
    expect((await files.stat('data.bin')).mimeType).toBe('application/x-binary');
    expect((await files.stat('notes')).mimeType).toBeUndefined();
    // Long background output arrives whole, in order, however it repeats.
    const handle = await sandbox.processes.spawn('yes 0123456789 | head -c 700000; echo done >&2');
    const result = await handle.wait();
    expect(result.stdout.length).toBe(700_000);
    expect(result.stdout.startsWith('0123456789\n0123456789\n')).toBe(true);
    expect(result.stderr).toBe('done\n');
    await client.remove(taskId);
  });

  it('leaves no reader container behind for a task without a workspace', async () => {
    const helpers = () => docker('ps', '-aq', '--filter', `label=superagent.runner=${PREFIX}-helper`).trim();
    const client = new RunnerClient(runnerUrl, TOKEN);
    for (let i = 0; i < 2; i++) {
      await expect(
        client.fs(crypto.randomUUID(), { op: 'list', path: '.' }, { profile: 'dev', peek: true }),
      ).rejects.toMatchObject({ code: 'sandbox_not_found' });
    }
    expect(helpers()).toBe('');
    expect((await runner.manager.ready()).images).toEqual({ dev: true });
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

describe('sandbox limits', () => {
  const RUN = randomBytes(4).toString('hex');
  const prefix = `sa-lim-${RUN}`;
  const volume = `sa-lim-ws-${RUN}`;
  const limits = createRunner(
    RunnerConfigSchema.parse({
      RUNNER_TOKEN: TOKEN,
      RUNNER_IMAGES: JSON.stringify({ dev: IMAGE }),
      RUNNER_NAME_PREFIX: prefix,
      RUNNER_WORKSPACES_VOLUME: volume,
      RUNNER_PIDS_LIMIT: '40',
      RUNNER_FILE_LIMIT_MB: '1',
      RUNNER_MIN_FREE_MB: '0',
      LOG_LEVEL: 'error',
    }),
  );

  afterAll(() => {
    const leftovers = docker('ps', '-aq', '--filter', `label=superagent.runner=${prefix}`).trim();
    if (leftovers) docker('rm', '-f', ...leftovers.split(/\s+/));
    try {
      docker('volume', 'rm', '-f', volume);
    } catch {
      // in use while a container is removed
    }
  });

  it('stops a command that takes every process slot, then works again', async () => {
    const taskId = crypto.randomUUID();
    const started = Date.now();
    const result = await limits.manager.exec(taskId, {
      profile: 'dev',
      command: 'for i in $(seq 1 200); do sleep 60 & done; wait',
      timeoutMs: 1500,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
    const after = await limits.manager.exec(taskId, { profile: 'dev', command: 'echo back' });
    expect(after).toMatchObject({ exitCode: 0, stdout: 'back\n' });
  });

  it('caps the size of a single file', async () => {
    const result = await limits.manager.exec(crypto.randomUUID(), {
      profile: 'dev',
      command: 'head -c 2000000 /dev/zero > big; echo "exit $?"; stat -c %s big',
    });
    const [status, size] = result.stdout.trim().split('\n');
    expect(status).not.toBe('exit 0');
    expect(Number(size)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('runs nothing once the caller gave up', async () => {
    const taskId = crypto.randomUUID();
    const aborted = new AbortController();
    aborted.abort();
    const result = await limits.manager.exec(
      taskId,
      { profile: 'dev', command: 'touch ran' },
      aborted.signal,
    );
    expect(result.killed).toBe(true);
    const check = await limits.manager.exec(taskId, { profile: 'dev', command: 'ls ran 2>&1 || echo none' });
    expect(check.stdout.trim()).toMatch(/none|No such file/);
  });

  it('refuses work while the disk is nearly full', async () => {
    const full = createRunner(
      RunnerConfigSchema.parse({
        RUNNER_TOKEN: TOKEN,
        RUNNER_IMAGES: JSON.stringify({ dev: IMAGE }),
        RUNNER_NAME_PREFIX: prefix,
        RUNNER_WORKSPACES_VOLUME: volume,
        // More than any disk has.
        RUNNER_MIN_FREE_MB: String(1024 * 1024 * 1024),
        LOG_LEVEL: 'error',
      }),
    );
    await expect(
      full.manager.exec(crypto.randomUUID(), { profile: 'dev', command: 'echo hi' }),
    ).rejects.toMatchObject({ code: 'disk_full', status: 507 });
  });
});
