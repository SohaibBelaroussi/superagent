import { AgentBrowser, type BrowserToolName, createAgentBrowserTools } from '@mastra/agent-browser';
import type { ToolsInput } from '@mastra/core/agent';
import type { ScreencastStream } from '@mastra/core/browser';
import type { IMastraLogger } from '@mastra/core/logger';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import {
  type BrowserSession,
  type BrowserViewerEvent,
  type BrowserViewerInput,
  BrowserViewerInputSchema,
} from '@superagent/shared';
import { ApiError } from '../../http/problem';
import type { EventBus } from '../ledger/events';
import { TERMINAL_PHASES } from '../ledger/phases';
import type { TaskService } from '../ledger/service';
import { assertPublicUrl, type ResolveHost } from '../tools/web';
import { type RunnerClient, RunnerRequestError } from '../workspace/runner-client';
import { taskOf } from '../workspace/service';
import type { IdentityHolder, IdentityService } from './identities';

/** Screenshots go to the model as images; the models agents use may not read them. */
const EXCLUDED_TOOLS: BrowserToolName[] = ['browser_screenshot'];
/** The page reader's browser key: any valid id that is no task's or identity's. */
const READER_KEY = '00000000-0000-4000-8000-000000000000';
const SWEEP_MS = 30_000;
const TAKEOVER_WAIT_MS = 60_000;
const IDENTITY_POLL_MS = 2_000;
const READ_TIMEOUT_MS = 30_000;

/** Windows virtual key codes for keys that type no text (CDP needs them to act on the key). */
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

type SessionKind = BrowserSession['kind'];

interface Session {
  key: string;
  kind: SessionKind;
  taskId: string | null;
  identity: { id: string; name: string } | null;
  holder: IdentityHolder | null;
  browser: AgentBrowser;
  tools: ReturnType<typeof createAgentBrowserTools>;
  openedAt: number;
  lastUsedAt: number;
  takenOver: boolean;
  /** Live-view input, one event at a time. */
  input: Promise<void>;
  stream?: ScreencastStream;
  streaming?: Promise<void>;
  viewport?: { width: number; height: number };
}

/** A live view's socket: text messages out, closed by the server when the session can't be shown. */
export interface ViewerSocket {
  send(data: string): void;
}

interface Viewer {
  key: string;
  socket: ViewerSocket;
}

/** A tool result the model reads: the same shape as agent-browser's own errors. */
type ToolFailure = { success: false; code: string; message: string; hint: string };

function failure(code: string, message: string, hint: string): ToolFailure {
  return { success: false, code, message, hint };
}

/** A browser that can't be opened, with a reason the model or the owner can act on. */
export class BrowserUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface BrowserDeps {
  /** Unset when no runner is configured: the browser grant then gives no tools. */
  client?: RunnerClient;
  identities: IdentityService;
  tasks: TaskService;
  bus: EventBus;
  logger: IMastraLogger;
  idleCloseMs: number;
  identityWaitMs: number;
  takeoverWaitMs?: number;
  /** Tests resolve names their own way. */
  resolveHost?: ResolveHost;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

/**
 * Agents' browsers (decision D34): one per task, a Chromium container the runner starts and the API
 * drives over DevTools. Each browser gets its own AgentBrowser, so nothing one task does (a drop, a
 * close) touches another's. Also the owner's sign-in sessions for identities, the live view, and the
 * page reader fetch_page falls back to.
 */
export class BrowserService {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<Session>>();
  private readonly viewers = new Map<string, Set<Viewer>>();
  /** Tasks waiting for an identity another browser holds: key -> identity name. */
  private readonly waiting = new Map<string, { identity: string; since: number }>();
  private readonly templates: ReturnType<typeof createAgentBrowserTools>;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: BrowserDeps) {
    // The tools' names, descriptions and schemas. This browser is never launched.
    this.templates = createAgentBrowserTools(
      new AgentBrowser({ scope: 'shared', cdpUrl: 'ws://127.0.0.1:9' }),
    );
    for (const name of EXCLUDED_TOOLS) delete this.templates[name];
  }

