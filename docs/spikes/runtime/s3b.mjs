import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { createOpenAICompatible as createV6 } from '@ai-sdk/openai-compatible-v6';
import { createOpenAICompatible as createV7 } from '@ai-sdk/openai-compatible';
import { startFakeServer } from './fake-openai.mjs';
const srv = await startFakeServer();
const embedders = {
  router: new ModelRouterEmbeddingModel({ providerId: 'local', modelId: 'nomic-ai/nomic-embed-text-v1.5', url: srv.url, apiKey: 'k' }),
  v6: createV6({ name: 'local', baseURL: srv.url, apiKey: 'k' }).embeddingModel('nomic-embed'),
  v7: createV7({ name: 'local', baseURL: srv.url, apiKey: 'k' }).embeddingModel('nomic-embed'),
};
for (const [k, e] of Object.entries(embedders)) {
  const memory = new Memory({ storage: new LibSQLStore({ id: 's'+k, url: ':memory:' }), vector: new LibSQLVector({ id: 'v'+k, url: ':memory:' }), embedder: e, options: { semanticRecall: { topK: 2, messageRange: 1 } } });
  try {
    const before = srv.log.length;
    const r = await memory.embedMessageContent('hello world ' + k);
    const dim = await memory.getEmbeddingDimension();
    console.log(k, 'spec', e.specificationVersion, 'embedMessageContent OK dims=', r.embeddings[0]?.length, 'probeDim=', dim, 'http calls=', srv.log.length - before);
  } catch (err) { console.log(k, 'spec', e.specificationVersion, 'FAILED:', err.message.split('\n')[0]); }
  try {
    await memory.saveThread({ thread: { id: 't'+k, resourceId: 'r', title: 'x', createdAt: new Date(), updatedAt: new Date() } });
    const before = srv.log.length;
    await memory.saveMessages({ messages: [{ id: 'm1'+k, threadId: 't'+k, resourceId: 'r', role: 'user', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text: 'the sky is blue ' + k }] } }] });
    console.log('   saveMessages OK, embedding http calls=', srv.log.length - before);
    const rec = await memory.recall({ threadId: 't'+k, resourceId: 'r', vectorSearchString: 'sky colour' });
    console.log('   recall with vectorSearchString OK, messages=', rec.messages.length);
  } catch (err) { console.log('   save/recall FAILED:', err.message.split('\n')[0]); }
}
srv.close(); process.exit(0);
