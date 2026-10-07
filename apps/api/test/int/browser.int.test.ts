import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import { createRunner, type Runner, RunnerConfigSchema } from '@superagent/runner';
import type {
  AttentionList,
  BrowserIdentity,
  BrowserSession,
  BrowserSessionList,
  Department,
  Provider,
  Task,
  TaskEvent,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { type FakeOpenAI, startFakeOpenAI } from '../support/fake-openai';
import { jsonHeaders, startTestSystem, TEST_ADMIN_TOKEN } from './helpers';

const BROWSER_IMAGE = 'superagent-browser:1';
const SITE_IMAGE = 'busybox:1.37';
const RUN_ID = randomBytes(4).toString('hex');
const PREFIX = `sa-int-${RUN_ID}`;
const NETWORK = `sa-int-br-${RUN_ID}`;
const SITE = `sa-int-site-${RUN_ID}`;
const IDENTITY_PREFIX = `sa-int-id-${RUN_ID}`;
const TOKEN = `runner-${'b'.repeat(40)}`;
/** The test site's name on the closed network; the API is told it resolves to a public address. */
const HOST = 'quotes.example.com';
const ORIGIN = `http://${HOST}:8080`;
const QUOTE = 'Simplicity is prerequisite for reliability';

const PAGES: Record<string, string> = {
  // The quotes only exist once the button's script has fetched and rendered them.
  'index.html': `<!doctype html><html><head><title>Quotes</title></head><body>
<h1>Quotes</h1><button id="load" onclick="load()">Load quotes</button><ul id="quotes"></ul>
<script>
async function load() {
  const quotes = await (await fetch('quotes.json')).json();
  document.getElementById('quotes').innerHTML = quotes.map((q) => '<li>' + q.text + ' (' + q.author + ')</li>').join('');
}
</script></body></html>`,
  'quotes.json': JSON.stringify([
    { text: QUOTE, author: 'Edsger Dijkstra' },
    { text: 'Premature optimization is the root of all evil', author: 'Donald Knuth' },
  ]),
  'login.html': `<!doctype html><html><head><title>Sign in</title></head><body><p id="state">...</p>
<script>
document.cookie = 'sa_session=owner-42; max-age=31536000; path=/';
document.getElementById('state').textContent = 'Signed in as owner-42';
</script></body></html>`,
  'account.html': `<!doctype html><html><head><title>Account</title></head><body><p id="state">...</p>
<script>
const session = /sa_session=([^;]+)/.exec(document.cookie);
document.getElementById('state').textContent = session ? 'Welcome back, ' + session[1] : 'Not signed in';
</script></body></html>`,
};

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasImage(image: string): boolean {
  try {
    docker('image', 'inspect', image);
    return true;
  } catch {
    return false;
  }
}

/** A WebSocket client that keeps every message it gets. */
async function openLiveView(url: string): Promise<{
  socket: WebSocket;
  messages: string[];
  next(match: (message: string) => boolean, label: string): Promise<string>;
}> {
  const socket = new WebSocket(url);
  const messages: string[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener('message', (event) => {
    messages.push(String(event.data));
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('live view did not open')), { once: true });
  });
  let seen = 0;
  return {
    socket,
    messages,
    async next(match, label) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        while (seen < messages.length) {
          const message = messages[seen++] as string;
          if (match(message)) return message;
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 500);
        });
      }
    },
  };
}

