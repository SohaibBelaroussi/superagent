// A minimal OpenAI-compatible server for tests: /models, /chat/completions (plain, streaming with
// usage, tool calls) and /embeddings. Records every request so tests can inspect bodies and auth.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | undefined;
}

export interface FakeOpenAI {
  /** Base URL including /v1. */
  url: string;
  requests: RecordedRequest[];
  /** Models listed by GET /models. */
  models: string[];
  /** How GET /models answers: a normal list, an HTML login page, or an empty list. */
  modelsMode: 'list' | 'html' | 'empty';
  close(): Promise<void>;
}

type ChatMessage = { role: string; content: unknown; tool_calls?: Array<{ function?: { name?: string } }> };
type ToolDef = { function: { name: string } };

/**
 * A cooperative model: in each turn (everything after the last user message) it calls tools in this
 * order, each at most once, then answers. Directives in that user message steer it: "[assign]" lets the
 * chief create a task, "[artifact]" makes a lead attach a deliverable, "[no-report]" makes a lead stop
 * without reporting, "[slow]" delays every answer in the conversation, "[linger]" only the final (text)
 * answers and "[slow-report]" only the answer that calls report_to_chief. "[fixed-ids]" reuses one tool-call id.
 * "[remember]" makes the chief update the owner profile and a lead save a department note; "[schedule]"
 * makes the chief set up a weekday schedule. "[code]" makes a lead pass the directive on when it
 * delegates, and a coder write hello.js in its workspace and run it. "[browse:<url>]" makes a lead pass
 * it on, and an agent with a browser open the page, find the "Load quotes" button in a snapshot, click
 * it and read the page; "[visit:<url>]" just opens and reads the page. The final answer quotes the last
 * tool result (the page).
 * Observational memory's observer and reflector get valid observations back.
 */
const PRIORITY: Array<(tool: string) => boolean> = [
  (t) => t === 'update_owner_profile' || t === 'save_department_note',
  (t) => t === 'create_schedule',
  (t) => t === 'create_task',
  (t) => t === 'update_task',
  (t) => t.startsWith('agent-'),
  (t) => t === CODE.write,
  (t) => t === CODE.run,
  (t) => t === 'web_search',
  (t) => t === 'knowledge_search',
  (t) => t === 'add_artifact',
  (t) => t === 'report_to_chief',
];
const NEVER_AUTOMATIC = new Set([
  'current_time',
  'board_overview',
  'inspect_task',
  'message_task',
  'cancel_task',
  'fetch_page',
  'list_schedules',
  'update_schedule',
  'delete_schedule',
  'run_schedule',
]);
const SLOW_MS = 800;

/** What a "[code]" coder does in its workspace. */
export const CODE = {
  write: 'mastra_workspace_write_file',
  run: 'mastra_workspace_execute_command',
  path: 'hello.js',
  content: 'console.log(6 * 7)\n',
  command: 'node hello.js',
};

function pickTool(tools: string[], messages: ChatMessage[]): string | undefined {
  const turnStart = messages.findLastIndex((m) => m.role === 'user');
  const called = new Set(
    messages
      .slice(turnStart + 1)
      .flatMap((m) =>
        m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.function?.name ?? '') : [],
      ),
  );
  const directives = JSON.stringify(messages[turnStart]?.content ?? '');
  const allowed = (t: string) =>
    !called.has(t) &&
    !NEVER_AUTOMATIC.has(t) &&
    !(t === 'create_task' && !directives.includes('[assign]')) &&
    !(t === 'add_artifact' && !directives.includes('[artifact]')) &&
    !((t === 'update_owner_profile' || t === 'save_department_note') && !directives.includes('[remember]')) &&
    !(t === 'create_schedule' && !directives.includes('[schedule]')) &&
    !(
      t.startsWith('mastra_workspace_') &&
      !(directives.includes('[code]') && (t === CODE.write || t === CODE.run))
    ) &&
    !(t === 'report_to_chief' && directives.includes('[no-report]')) &&
    !t.startsWith('browser_') &&
    // Skills' tools and MCP tools (<slug with a dash>_<tool>) run only when a directive asks.
    !SKILL_TOOLS.has(t) &&
    !/^[a-z0-9]+-[a-z0-9-]*_/.test(t);
  for (const matches of PRIORITY) {
    const tool = tools.find((t) => matches(t) && allowed(t));
    if (tool) return tool;
  }
  return tools.find(allowed);
}

const SKILL_TOOLS = new Set(['skill', 'skill_read', 'skill_search']);
const SKILL = /\[skill:([a-z0-9-]+)\]/;
const MCP = /\[mcp:([A-Za-z0-9_-]+)(?: (\{[^\]]*\}))?\]/;

