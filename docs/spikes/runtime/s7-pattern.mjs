// Spike 7: integrated "definitions in DB -> compiled Agents -> hot swap" pattern.
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { MastraModelGateway } from '@mastra/core/llm';
import { LibSQLStore } from '@mastra/libsql';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible-v6';
import { startFakeServer } from './fake-openai.mjs';

const srv = await startFakeServer();
const providers = new Map([['local', { baseURL: srv.url, apiKey: '' }]]);   // "DB"
const defs = new Map();                                                       // "DB"

class DbGateway extends MastraModelGateway {
  id = 'sa'; name = 'DB providers';
  async fetchProviders() { return Object.fromEntries([...providers].map(([k, p]) => [k, { name: k, models: [], apiKeyEnvVar: [], gateway: 'sa', url: p.baseURL }])); }
  buildUrl(id) { return providers.get(id.split('/')[1])?.baseURL; }
  async getApiKey() { return ''; }
  async resolveAuth({ providerId }) { const p = providers.get(providerId); return p ? { apiKey: p.apiKey || 'none', source: 'gateway' } : undefined; }
  async resolveLanguageModel({ providerId, modelId, apiKey }) {
    const p = providers.get(providerId); if (!p) throw new Error(`no provider ${providerId}`);
    return createOpenAICompatible({ name: providerId, baseURL: p.baseURL, apiKey, includeUsage: true }).chatModel(modelId);
  }
}
const mastra = new Mastra({ storage: new LibSQLStore({ id: 'st', url: ':memory:' }), logger: false, gateways: { sa: new DbGateway() } });

function compile(def) {
  return new Agent({
    id: def.id, name: def.name, description: def.description,
    instructions: def.instructions,
    model: `sa/${def.provider}/${def.model}`,
    agents: def.subagents?.length ? ({ requestContext }) => {        // lazy: resolved per request, closes over mastra
      const out = {};
      for (const ref of defs.get(def.id)?.subagents ?? []) {
        try { out[ref.key] = mastra.getAgentById(ref.agentId); } catch { /* missing specialist: skip */ }
      }
      return out;
    } : undefined,
  });
}
function upsert(def) {
  defs.set(def.id, def);
  const next = compile(def);              // build fully first (async prep would go here)
  mastra.removeAgent(def.id);             // then swap synchronously, no await in between
  mastra.addAgent(next, def.id);
}

upsert({ id: 'lead-ops', name: 'Ops lead', description: 'Ops department lead', instructions: 'OPS-LEAD', provider: 'local', model: 'lead-m', subagents: [{ key: 'research', agentId: 'spec-research' }] });
const chief = new Agent({ id: 'chief', name: 'Chief of staff', instructions: 'CHIEF', model: 'sa/local/plain-m',
  agents: () => ({ ops: mastra.getAgentById('lead-ops') }) });
mastra.addAgent(chief);

let r = await mastra.getAgentById('lead-ops').generate('task 1');
console.log('P1 lead before specialist exists:', r.text.slice(0, 70), '| tools:', JSON.stringify(srv.log.at(-1).body.tools?.map(t => t.function.name) ?? []));
upsert({ id: 'spec-research', name: 'Research', description: 'Research v1', instructions: 'RESEARCH-V1', provider: 'local', model: 'spec-m' });
r = await mastra.getAgentById('lead-ops').generate('task 2');
console.log('P2 after specialist created (lead not rebuilt):', r.text.slice(0, 110));
upsert({ id: 'spec-research', name: 'Research', description: 'Research v2 (edited)', instructions: 'RESEARCH-V2', provider: 'local', model: 'spec-m' });
r = await mastra.getAgentById('lead-ops').generate('task 3');
const leadReq = srv.log.filter(e => e.body?.model === 'lead-m').at(-2).body;
console.log('P3 after specialist edit:', r.text.slice(0, 110), '| tool desc:', leadReq.tools?.[0]?.function.description);
providers.set('local', { baseURL: srv.url, apiKey: 'rotated-key' });
r = await mastra.getAgentById('lead-ops').generate('task 4');
console.log('P4 provider key rotated, auth header now:', srv.log.at(-1).auth);
const s = await chief.stream('hello chief');
console.log('P5 chief stream text:', (await s.text).slice(0, 60), 'usage:', JSON.stringify((await s.usage).totalTokens));
srv.close(); process.exit(0);