  get enabled(): boolean {
    return Boolean(this.deps.client);
  }

  /** Frees identities a previous run held, removes its browsers, and starts the idle sweep. */
  async start(): Promise<void> {
    if (!this.deps.client || this.timer) return;
    await this.deps.identities.releaseAll();
    const client = this.deps.client;
    void client
      .browsers()
      .then((leftovers) => Promise.all(leftovers.map((b) => client.removeBrowser(b.taskId))))
      .catch((error: unknown) => this.deps.logger.warn('Could not remove leftover browsers', { error }));
    this.unsubscribe = this.deps.bus.subscribe((event) => {
      if (TERMINAL_PHASES.has(event.phase) && this.sessions.has(event.taskId)) {
        void this.close(event.taskId, 'its task closed');
      }
    });
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  /** Closes every browser (saving identities' cookies) and stops the sweep. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    await Promise.allSettled([...this.sessions.keys()].map((key) => this.close(key, 'the server stopped')));
  }

  /** The browser tools of a `browser` grant: each call works in its task's browser. */
  toolsFor(grant: { identity?: string; requireApproval: boolean }): ToolsInput {
    const tools: ToolsInput = {};
    if (!this.deps.client) return tools;
    for (const [name, template] of Object.entries(this.templates)) {
      tools[name] = createTool({
        id: name,
        description: template.description,
        inputSchema: template.inputSchema,
        requireApproval: grant.requireApproval,
        execute: (input, context) =>
          this.run(name, input as Record<string, unknown>, context, grant.identity),
      });
    }
    return tools;
  }

  /** Open browsers, for the owner. */
  async list(): Promise<BrowserSession[]> {
    return Promise.all([...this.sessions.values()].map((session) => this.describe(session)));
  }

  /** The task's browser, if open. */
  async ofTask(taskId: string): Promise<BrowserSession | undefined> {
    const session = this.sessions.get(taskId);
    return session?.kind === 'task' ? this.describe(session) : undefined;
  }

  /** Tasks waiting for an identity, for the attention inbox. */
  waitingTasks(): Array<{ taskId: string; identity: string; since: string }> {
    return [...this.waiting.entries()].map(([taskId, wait]) => ({
      taskId,
      identity: wait.identity,
      since: new Date(wait.since).toISOString(),
    }));
  }

  /** What stops browsers from working right now, if anything (for the attention inbox). */
  async problem(): Promise<string | undefined> {
    if (!this.deps.client) return 'off';
    const ready = await this.deps.client.ready();
    if (!ready) return 'unreachable';
    if (!ready.docker) return 'no-docker';
    if (!ready.browser) return 'no-image';
    return undefined;
  }

  /**
   * Opens the owner's sign-in session for an identity: its browser, driven from the live view
   * (/v1/browser-identities/{id}/stream), so passwords never pass through a model.
   */
  async openSignIn(identityId: string): Promise<BrowserSession> {
    const row = await this.deps.identities.row(identityId);
    const existing = this.sessions.get(identityId);
    if (existing) return this.describe(existing);
    try {
      return this.describe(
        await this.open(identityId, { kind: 'sign-in', taskId: null, identity: row.name }),
      );
    } catch (error) {
      throw this.asApiError(error);
    }
  }

  /** Closes a browser: a task's (by task id) or a sign-in session (by identity id). */
  async close(key: string, reason: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session) return false;
    this.sessions.delete(key);
    await session.stream?.stop().catch(() => {});
    this.broadcast(key, { status: 'browser_closed' });
    await session.browser.close().catch(() => {});
    // Stopped before the lock goes, so the next holder never shares the profile with this browser.
    await this.deps.client?.removeBrowser(key).catch((error: unknown) => {
      this.deps.logger.warn('Could not stop a browser', { key, error });
    });
    if (session.identity && session.holder) {
      await this.deps.identities.release(session.identity.id, session.holder).catch((error: unknown) => {
        this.deps.logger.warn('Could not release a browser identity', { key, error });
      });
    }
    this.deps.logger.info('Browser closed', { kind: session.kind, key, reason });
    return true;
  }

