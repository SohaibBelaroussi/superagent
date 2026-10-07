// Spike 1: runtime registry, replace semantics, dynamic `agents` resolution, call counts.
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLStore } from '@mastra/libsql';
import { startFakeServer } from './fake-openai.mjs';

const srv = await startFakeServer();
const model = (modelId) => ({ providerId: 'local', modelId, url: srv.url, apiKey: 'k' });
const mastra = new Mastra({ storage: new LibSQLStore({ id: 'st', url: ':memory:' }), logger: false });

const calls = {};
const count = (k) => (calls[k] = (calls[k] ?? 0) + 1);

const mkSpec = (v) => new Agent({ id: 'spec-research', name: 'Research', description: `research specialist ${v}`, instructions: `SPEC-${v}`, model: model('spec-model') });
const spec1 = mkSpec('V1');
mastra.addAgent(spec1);

let agentsArgKeys;
const lead = new Agent({
  id: 'lead-ops', name: 'Ops Lead',
  instructions: ({ requestContext, mastra: m }) => { count('instructions'); return `LEAD (mastra passed: ${!!m})`; },
  model: ({ requestContext }) => { count('model'); return model('lead-model'); },
  tools: ({ requestContext }) => { count('tools'); return {}; },
  agents: (args) => { count('agents'); agentsArgKeys = Object.keys(args); return { research: mastra.getAgentById('spec-research') }; },
});
const staticLead = new Agent({ id: 'lead-static', name: 'Static Lead', instructions: 'STATIC-LEAD', model: model('lead-model'), agents: { research: spec1 } });

const before = { ...calls };
mastra.addAgent(lead);
mastra.addAgent(staticLead);
await new Promise(r => setTimeout(r, 50));
console.log('dynamic fn calls triggered by addAgent():', JSON.stringify(Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, v - (before[k] ?? 0)]))));
console.log('agents resolver received args keys:', agentsArgKeys);

for (const k of Object.keys(calls)) calls[k] = 0;
const r1 = await mastra.getAgentById('lead-ops').generate('do it', { requestContext: new RequestContext([['userId', 'u1']]) });
console.log('R1 text:', r1.text);
console.log('dynamic fn calls during one generate() with 1 delegation (2 lead LLM steps):', JSON.stringify(calls));
console.log('tool names sent to LLM on first lead step:', srv.log.find(e => e.body?.model === 'lead-model')?.body.tools?.map(t => t.function.name));
console.log('subagent tool description:', srv.log.find(e => e.body?.model === 'lead-model')?.body.tools?.[0]?.function.description);

// Attempt replace with addAgent on same key
const spec2 = mkSpec('V2');
mastra.addAgent(spec2);
console.log('addAgent(same id) replaced?', mastra.getAgentById('spec-research') === spec2, '(silent no-op if false)');

// Proper replace: remove + add synchronously
console.log('removeAgent ->', mastra.removeAgent('spec-research'));
mastra.addAgent(spec2);
console.log('after remove+add, registry has V2?', mastra.getAgentById('spec-research') === spec2);
const r2 = await lead.generate('do it again');
console.log('R2 (dynamic lead) text:', r2.text);
const r3 = await staticLead.generate('do it static');
console.log('R3 (static lead, captured instance) text:', r3.text);
console.log('listAgents keys:', Object.keys(mastra.listAgents()));
console.log('usage r1:', JSON.stringify(r1.usage));
srv.close();
process.exit(0);
