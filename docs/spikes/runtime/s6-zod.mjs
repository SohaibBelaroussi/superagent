import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { startFakeServer } from './fake-openai.mjs';
const srv = await startFakeServer();
const mastra = new Mastra({ storage: new LibSQLStore({ id: 'st', url: ':memory:' }), logger: false });
const tool = (id, schema) => createTool({ id, description: id, inputSchema: schema, execute: async (i) => ({ ok: true, i }) });
const tools = {
  v4tricky: tool('v4tricky', z.object({ when: z.date().optional(), n: z.string().transform(s => s.length), tags: z.array(z.string()).default([]), nul: z.string().nullable() })),
  v3basic: tool('v3basic', z3.object({ city: z3.string().describe('City'), units: z3.enum(['c', 'f']).optional() })),
};
for (const [name, t] of Object.entries(tools)) {
  const a = new Agent({ id: 'z-' + name, name, instructions: 'Z', model: { providerId: 'local', modelId: 'plain', url: srv.url }, tools: { [name]: t } });
  mastra.addAgent(a);
  try { await a.generate('x'); console.log(name, JSON.stringify(srv.log.at(-1).body.tools?.[0]?.function?.parameters)); }
  catch (e) { console.log(name, 'ERROR', e.message.split('\n')[0]); }
}
// local provider id containing 'openai' triggers OpenAI compat layer?
const a2 = new Agent({ id: 'z-oa', name: 'oa', instructions: 'Z', model: { providerId: 'openai-local', modelId: 'qwen', url: srv.url }, tools: { t: tool('t', z.object({ a: z.string(), b: z.string().optional() })) } });
mastra.addAgent(a2); await a2.generate('x');
console.log('provider "openai-local":', JSON.stringify(srv.log.at(-1).body.tools?.[0]?.function?.parameters));
srv.close(); process.exit(0);
