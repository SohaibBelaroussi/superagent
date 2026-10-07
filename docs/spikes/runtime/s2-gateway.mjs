// Spike 2: DB-backed custom gateway, runtime-added providers, cache staleness, includeUsage.
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { MastraModelGateway } from '@mastra/core/llm';
import { LibSQLStore } from '@mastra/libsql';
import { createOpenAICompatible as createV6 } from '@ai-sdk/openai-compatible-v6';
import { createOpenAICompatible as createV7 } from '@ai-sdk/openai-compatible';
import { startFakeServer } from './fake-openai.mjs';

const a = await startFakeServer();
const b = await startFakeServer();
// pretend DB rows (would be decrypted from Postgres)
const db = new Map([['local', { baseURL: a.url, apiKey: 'key-A', models: ['Qwen/Qwen3-8B'] }]]);
const seen = [];

class DbGateway extends MastraModelGateway {
  id = 'sa';
  name = 'Superagent providers';
  handlesModel(routerId) { return db.has(routerId.split('/')[0]); }      // sync: needs in-memory slug cache
  async fetchProviders() {
    return Object.fromEntries([...db].map(([slug, p]) => [slug, { name: slug, models: p.models, apiKeyEnvVar: [], gateway: this.id, url: p.baseURL }]));
  }
  buildUrl(routerId) { return db.get(routerId.split('/').at(-2))?.baseURL; }
  async resolveAuth({ providerId }) { const p = db.get(providerId); return p ? { apiKey: p.apiKey, source: 'gateway' } : undefined; }
  async getApiKey() { return ''; }
  async resolveLanguageModel({ modelId, providerId, apiKey, headers }) {
    const p = db.get(providerId);
    if (!p) throw new Error(`unknown provider ${providerId}`);
    seen.push({ providerId, modelId, apiKey });
    return createV6({ name: providerId, baseURL: p.baseURL, apiKey, headers, includeUsage: true }).chatModel(modelId);
  }
}

const mastra = new Mastra({ storage: new LibSQLStore({ id: 'st', url: ':memory:' }), logger: false, gateways: { sa: new DbGateway() } });
const agent = new Agent({ id: 'g', name: 'g', instructions: 'GW', model: 'sa/local/Qwen/Qwen3-8B' });
mastra.addAgent(agent);

let r = await agent.generate('hi');
console.log('1 prefixed:', r.text.slice(0, 40), JSON.stringify(seen.at(-1)));

// provider added at runtime (no restart)
db.set('late', { baseURL: b.url, apiKey: 'key-B', models: ['m1'] });
r = await agent.generate('hi', { model: 'sa/late/m1' });
console.log('2 runtime-added provider:', r.text.slice(0, 40), JSON.stringify(seen.at(-1)), 'hitB=', b.log.length);

// unprefixed id claimed through handlesModel
const ag2 = new Agent({ id: 'g2', name: 'g2', instructions: 'GW2', model: 'late/m1' });
mastra.addAgent(ag2);
r = await ag2.generate('hi');
console.log('3 unprefixed via handlesModel:', r.text.slice(0, 40), JSON.stringify(seen.at(-1)));

// edit provider: same slug, new URL, same key -> stale cache?
db.set('local', { baseURL: b.url, apiKey: 'key-A', models: ['Qwen/Qwen3-8B'] });
const bBefore = b.log.length;
r = await agent.generate('after edit');
console.log('4 after URL edit (same key) request went to B?', b.log.length > bBefore);

// streaming usage with includeUsage via gateway
const s = await agent.stream('stream usage');
const usage = await s.usage;
console.log('5 stream usage via gateway(includeUsage):', JSON.stringify({ in: usage.inputTokens, out: usage.outputTokens }), 'stream_options sent:', JSON.stringify(b.log.at(-1).body.stream_options));

// AI SDK v7 provider instance passed directly (spec version?)
const v7 = createV7({ name: 'local', baseURL: a.url, apiKey: 'k', includeUsage: true });
console.log('6 v7 chat specificationVersion:', v7.chatModel('x').specificationVersion, 'embedding:', v7.embeddingModel('e').specificationVersion);
const v6 = createV6({ name: 'local', baseURL: a.url, apiKey: 'k' });
console.log('  v6 chat specificationVersion:', v6.chatModel('x').specificationVersion, 'embedding:', v6.embeddingModel('e').specificationVersion);
const ag3 = new Agent({ id: 'g3', name: 'g3', instructions: 'V7', model: v7.chatModel('direct-v7') });
mastra.addAgent(ag3);
r = await ag3.generate('v7 direct');
console.log('7 direct v7 instance works:', r.text.slice(0, 50));

// dynamic function form returning gateway string from requestContext
const ag4 = new Agent({ id: 'g4', name: 'g4', instructions: 'DYN', model: ({ requestContext }) => requestContext.get('model') ?? 'sa/local/Qwen/Qwen3-8B' });
mastra.addAgent(ag4);
r = await ag4.generate('dyn');
console.log('8 dynamic model fn:', r.text.slice(0, 40));

// fallback array: first provider fails (unknown), second works
const ag5 = new Agent({ id: 'g5', name: 'g5', instructions: 'FB', model: [{ model: 'sa/missing/x', maxRetries: 0 }, { model: 'sa/late/m1', maxRetries: 0 }] });
mastra.addAgent(ag5);
try { r = await ag5.generate('fallback'); console.log('9 fallback array:', r.text.slice(0, 40)); } catch (e) { console.log('9 fallback error:', e.message); }
a.close(); b.close(); process.exit(0);