/**
 * "[skill:<name>]" makes an agent with skills activate it; "[mcp:<tool> {json}]" makes one call the
 * MCP tool whose name ends with _<tool>, with those arguments. Each once per turn, before anything else.
 */
function capabilityStep(
  tools: string[],
  messages: ChatMessage[],
): { tool: string; args: Record<string, unknown> } | undefined {
  const turnStart = messages.findLastIndex((m) => m.role === 'user');
  const content = messages[turnStart]?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part as { text?: string }).text ?? '').join(' ')
        : '';
  const called = new Set(
    messages
      .slice(turnStart + 1)
      .flatMap((m) =>
        m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.function?.name ?? '') : [],
      ),
  );
  const skill = SKILL.exec(text);
  if (skill && tools.includes('skill') && !called.has('skill')) {
    return { tool: 'skill', args: { name: skill[1] } };
  }
  const mcp = MCP.exec(text);
  const target = mcp && tools.find((t) => t.endsWith(`_${mcp[1]}`));
  if (mcp && target && !called.has(target)) {
    return { tool: target, args: mcp[2] ? (JSON.parse(mcp[2]) as Record<string, unknown>) : {} };
  }
  return undefined;
}

/** The button a "[browse:<url>]" agent clicks. */
export const BROWSE_BUTTON = 'Load quotes';
const BROWSE = /\[(browse|visit):([^\]\s"\\]+)\]/;

/** The next browser call of a "[browse:<url>]" or "[visit:<url>]" agent, until it has read the page. */
function browseStep(
  tools: string[],
  messages: ChatMessage[],
): { tool: string; args: Record<string, unknown> } | undefined {
  const turnStart = messages.findLastIndex((m) => m.role === 'user');
  const match = BROWSE.exec(JSON.stringify(messages[turnStart]?.content ?? ''));
  if (!match || !tools.includes('browser_goto')) return undefined;
  const [, mode, url] = match;
  const done = messages
    .slice(turnStart + 1)
    .flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.function?.name ?? '') : []))
    .filter((name) => name.startsWith('browser_')).length;
  const steps = mode === 'visit' ? ['goto', 'read'] : ['goto', 'look', 'click', 'read'];
  const last = String([...messages].reverse().find((m) => m.role === 'tool')?.content ?? '');
  switch (steps[done]) {
    case 'goto':
      return { tool: 'browser_goto', args: { url, waitUntil: 'load' } };
    case 'look':
      return { tool: 'browser_snapshot', args: { interactiveOnly: true } };
    case 'click': {
      // Snapshots name elements by ref ("- button \"Load quotes\" @e3"): the model reads it from there.
      const ref = new RegExp(`${BROWSE_BUTTON}[^@]*?(@e\\d+)`).exec(last)?.[1] ?? '@e0';
      return { tool: 'browser_click', args: { ref } };
    }
    case 'read':
      return { tool: 'browser_snapshot', args: { interactiveOnly: false } };
    default:
      return undefined;
  }
}

/** What a "[remember]" saves: a profile preference (the chief) or a department note (a lead). */
export const REMEMBERED = {
  preference: 'Prefers answers in French',
  note: 'Always cite two sources.',
};

function argsFor(tool: string, directives: string): Record<string, unknown> {
  if (tool.startsWith('agent-')) {
    const browse = BROWSE.exec(directives);
    if (browse) return { prompt: `Use the browser and tell me what the page says. ${browse[0]}` };
    return directives.includes('[code]')
      ? { prompt: 'Write hello.js that prints 6 * 7, run it, and tell me the output. [code]' }
      : { prompt: 'Find out what Mastra is and return two sources.' };
  }
  switch (tool) {
    case CODE.write:
      return { path: CODE.path, content: CODE.content };
    case CODE.run:
      return { command: CODE.command };
    case 'update_owner_profile':
      return { preferences: [REMEMBERED.preference] };
    case 'create_schedule':
      return {
        department: 'research',
        title: 'Weekday digest',
        brief: 'Summarize what changed in Mastra.',
        cron: '0 9 * * 1-5',
      };
    case 'save_department_note':
      return { note: REMEMBERED.note };
    case 'create_task':
      return {
        department: 'research',
        title: 'Research Mastra',
        brief: 'Find out what Mastra is, with sources.',
      };
    case 'update_task':
      return {
        progress: 10,
        checklist: [
          { text: 'Search the web', done: false },
          { text: 'Write the summary', done: false },
        ],
        note: 'Starting',
      };
    case 'web_search':
      return { query: 'mastra agent framework' };
    case 'knowledge_search':
      return { query: 'how long are customer records kept' };
    case 'add_artifact':
      return { title: 'Summary', kind: 'text', content: '# Mastra\n\nA TypeScript agent framework.' };
    case 'report_to_chief':
      return {
        outcome: 'done',
        summary: 'Mastra is a TypeScript agent framework.',
        result: 'Mastra is a TypeScript framework for building agents. Source: https://mastra.ai/docs',
      };
    default:
      return {};
  }
}

