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

type ChatMessage = { role: string; content: unknown };
type ToolDef = { function: { name: string } };

export async function startFakeOpenAI(models = ['fake-chat', 'fake-embed']): Promise<FakeOpenAI> {
  const requests: RecordedRequest[] = [];
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
      if (tools.length > 0 && !toolResult) {
        // Behave like a cooperative model: delegate first, then search, then use any other tool.
        const tool =
          tools.find((t) => t.startsWith('agent-')) ??
          tools.find((t) => t === 'web_search') ??
          tools.find((t) => t !== 'current_time') ??
          (tools[0] as string);
        const args = tool.startsWith('agent-')
          ? { prompt: 'Find out what Mastra is and return two sources.' }
          : tool === 'web_search'
            ? { query: 'mastra agent framework' }
            : tool === 'fetch_page'
              ? { url: 'https://example.com/' }
              : {};
        delta = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        };
        finish = 'tool_calls';
      } else {
        const text = toolResult
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
