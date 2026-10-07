// A dependency-free stdio MCP server for tests: JSON-RPC 2.0, one message per line.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [
  {
    name: 'greet',
    description: 'Greets someone, and says where the plugin runs.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'save_note',
    description: "Appends a note to the plugin's data folder.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function call(name, args) {
  if (name === 'greet') {
    const where = `root=${process.env.PLUGIN_ROOT} data=${process.env.PLUGIN_DATA} cwd=${process.cwd()}`;
    const token = process.env.NOTES_TOKEN ? 'token=set' : 'token=unset';
    return `${process.env.NOTES_GREETING ?? 'Hi'}, ${args.name}! ${where} ${token} argv=${process.argv.slice(2).join(' ')}`;
  }
  if (name === 'save_note') {
    appendFileSync(`${process.env.PLUGIN_DATA}/notes.txt`, `${args.text}\n`);
    return 'saved';
  }
  throw new Error(`Unknown tool ${name}`);
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = message;
    if (id === undefined) return;
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'notes', version: '1.2.0' },
          },
        });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools } });
      } else if (method === 'tools/call') {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: call(params.name, params.arguments ?? {}) }] },
        });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} not found` } });
      }
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: String(error.message) }] },
      });
    }
  })
  .on('close', () => process.exit(0));
