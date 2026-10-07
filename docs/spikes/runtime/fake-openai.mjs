// Minimal fake OpenAI-compatible server (no real LLM). Records every request body.
import http from 'node:http';

export async function startFakeServer() {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    log.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'Qwen/Qwen3-8B', object: 'model' }, { id: 'nomic-embed', object: 'model' }] }));
    }
    if (req.url.endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list', model: body.model,
        data: inputs.map((s, i) => ({ object: 'embedding', index: i, embedding: Array.from({ length: 8 }, (_, k) => ((s.length * (k + 1)) % 7) / 7 + 0.01) })),
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }));
    }
    if (req.url.endsWith('/chat/completions')) {
      const msgs = body.messages || [];
      const sys = msgs.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' | ');
      const hasToolResult = msgs.some(m => m.role === 'tool');
      const tools = (body.tools || []).map(t => t.function.name);
      const wantTool = (body.model.startsWith('lead') || body.model.startsWith('tooluser')) && !hasToolResult && tools.length;
      const target = tools.find(t => t.startsWith('agent-')) || tools.find(t => !t.startsWith('updateWorkingMemory')) || tools[0];
      const chunks = [];
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model };
      if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object') {
        chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ answer: 'structured-ok' }) }, finish_reason: null }] });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else if (wantTool) {
        const args = target.startsWith('agent-') ? { prompt: 'please research X' } : { city: 'Paris' };
        chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: target, arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const lastTool = [...msgs].reverse().find(m => m.role === 'tool');
        const text = `[${body.model}] sys=<${sys.slice(0, 40)}>` + (lastTool ? ` toolResult=<${String(lastTool.content).slice(0, 60)}>` : '');
        chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      if (body.stream_options?.include_usage) chunks.push({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      // non-stream
      const content = chunks.map(c => c.choices[0]?.delta?.content).filter(Boolean).join('');
      const toolCalls = chunks.flatMap(c => c.choices[0]?.delta?.tool_calls || []);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, log, close: () => server.close() };
}