describe('browsers', () => {
  let runner: Runner;
  let runnerServer: ServerType;
  let runnerUrl: string;
  let apiServer: ServerType;
  let apiUrl: string;
  let system: System;
  let fake: FakeOpenAI;
  let web: Department;
  let accounts: Department;

  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;
  const waitFor = async <T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
  ): Promise<T> => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const reported = (id: string) =>
    waitFor(
      () => eventsOf(id),
      (events) => events.some((e) => e.type === 'reported'),
      'the report',
    );
  /** What the agents' models were shown since `mark`: tool results included. */
  const seenSince = (mark: number) =>
    JSON.stringify(fake.requests.slice(mark).map((r) => r.body?.messages ?? null));
  const createTask = async (departmentId: string, brief: string) => {
    const res = await send('POST', '/v1/tasks', { departmentId, title: brief.slice(0, 40), brief });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Task;
  };

  beforeAll(async () => {
    if (!hasImage(BROWSER_IMAGE)) {
      throw new Error(`Build the browser image first: docker compose --profile browser build browser`);
    }
    if (!hasImage(SITE_IMAGE)) docker('pull', SITE_IMAGE);
    // A closed network: the browsers reach the test site and nothing else, so no egress proxy.
    docker('network', 'create', '--internal', NETWORK);
    const pages = mkdtempSync(join(tmpdir(), 'sa-site-'));
    for (const [name, content] of Object.entries(PAGES)) writeFileSync(join(pages, name), content);
    docker(
      'create',
      '--name',
      SITE,
      '--network',
      NETWORK,
      '--network-alias',
      HOST,
      SITE_IMAGE,
      'httpd',
      '-f',
      '-p',
      '8080',
      '-h',
      '/www',
    );
    // /www doesn't exist in the image: docker cp creates it with the folder's files.
    docker('cp', pages, `${SITE}:/www`);
    rmSync(pages, { recursive: true, force: true });
    docker('start', SITE);

    runner = createRunner(
      RunnerConfigSchema.parse({
        RUNNER_TOKEN: TOKEN,
        RUNNER_NAME_PREFIX: PREFIX,
        RUNNER_WORKSPACES_VOLUME: `sa-int-ws-${RUN_ID}`,
        RUNNER_BROWSER_NETWORK: NETWORK,
        RUNNER_BROWSER_PROXY: '',
        RUNNER_IDENTITY_VOLUME_PREFIX: IDENTITY_PREFIX,
        LOG_LEVEL: 'warn',
      }),
    );
    runnerServer = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: runner.app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
    runner.attach(runnerServer as Server);
    runnerUrl = `http://127.0.0.1:${(runnerServer.address() as AddressInfo).port}`;
    fake = await startFakeOpenAI(['fake-chat']);
    system = await startTestSystem({
      env: {
        RUNNER_URL: runnerUrl,
        RUNNER_TOKEN: TOKEN,
        // Nothing listens here: fetch_page falls back to the browser.
        CRAWL4AI_URL: 'http://127.0.0.1:9',
      },
      resolveHost: async (host) => (host === HOST ? ['93.184.215.14'] : []),
    });
    apiServer = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: system.app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
    system.injectWebSocket(apiServer as Server);
    apiUrl = `127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    const department = async (slug: string, name: string) =>
      (await (await send('POST', '/v1/departments', { slug, name })).json()) as Department;
    web = await department('web', 'Web');
    accounts = await department('accounts', 'Accounts');
    for (const [departmentId, key] of [
      [web.id, 'web-lead'],
      [accounts.id, 'accounts-lead'],
    ] as const) {
      const res = await send('POST', '/v1/agents', {
        key,
        name: key,
        role: 'lead',
        departmentId,
        description: 'Plans the work.',
        instructions: 'Delegate browsing to your specialist.',
      });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    const res = await send('POST', '/v1/agents', {
      key: 'browser-agent',
      name: 'Browser agent',
      role: 'specialist',
      departmentId: web.id,
      description: 'Reads web pages with a browser.',
      instructions: 'Use the browser.',
      tools: [{ key: 'browser' }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
  }, 240_000);

  afterAll(async () => {
    await system?.close();
    apiServer?.close();
    await fake?.close();
    runnerServer?.close();
    runner?.stop();
    const leftovers = docker('ps', '-aq', '--filter', `label=superagent.runner=${PREFIX}-browser`).trim();
    if (leftovers) docker('rm', '-f', ...leftovers.split(/\s+/));
    for (const command of [
      ['rm', '-f', SITE],
      ['network', 'rm', NETWORK],
    ]) {
      try {
        docker(...command);
      } catch {
        // already gone
      }
    }
    const volumes = docker('volume', 'ls', '-q', '--filter', `name=${IDENTITY_PREFIX}`).trim();
    if (volumes) docker('volume', 'rm', '-f', ...volumes.split(/\s+/));
  });

  it('browses a JavaScript page in several steps, in the task’s own browser', async () => {
    const mark = fake.requests.length;
    const task = await createTask(web.id, `Read the quotes. [browse:${ORIGIN}/index.html]`);
    await reported(task.id);

    // The quote is only on the page after the click ran the page's script.
    const seen = seenSince(mark);
    expect(seen).toContain('Load quotes');
    expect(seen).toContain(QUOTE);
    const browser = (await (await send('GET', `/v1/tasks/${task.id}/browser`)).json()) as BrowserSession;
    expect(browser).toMatchObject({
      kind: 'task',
      taskId: task.id,
      taskNumber: task.number,
      identity: null,
      url: `${ORIGIN}/index.html`,
      title: 'Quotes',
      takenOver: false,
    });
    const list = (await (await send('GET', '/v1/browsers')).json()) as BrowserSessionList;
    expect(list.items.map((item) => item.taskId)).toContain(task.id);

    // Only public addresses: the check runs before the browser is asked.
    const goto = system.browsers.toolsFor({ requireApproval: false }).browser_goto as {
      execute(input: unknown, context: unknown): Promise<unknown>;
    };
    const blocked = await goto.execute(
      { url: 'http://169.254.169.254/latest/meta-data' },
      { requestContext: new Map([['superagent.taskId', task.id]]) },
    );
    expect(blocked).toMatchObject({ success: false, code: 'blocked_url' });
  }, 120_000);

  it('shows the owner a live view that needs a token, and lets them take over', async () => {
    const task = await createTask(web.id, `Read the quotes again. [browse:${ORIGIN}/index.html]`);
    await reported(task.id);
    const path = `/v1/tasks/${task.id}/browser/stream`;

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`http://${apiUrl}${path}`, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('upgrade', () => reject(new Error('upgraded without a token')));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);

    const view = await openLiveView(`ws://${apiUrl}${path}?apiKey=${TEST_ADMIN_TOKEN}`);
    await view.next((m) => m === '{"status":"connected"}', 'connected');
    await view.next((m) => m === '{"status":"streaming"}', 'streaming');
    await view.next((m) => !m.startsWith('{') && m.length > 1000, 'a frame');

    // Input only reaches the page once the owner has taken over (the agents then wait).
    view.socket.send(JSON.stringify({ type: 'mouse', eventType: 'mouseMoved', x: 10, y: 10 }));
    await view.next((m) => m.includes('"not_taken_over"'), 'a refusal');
    view.socket.send(JSON.stringify({ type: 'takeover', on: true }));
    await view.next((m) => m === '{"status":"taken_over"}', 'taken over');
    expect(
      ((await (await send('GET', `/v1/tasks/${task.id}/browser`)).json()) as BrowserSession).takenOver,
    ).toBe(true);
    view.socket.send(JSON.stringify({ type: 'navigate', url: 'http://10.0.0.1/' }));
    await view.next((m) => m.includes('"blocked_url"'), 'a blocked navigation');
    view.socket.send(JSON.stringify({ type: 'navigate', url: `${ORIGIN}/account.html` }));
    await view.next((m) => m.includes('account.html'), 'the new page');
    view.socket.send(JSON.stringify({ type: 'takeover', on: false }));
    await view.next((m) => m === '{"status":"released"}', 'released');

    expect((await send('DELETE', `/v1/tasks/${task.id}/browser`)).status).toBe(204);
    await view.next((m) => m === '{"status":"browser_closed"}', 'closed');
    expect((await send('GET', `/v1/tasks/${task.id}/browser`)).status).toBe(404);
    view.socket.close();
  }, 120_000);

  it('keeps an identity signed in across tasks, one browser at a time', async () => {
    const created = await send('POST', '/v1/browser-identities', {
      name: 'owner-site',
      description: 'Test site',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const identity = (await created.json()) as BrowserIdentity;
    expect((await send('POST', '/v1/browser-identities', { name: 'owner-site' })).status).toBe(409);

    // Grants name identities that exist, on the browser only.
    const agent = (tools: unknown) =>
      send('POST', '/v1/agents', {
        key: 'account-agent',
        name: 'Account agent',
        role: 'specialist',
        departmentId: accounts.id,
        description: 'Uses the owner’s account on the test site.',
        instructions: 'Use the browser.',
        tools,
      });
    const refusal = async (tools: unknown) => ((await (await agent(tools)).json()) as { code: string }).code;
    expect(await refusal([{ key: 'browser', identity: 'nobody' }])).toBe('unknown_identity');
    expect(await refusal([{ key: 'current_time', identity: 'owner-site' }])).toBe('identity_not_applicable');
    const res = await agent([{ key: 'browser', identity: 'owner-site' }]);
    expect(res.status, await res.clone().text()).toBe(201);

    // Task A signs in: the site sets a lasting cookie in the identity's profile.
    let mark = fake.requests.length;
    const a = await createTask(accounts.id, `Sign in. [visit:${ORIGIN}/login.html]`);
    await reported(a.id);
    expect(seenSince(mark)).toContain('Signed in as owner-42');
    const held = (await (
      await send('GET', `/v1/browser-identities/${identity.id}`)
    ).json()) as BrowserIdentity;
    expect(held.holder).toMatchObject({ kind: 'task', taskId: a.id, taskNumber: a.number });
    expect((await send('DELETE', `/v1/browser-identities/${identity.id}`)).status).toBe(409);
    expect((await send('POST', `/v1/browser-identities/${identity.id}/session`)).status).toBe(409);

    // Task B needs the same identity while A's browser has it: it waits, and the owner sees why.
    mark = fake.requests.length;
    const b = await createTask(accounts.id, `Check the account. [visit:${ORIGIN}/account.html]`);
    await waitFor(
      async () => ((await (await send('GET', '/v1/attention')).json()) as AttentionList).items,
      (items) => items.some((item) => item.taskId === b.id && item.title.includes('"owner-site"')),
      'the wait to show',
    );
    expect(seenSince(mark)).not.toContain('Welcome back');

    // Closing A's browser saves its cookies and frees the identity: B goes on, still signed in.
    expect((await send('DELETE', `/v1/tasks/${a.id}/browser`)).status).toBe(204);
    await reported(b.id);
    expect(seenSince(mark)).toContain('Welcome back, owner-42');
    const now = (await (
      await send('GET', `/v1/browser-identities/${identity.id}`)
    ).json()) as BrowserIdentity;
    expect(now.holder).toMatchObject({ kind: 'task', taskId: b.id });

    // The owner's sign-in session takes the identity once B's browser is closed.
    expect((await send('DELETE', `/v1/tasks/${b.id}/browser`)).status).toBe(204);
    const signIn = await send('POST', `/v1/browser-identities/${identity.id}/session`);
    expect(signIn.status, await signIn.clone().text()).toBe(201);
    expect(((await signIn.json()) as BrowserSession).kind).toBe('sign-in');
    const view = await openLiveView(
      `ws://${apiUrl}/v1/browser-identities/${identity.id}/stream?apiKey=${TEST_ADMIN_TOKEN}`,
    );
    await view.next((m) => m === '{"status":"streaming"}', 'streaming');
    // No takeover in a sign-in session: the owner drives it.
    view.socket.send(JSON.stringify({ type: 'navigate', url: `${ORIGIN}/account.html` }));
    await view.next((m) => m.includes('account.html'), 'the account page');
    view.socket.close();
    expect((await send('DELETE', `/v1/browser-identities/${identity.id}/session`)).status).toBe(204);
    const free = (await (
      await send('GET', `/v1/browser-identities/${identity.id}`)
    ).json()) as BrowserIdentity;
    expect(free.holder).toBeNull();
  }, 240_000);

  it('reads pages the page service cannot, in a fresh context each time', async () => {
    const page = await system.browsers.read(`${ORIGIN}/account.html`, { maxChars: 1000 });
    expect(page).toMatchObject({ url: `${ORIGIN}/account.html`, title: 'Account', truncated: false });
    // A fresh context: the identity's cookie is not there.
    expect(page.text).toBe('Not signed in');
    await expect(system.browsers.read('http://127.0.0.1:4111/', { maxChars: 100 })).rejects.toThrow(
      /internal or private/,
    );
    const list = (await (await send('GET', '/v1/browsers')).json()) as BrowserSessionList;
    expect(list.items.some((item) => item.kind === 'reader')).toBe(true);
  }, 120_000);
});