/** Observational memory's observer and reflector expect this shape. */
export const OBSERVATIONS =
  '<observations>\nDate: Oct 7, 2026\n* 🔴 (09:00) The owner asked about Mastra; the lead is researching it\n</observations>\n' +
  '<current-task>\nPrimary: answer the latest request\n</current-task>';
const OBSERVATIONS_REFLECTED = '<observations>\n* 🔴 The owner researches Mastra\n</observations>';

/** Listens on 127.0.0.1, on `listenOn` (0: any free port). */
export async function startFakeOpenAI(
  models = ['fake-chat', 'fake-embed'],
  listenOn = 0,
): Promise<FakeOpenAI> {
  const requests: RecordedRequest[] = [];
  // Tool call ids must be unique, like a real provider's: Mastra merges tool calls that share an id.
  let callCounter = 0;
  const state: { models: string[]; modelsMode: FakeOpenAI['modelsMode'] } = { models, modelsMode: 'list' };

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const path = (req.url ?? '').replace(/^\/v1/, '');
    requests.push({
      method: req.method ?? 'GET',
      path,
      authorization: req.headers.authorization,
      headers: { ...req.headers },
      body,
    });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && path === '/models') {
      if (state.modelsMode === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html><body>Please sign in</body></html>');
      }
      const listed = state.modelsMode === 'empty' ? [] : state.models;
      return send(200, { object: 'list', data: listed.map((id) => ({ id, object: 'model' })) });
    }

    if (req.method === 'POST' && path === '/embeddings' && body) {
      const inputs = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
      return send(200, {
        object: 'list',
        model: body.model,
        data: inputs.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: Array.from({ length: 8 }, (_, k) => ((text.length * (k + 1)) % 7) / 7 + 0.01),
        })),
        usage: { prompt_tokens: 3, total_tokens: 3 },
      });
    }

    if (req.method === 'POST' && path === '/chat/completions' && body) {
      const messages = (body.messages as ChatMessage[] | undefined) ?? [];
      const tools = ((body.tools as ToolDef[] | undefined) ?? []).map((t) => t.function.name);
      const toolResult = [...messages].reverse().find((m) => m.role === 'tool');
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: body.model };
      const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

      let delta: Record<string, unknown>;
      let finish: string;
      if (JSON.stringify(messages).includes('[slow]')) await new Promise((r) => setTimeout(r, SLOW_MS));
      const browsing = browseStep(tools, messages) ?? capabilityStep(tools, messages);
      const tool = browsing?.tool ?? pickTool(tools, messages);
      if (tool === 'report_to_chief' && JSON.stringify(messages).includes('[slow-report]')) {
        await new Promise((r) => setTimeout(r, SLOW_MS * 2));
      }
      if (tool) {
        const turn = messages.findLastIndex((m) => m.role === 'user');
        const args = browsing?.args ?? argsFor(tool, JSON.stringify(messages[turn]?.content ?? ''));
        delta = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              // "[fixed-ids]" mimics providers that reuse tool-call ids across conversations.
              id: JSON.stringify(messages).includes('[fixed-ids]') ? 'call_fixed' : `call_${++callCounter}`,
              type: 'function',
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        };
        finish = 'tool_calls';
      } else {
        if (JSON.stringify(messages).includes('[linger]')) await new Promise((r) => setTimeout(r, SLOW_MS));
        const system = messages.find((m) => m.role === 'system')?.content;
        const observing = typeof system === 'string' && system.includes('memory consciousness');
        const text = observing
          ? system.includes('observation reflector')
            ? OBSERVATIONS_REFLECTED
            : OBSERVATIONS
          : toolResult
            ? `The tool said ${String(toolResult.content)}. The magic number is 42.`
            : `pong (${body.model}) ${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 20) : ''}`.trim();
        delta = { role: 'assistant', content: text };
        finish = 'stop';
      }

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
        );
        const options = body.stream_options as { include_usage?: boolean } | undefined;
        if (options?.include_usage) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return send(200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: delta, finish_reason: finish }],
        usage,
      });
    }

    send(404, { error: { message: `no route for ${req.method} ${path}` } });
  });

  await new Promise<void>((resolve) => server.listen(listenOn, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    get models() {
      return state.models;
    },
    set models(next: string[]) {
      state.models = next;
    },
    get modelsMode() {
      return state.modelsMode;
    },
    set modelsMode(next: FakeOpenAI['modelsMode']) {
      state.modelsMode = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