  /**
   * A live view of a browser: frames and events out, the owner's input in (only after taking over,
   * except in a sign-in session). The browser need not be open yet: frames start when it opens.
   */
  attach(key: string, socket: ViewerSocket): { receive(data: string): void; detach(): void } {
    const viewer: Viewer = { key, socket };
    let set = this.viewers.get(key);
    if (!set) {
      set = new Set();
      this.viewers.set(key, set);
    }
    set.add(viewer);
    this.send(viewer, { status: 'connected' });
    const session = this.sessions.get(key);
    if (session) {
      if (session.takenOver) this.send(viewer, { status: 'taken_over' });
      void this.startStream(session);
    } else {
      this.send(viewer, { status: 'browser_closed' });
    }
    return {
      receive: (data) => void this.receive(viewer, data),
      detach: () => {
        set.delete(viewer);
        if (set.size > 0) return;
        this.viewers.delete(key);
        const current = this.sessions.get(key);
        if (!current) return;
        void current.stream?.stop().catch(() => {});
        // Nobody is watching: the agents get the browser back.
        if (current.takenOver) current.takenOver = false;
      },
    };
  }

  /**
   * Reads a page in the shared reader browser, in a fresh context each time (no cookies kept): for
   * pages the page service can't read. Redirects and subresources go through the egress proxy.
   */
  async read(
    rawUrl: string,
    options: { maxChars: number; signal?: AbortSignal },
  ): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const target = await assertPublicUrl(rawUrl, this.deps.resolveHost);
    const session = await this.open(READER_KEY, { kind: 'reader', taskId: null });
    session.lastUsedAt = Date.now();
    const manager = await session.browser.getManagerForThread();
    const browser = manager.getBrowser();
    if (!browser) throw new Error('The reader browser is not connected');
    const context = await browser.newContext();
    const abort = () => void context.close().catch(() => {});
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const page = await context.newPage();
      try {
        await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: READ_TIMEOUT_MS });
      } catch (error) {
        // A page that keeps polling never goes idle: read what loaded.
        if (!/timeout/i.test(String(error))) throw error;
      }
      const text = String(await page.evaluate('document.body ? document.body.innerText : ""')).trim();
      return {
        url: page.url(),
        title: await page.title(),
        text: text.slice(0, options.maxChars),
        truncated: text.length > options.maxChars,
      };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      await context.close().catch(() => {});
    }
  }

  // --- tools ---

  private async run(
    name: string,
    input: Record<string, unknown>,
    context: { requestContext?: RequestContext; abortSignal?: AbortSignal; agent?: object } | undefined,
    identity: string | undefined,
  ): Promise<unknown> {
    const taskId = taskOf(context?.requestContext);
    if (!taskId) {
      return failure('browser_error', 'The browser only works inside a task.', 'Do this as part of a task.');
    }
    const url = name === 'browser_goto' || name === 'browser_tabs' ? input.url : undefined;
    if (typeof url === 'string') {
      try {
        await assertPublicUrl(url, this.deps.resolveHost);
      } catch (error) {
        return failure('blocked_url', (error as Error).message, 'Only public http(s) pages can be opened.');
      }
    }
    if (name === 'browser_close') {
      await this.close(taskId, 'an agent closed it');
      return { success: true, hint: 'Browser closed. browser_goto opens a new one.' };
    }
    let session: Session;
    try {
      session = await this.open(taskId, { kind: 'task', taskId, identity }, context?.abortSignal);
    } catch (error) {
      if (context?.abortSignal?.aborted) throw error;
      const reason = this.reason(error);
      return failure(reason.code, reason.message, reason.hint);
    }
    if (!(await this.waitForOwner(session, context?.abortSignal))) {
      return failure(
        'taken_over',
        'The owner is using this browser in the live view.',
        'Try again in a minute, or carry on without the browser.',
      );
    }
    session.lastUsedAt = Date.now();
    const tool = session.tools[name];
    if (!tool?.execute) return failure('browser_error', `Unknown browser tool ${name}`, 'Use another tool.');
    // agent-browser routes by the agent's thread; this browser serves one task whatever the thread.
    return tool.execute(input, {
      ...context,
      agent: { ...(context?.agent ?? {}), threadId: `task:${taskId}` },
    } as never);
  }

  /** Waits (a while) while the owner has the browser in the live view. False if they still do. */
  private async waitForOwner(session: Session, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + (this.deps.takeoverWaitMs ?? TAKEOVER_WAIT_MS);
    while (session.takenOver) {
      if (Date.now() >= deadline) return false;
      await sleep(500, signal);
    }
    return true;
  }

  // --- sessions ---

  private open(
    key: string,
    spec: { kind: SessionKind; taskId: string | null; identity?: string },
    signal?: AbortSignal,
  ): Promise<Session> {
    const existing = this.sessions.get(key);
    if (existing) return Promise.resolve(this.sameIdentity(existing, spec.identity));
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.create(key, spec, signal).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending.then((session) => this.sameIdentity(session, spec.identity));
  }

  /** A task has one browser: an agent granted another identity (or none) can't use it as is. */
  private sameIdentity(session: Session, identity: string | undefined): Session {
    if ((session.identity?.name ?? undefined) === identity) return session;
    const current = session.identity ? `signed in as "${session.identity.name}"` : 'open without an identity';
    throw new BrowserUnavailableError(
      'identity_mismatch',
      `This task's browser is ${current}, and your browser grant uses ${identity ? `"${identity}"` : 'none'}.`,
      'Ask your lead, or close it with browser_close if the other agent is done with it.',
    );
  }

  private async create(
    key: string,
    spec: { kind: SessionKind; taskId: string | null; identity?: string },
    signal?: AbortSignal,
  ): Promise<Session> {
    const client = this.deps.client;
    if (!client) {
      throw new BrowserUnavailableError('browser_unavailable', 'Browsers are off.', 'Carry on without one.');
    }
    let identity: Session['identity'] = null;
    let holder: IdentityHolder | null = null;
    if (spec.identity) {
      const row = await this.deps.identities.byName(spec.identity);
      if (!row) {
        throw new BrowserUnavailableError(
          'identity_not_found',
          `There is no browser identity named "${spec.identity}".`,
          'Ask the owner to create it, or carry on without it.',
        );
      }
      identity = { id: row.id, name: row.name };
      holder =
        spec.kind === 'task' && spec.taskId ? { kind: 'task', taskId: spec.taskId } : { kind: 'owner' };
      await this.lock(key, identity, holder, spec.kind === 'task' ? this.deps.identityWaitMs : 0, signal);
    }
    const browser = new AgentBrowser({
      scope: 'shared',
      headless: true,
      timeout: 30_000,
      excludeTools: EXCLUDED_TOOLS,
      // Each (re)connection asks the runner for the browser (starting it if needed) and a fresh ticket.
      cdpUrl: async () => {
        const ensured = await client.ensureBrowser(key, identity?.id);
        return client.cdpUrl(key, ensured.ticket);
      },
    });
    browser.__setLogger(this.deps.logger);
    try {
      await browser.launch();
    } catch (error) {
      await browser.close().catch(() => {});
      await client.removeBrowser(key).catch(() => {});
      if (identity && holder) await this.deps.identities.release(identity.id, holder).catch(() => {});
      throw error;
    }
    const tools = createAgentBrowserTools(browser);
    for (const name of EXCLUDED_TOOLS) delete tools[name];
    const now = Date.now();
    const session: Session = {
      key,
      kind: spec.kind,
      taskId: spec.taskId,
      identity,
      holder,
      browser,
      tools,
      openedAt: now,
      lastUsedAt: now,
      takenOver: false,
      input: Promise.resolve(),
    };
    this.sessions.set(key, session);
    // The live view follows the browser through drops and reconnections.
    browser.onBrowserReady(() => void this.startStream(session));
    browser.onBrowserClosed(() => this.broadcast(key, { status: 'browser_closed' }));
    this.deps.logger.info('Browser opened', { kind: spec.kind, key, identity: identity?.name ?? null });
    // A task that closed while its browser started had nothing to close then: close it now. Once the
    // session is registered, a later close finds it through the event bus.
    if (spec.taskId && TERMINAL_PHASES.has((await this.deps.tasks.get(spec.taskId)).phase)) {
      await this.close(key, 'its task closed');
      throw new BrowserUnavailableError('task_closed', 'This task is closed.', 'Stop working on it.');
    }
    return session;
  }

  /** Takes the identity's lock, waiting up to `waitMs` while another browser holds it. */
  private async lock(
    key: string,
    identity: { id: string; name: string },
    holder: IdentityHolder,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + waitMs;
    try {
      for (;;) {
        if (await this.deps.identities.acquire(identity.id, holder)) return;
        if (Date.now() >= deadline) {
          throw new BrowserUnavailableError(
            'identity_busy',
            `The browser identity "${identity.name}" is in use by another browser${waitMs > 0 ? ` (waited ${Math.round(waitMs / 60_000)} min)` : ''}.`,
            'Try again later, or carry on without it.',
          );
        }
        if (!this.waiting.has(key)) this.waiting.set(key, { identity: identity.name, since: Date.now() });
        await sleep(IDENTITY_POLL_MS, signal);
      }
    } finally {
      this.waiting.delete(key);
    }
  }

  /** Renews identity locks and closes browsers nobody has used (or watched) for a while. */
  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      try {
        const watched = (this.viewers.get(session.key)?.size ?? 0) > 0;
        if (!watched && now - session.lastUsedAt >= this.deps.idleCloseMs) {
          await this.close(session.key, 'idle');
          continue;
        }
        if (session.identity && session.holder) {
          const held = await this.deps.identities.renew(session.identity.id, session.holder);
          if (!held) await this.close(session.key, 'its identity lock lapsed');
        }
      } catch (error) {
        this.deps.logger.warn('Browser sweep failed', { key: session.key, error });
      }
    }
  }

  private async describe(session: Session): Promise<BrowserSession> {
    let url: string | null = null;
    let title: string | null = null;
    try {
      const page = (await session.browser.getManagerForThread()).getPage();
      url = page.url();
      title = await Promise.race([page.title(), sleep(2_000).then(() => null)]);
    } catch {
      // disconnected: reconnects on its next use
    }
    const task = session.taskId ? await this.deps.tasks.byIds([session.taskId]) : undefined;
    return {
      kind: session.kind,
      taskId: session.taskId,
      taskNumber: session.taskId ? (task?.get(session.taskId)?.number ?? null) : null,
      identity: session.identity?.name ?? null,
      url,
      title,
      takenOver: session.takenOver,
      viewers: this.viewers.get(session.key)?.size ?? 0,
      openedAt: new Date(session.openedAt).toISOString(),
      lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    };
  }

  // --- live view ---

  private async startStream(session: Session): Promise<void> {
    if (session.stream?.isActive() || session.streaming) return;
    if (!this.viewers.get(session.key)?.size || this.sessions.get(session.key) !== session) return;
    session.streaming = (async () => {
      try {
        const stream = await session.browser.startScreencast({
          format: 'jpeg',
          quality: 70,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        });
        session.stream = stream;
        stream.on('frame', (frame: { data: string; viewport: { width: number; height: number } }) => {
          const { width, height } = frame.viewport;
          if (session.viewport?.width !== width || session.viewport?.height !== height) {
            session.viewport = { width, height };
            this.broadcast(session.key, { viewport: { width, height } });
          }
          this.broadcastRaw(session.key, frame.data);
        });
        stream.on('url', (url: string) => this.broadcast(session.key, { url }));
        stream.on('stop', () => {
          if (session.stream === stream) session.stream = undefined;
        });
        stream.on('error', () => {});
        this.broadcast(session.key, { status: 'streaming' });
        const url = await session.browser.getCurrentUrl().catch(() => null);
        if (url) this.broadcast(session.key, { url });
      } catch (error) {
        this.deps.logger.debug('Live view could not start', { key: session.key, error });
      } finally {
        session.streaming = undefined;
      }
    })();
    await session.streaming;
  }

  private async receive(viewer: Viewer, data: string): Promise<void> {
    let message: BrowserViewerInput;
    try {
      message = BrowserViewerInputSchema.parse(JSON.parse(data));
    } catch {
      return this.send(viewer, { error: 'invalid_message', message: 'Not a live-view message' });
    }
    const session = this.sessions.get(viewer.key);
    if (!session) return this.send(viewer, { error: 'browser_closed', message: 'The browser is closed' });
    session.lastUsedAt = Date.now();
    if (message.type === 'takeover') {
      if (session.kind !== 'task') return;
      session.takenOver = message.on;
      return this.broadcast(session.key, { status: message.on ? 'taken_over' : 'released' });
    }
    if (session.kind === 'task' && !session.takenOver) {
      return this.send(viewer, {
        error: 'not_taken_over',
        message: 'Take over first ({"type":"takeover","on":true}): the agents are using this browser',
      });
    }
    if (message.type === 'navigate') {
      try {
        await assertPublicUrl(message.url, this.deps.resolveHost);
      } catch (error) {
        return this.send(viewer, { error: 'blocked_url', message: (error as Error).message });
      }
      return this.enqueue(session, async () => {
        await session.browser.goto({ url: message.url, waitUntil: 'domcontentloaded' });
      });
    }
    if (message.type === 'mouse') {
      return this.enqueue(session, () =>
        session.browser.injectMouseEvent({
          type: message.eventType,
          x: message.x,
          y: message.y,
          button: message.button,
          clickCount: message.clickCount,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          modifiers: message.modifiers,
        }),
      );
    }
    return this.enqueue(session, () =>
      session.browser.injectKeyboardEvent({
        type: message.eventType,
        key: message.key,
        code: message.code,
        text: message.text,
        modifiers: message.modifiers,
        windowsVirtualKeyCode: message.key ? VIRTUAL_KEYS[message.key] : undefined,
      }),
    );
  }

  private enqueue(session: Session, action: () => Promise<unknown>): void {
    session.input = session.input.then(action).then(
      () => undefined,
      (error: unknown) => this.deps.logger.debug('Live-view input failed', { key: session.key, error }),
    );
  }

  private send(viewer: Viewer, event: BrowserViewerEvent): void {
    try {
      viewer.socket.send(JSON.stringify(event));
    } catch {
      // the viewer left
    }
  }

  private broadcast(key: string, event: BrowserViewerEvent): void {
    this.broadcastRaw(key, JSON.stringify(event));
  }

  private broadcastRaw(key: string, data: string): void {
    for (const viewer of this.viewers.get(key) ?? []) {
      try {
        viewer.socket.send(data);
      } catch {
        // the viewer left
      }
    }
  }

  // --- errors ---

  private reason(error: unknown): { code: string; message: string; hint: string } {
    if (error instanceof BrowserUnavailableError) return error;
    if (error instanceof RunnerRequestError) {
      if (error.code === 'browsers_busy') {
        return { code: 'browser_busy', message: error.message, hint: 'Try again in a few minutes.' };
      }
      if (error.code === 'identity_in_use') {
        return { code: 'identity_busy', message: error.message, hint: 'Try again later.' };
      }
      return {
        code: 'browser_unavailable',
        message: `The browser could not start: ${error.message}`,
        hint: 'Carry on without the browser and say so in your report.',
      };
    }
    this.deps.logger.warn('A browser could not be opened', { error });
    return {
      code: 'browser_unavailable',
      message: `The browser could not start: ${(error as Error)?.message ?? String(error)}`,
      hint: 'Try once more, then carry on without the browser.',
    };
  }

  private asApiError(error: unknown): unknown {
    if (error instanceof ApiError) return error;
    const reason = this.reason(error);
    const status = reason.code === 'identity_busy' ? 409 : 503;
    return new ApiError(status, reason.code, reason.message);
  }
}
