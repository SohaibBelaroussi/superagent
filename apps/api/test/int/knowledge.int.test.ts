import type {
  Department,
  KnowledgeDocument,
  KnowledgeDocumentList,
  KnowledgeSearchResult,
  Provider,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { MemoryBlobStore } from '../../src/modules/knowledge/blobs';
import { type FakeOpenAI, type RecordedRequest, startFakeOpenAI } from '../support/fake-openai';
import { authHeader, jsonHeaders, startTestSystem } from './helpers';

type ChatMessage = { role: string; content: unknown };
const systemPrompt = (r: RecordedRequest) =>
  ((r.body?.messages as ChatMessage[] | undefined) ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');

const RETENTION = '# Data retention\n\nCustomer records are kept for ninety days, then deleted for good.';

describe('knowledge', () => {
  let system: System;
  let fake: FakeOpenAI;
  const blobs = new MemoryBlobStore();
  let legal: Department;
  let sales: Department;

  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const upload = (file: File, fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.append('file', file);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return system.app.request('/v1/knowledge', { method: 'POST', headers: authHeader(), body: form });
  };
  const search = async (q: string, departmentId?: string) =>
    (
      (await (
        await send(
          'GET',
          `/v1/knowledge/search?q=${encodeURIComponent(q)}${departmentId ? `&departmentId=${departmentId}` : ''}`,
        )
      ).json()) as KnowledgeSearchResult
    ).items;

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat']);
    system = await startTestSystem({ blobs });
    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    const department = async (slug: string, name: string) =>
      (await (await send('POST', '/v1/departments', { slug, name })).json()) as Department;
    legal = await department('legal', 'Legal');
    sales = await department('sales', 'Sales');
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
  });

  it('stores an upload, indexes its passages and finds them', async () => {
    const res = await upload(new File([RETENTION], 'retention.md', { type: 'text/markdown' }), {
      title: 'Retention policy',
    });
    expect(res.status).toBe(201);
    const document = (await res.json()) as KnowledgeDocument;
    expect(document).toMatchObject({
      title: 'Retention policy',
      filename: 'retention.md',
      contentType: 'text/markdown',
      size: new TextEncoder().encode(RETENTION).byteLength,
      departmentId: null,
      chunkCount: 1,
    });
    expect([...blobs.objects.keys()].some((key) => key.includes(document.id))).toBe(true);

    const hits = await search('How long are customer records kept?');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ documentId: document.id, title: 'Retention policy', passage: 0 });
    expect(hits[0]?.content).toContain('ninety days');
    expect(await search('unrelated banana')).toEqual([]);
  });

  it("keeps a department's documents to that department, and shares the rest", async () => {
    const res = await upload(new File(['Discount rules: never exceed fifteen percent.'], 'discounts.txt'), {
      departmentId: sales.id,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as KnowledgeDocument).departmentId).toBe(sales.id);

    expect((await search('discount percent', sales.id)).map((h) => h.title)).toEqual(['discounts.txt']);
    expect(await search('discount percent', legal.id)).toEqual([]);
    // Shared documents are searched from every department.
    expect((await search('customer records', legal.id)).map((h) => h.title)).toEqual(['Retention policy']);

    const listed = (await (
      await send('GET', `/v1/knowledge?departmentId=${sales.id}`)
    ).json()) as KnowledgeDocumentList;
    expect(listed.items.map((d) => d.filename)).toEqual(['discounts.txt']);
  });

  it('refuses documents it cannot read', async () => {
    const binary = await upload(
      new File([new Uint8Array([0, 1, 2])], 'tool.exe', { type: 'application/octet-stream' }),
    );
    expect(binary.status).toBe(415);
    expect(await binary.json()).toMatchObject({ code: 'unsupported_document' });

    const empty = await upload(new File(['   \n\n  '], 'empty.txt', { type: 'text/plain' }));
    expect(empty.status).toBe(422);
    expect(await empty.json()).toMatchObject({ code: 'empty_document' });

    const unknownDepartment = await upload(new File(['text'], 'a.txt'), {
      departmentId: '01900000-0000-7000-8000-000000000000',
    });
    expect(unknownDepartment.status).toBe(404);

    const noFile = await system.app.request('/v1/knowledge', {
      method: 'POST',
      headers: authHeader(),
      body: new FormData(),
    });
    expect(noFile.status).toBe(400);
  });

  it('accepts uploads above the general body limit, up to 20 MiB', async () => {
    const paragraph = 'Large manuals mention the warranty period of two years. '.repeat(18);
    const big = Array.from({ length: 5200 }, () => paragraph).join('\n\n'); // about 5 MiB
    expect(big.length).toBeGreaterThan(4 * 1024 * 1024);
    const res = await upload(new File([big], 'manual.txt', { type: 'text/plain' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as KnowledgeDocument).chunkCount).toBeGreaterThan(100);

    const tooBig = await upload(new File([new Uint8Array(21 * 1024 * 1024)], 'huge.txt'));
    expect(tooBig.status).toBe(413);
  });

  it('lets a specialist find a document with knowledge_search', async () => {
    await send('POST', '/v1/agents', {
      key: 'legal-lead',
      name: 'Legal lead',
      role: 'lead',
      departmentId: legal.id,
      description: 'Answers legal questions.',
      instructions: 'Be precise.',
    });
    await send('POST', '/v1/agents', {
      key: 'policy-reader',
      name: 'Policy reader',
      role: 'specialist',
      departmentId: legal.id,
      description: 'Looks things up in the documents.',
      instructions: 'Quote the document.',
      tools: [{ key: 'knowledge_search' }],
    });
    const mark = fake.requests.length;
    const res = await send('POST', '/api/agents/legal-lead/generate', {
      messages: [{ role: 'user', content: 'How long do we keep customer records?' }],
    });
    expect(res.status).toBe(200);

    const specialistCalls = fake.requests
      .slice(mark)
      .filter((r) => r.path === '/chat/completions' && systemPrompt(r).includes('specialist in the Legal'));
    const toolResult = JSON.stringify(specialistCalls.at(-1)?.body?.messages);
    expect(toolResult).toContain('ninety days');
    expect(toolResult).toContain('Retention policy');
  });

  it('gets and deletes documents', async () => {
    const all = (await (await send('GET', '/v1/knowledge')).json()) as KnowledgeDocumentList;
    const retention = all.items.find((d) => d.title === 'Retention policy');
    expect(retention).toBeDefined();
    const one = await send('GET', `/v1/knowledge/${retention?.id}`);
    expect(((await one.json()) as KnowledgeDocument).filename).toBe('retention.md');

    const removed = await send('DELETE', `/v1/knowledge/${retention?.id}`);
    expect(removed.status).toBe(204);
    expect([...blobs.objects.keys()].some((key) => key.includes(retention?.id ?? ''))).toBe(false);
    expect(await search('customer records')).toEqual([]);
    expect((await send('GET', `/v1/knowledge/${retention?.id}`)).status).toBe(404);
  });
});
