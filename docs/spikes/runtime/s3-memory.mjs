// Spike 3: one shared Memory across agents; embedders from an OpenAI-compatible endpoint.
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { createOpenAICompatible as createV6 } from '@ai-sdk/openai-compatible-v6';
import { createOpenAICompatible as createV7 } from '@ai-sdk/openai-compatible';
import { startFakeServer } from './fake-openai.mjs';

const srv = await startFakeServer();
const tryCtor = (label, fn) => { try { const e = fn(); console.log(label, 'OK', e.specificationVersion, e.provider, e.modelId); return e; } catch (err) { console.log(label, 'THROWS:', err.message.split('\n')[0]); } };

// embedder shapes
tryCtor('E1 string "local/nomic"           ', () => new ModelRouterEmbeddingModel('local/nomic'));
tryCtor('E2 {id:"local/nomic-ai/x", url}    ', () => new ModelRouterEmbeddingModel({ id: 'local/nomic-ai/nomic-embed-text-v1.5', url: srv.url }));
const e3 = tryCtor('E3 {providerId, modelId:"a/b", url}', () => new ModelRouterEmbeddingModel({ providerId: 'local', modelId: 'nomic-ai/nomic-embed-text-v1.5', url: srv.url, apiKey: 'k' }));

let storage;
let vector;

async function trial(label, embedder) {
  storage = new LibSQLStore({ id: 'st'+label.slice(0,2), url: ':memory:' }); vector = new LibSQLVector({ id: 'vec'+label.slice(0,2), url: ':memory:' });
  try {
    const memory = new Memory({
      id: 'shared-memory',
      vector,
      embedder,
      options: {
        lastMessages: 10,
        semanticRecall: { topK: 2, messageRange: 1, scope: 'resource' },
        workingMemory: { enabled: true, scope: 'resource', template: '# User\n- Name:\n' },
        generateTitle: false,
      },
    });
    const mastra = new Mastra({ storage, logger: false, memory: { shared: memory } });
    const mk = (id) => new Agent({ id, name: id, instructions: id.toUpperCase(), model: { providerId: 'local', modelId: `${id}-model`, url: srv.url }, memory: ({ mastra: m }) => m.getMemory('shared') });
    const a1 = mk('agent-a'), a2 = mk('agent-b');
    mastra.addAgent(a1); mastra.addAgent(a2);
    const embBefore = srv.log.filter(e => e.url.endsWith('/embeddings')).length;
    await a1.generate('my favourite colour is teal', { memory: { thread: `t-a-${label}`, resource: `user1:agent-a` } });
    await a2.generate('remember the ocean', { memory: { thread: `t-b-${label}`, resource: `user1:agent-b` } });
    await a1.generate('what colour did I say?', { memory: { thread: `t-a-${label}`, resource: `user1:agent-a` } });
    const m = await a1.getMemory();
    const threadsA = await m.listThreads({ filter: { resourceId: 'user1:agent-a' } }).catch(e => ({ err: e.message }));
    const msgs = await m.recall({ threadId: `t-a-${label}`, resourceId: 'user1:agent-a' }).catch(e => ({ err: e.message }));
    await memory.settled?.(); await new Promise(r=>setTimeout(r,300));
    const embCalls = srv.log.filter(e => e.url.endsWith('/embeddings')).length - embBefore;
    console.log(label, 'OK: embeddings calls=', embCalls, 'threadsA=', threadsA.threads?.length ?? JSON.stringify(threadsA).slice(0, 80), 'msgs in t-a=', msgs.messages?.length ?? JSON.stringify(msgs).slice(0, 120));
    const lastA = srv.log.filter(e => e.body?.model === 'agent-a-model').at(-1).body;
    console.log('   tools offered to agent-a:', (lastA.tools || []).map(t => t.function.name), ' system msgs:', lastA.messages.filter(x => x.role === 'system').length);
    await memory.settled?.();
  } catch (err) {
    console.log(label, 'FAILED:', err.message.split('\n')[0], err.cause?.message ?? '');
  }
}

await trial('M1 ModelRouterEmbeddingModel{providerId,modelId,url}', e3);
await trial('M2 @ai-sdk/openai-compatible@2 (v3) embeddingModel', createV6({ name: 'local', baseURL: srv.url, apiKey: 'k' }).embeddingModel('nomic-embed'));
await trial('M3 @ai-sdk/openai-compatible@3 (v4) embeddingModel', createV7({ name: 'local', baseURL: srv.url, apiKey: 'k' }).embeddingModel('nomic-embed'));
srv.close(); process.exit(0);
