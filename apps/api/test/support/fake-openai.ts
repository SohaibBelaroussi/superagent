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
 * makes the chief set up a weekday schedule.
 * Observational memory's observer and reflector get valid observations back.
 */
const PRIORITY: Array<(tool: string) => boolean> = [
  (t) => t === 'update_owner_profile' || t === 'save_department_note',
  (t) => t === 'create_schedule',
  (t) => t === 'create_task',
  (t) => t === 'update_task',
  (t) => t.startsWith('agent-'),
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
    !(t === 'report_to_chief' && directives.includes('[no-report]'));
  for (const matches of PRIORITY) {
    const tool = tools.find((t) => matches(t) && allowed(t));
    if (tool) return tool;
  }
  return tools.find(allowed);
}

/** What a "[remember]" saves: a profile preference (the chief) or a department note (a lead). */
export const REMEMBERED = {
  preference: 'Prefers answers in French',
  note: 'Always cite two sources.',
};

function argsFor(tool: string): Record<string, unknown> {
  if (tool.startsWith('agent-')) return { prompt: 'Find out what Mastra is and return two sources.' };
  switch (tool) {
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

export async function startFakeOpenAI(models = ['fake-chat', 'fake-embed']): Promise<FakeOpenAI> {
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
      const tool = pickTool(tools, messages);
      if (tool === 'report_to_chief' && JSON.stringify(messages).includes('[slow-report]')) {
        await new Promise((r) => setTimeout(r, SLOW_MS * 2));
      }
      if (tool) {
        const args = argsFor(tool);
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
