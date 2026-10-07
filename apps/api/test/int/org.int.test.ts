import type { AgentDefinition, AgentVersion, CatalogTool, Department, Provider } from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { type FakeOpenAI, type RecordedRequest, startFakeOpenAI } from '../support/fake-openai';
import { type FakeWeb, startFakeWeb } from '../support/fake-web';
import { jsonHeaders, startTestSystem } from './helpers';

const WEB_TOKEN = 'crawl-token-for-tests-0123456789';

type ChatMessage = { role: string; content: unknown };
const systemPrompt = (r: RecordedRequest) =>
  ((r.body?.messages as ChatMessage[] | undefined) ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const toolNames = (r: RecordedRequest) =>
  ((r.body?.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name);
const chatRequests = (fake: FakeOpenAI, from = 0) =>
  fake.requests.slice(from).filter((r) => r.path === '/chat/completions');

describe('departments and agents', () => {
  let system: System;
  let fake: FakeOpenAI;
  let web: FakeWeb;
  let department: Department;
  let lead: AgentDefinition;
  let specialist: AgentDefinition;

  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ask = (agentKey: string, content: string) =>
    send('POST', `/api/agents/${agentKey}/generate`, { messages: [{ role: 'user', content }] });

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat']);
    web = await startFakeWeb();
    system = await startTestSystem({
      env: { SEARXNG_URL: web.url, CRAWL4AI_URL: web.url, CRAWL4AI_API_TOKEN: WEB_TOKEN },
    });
    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
    await web?.close();
  });

  it('lists the tool catalog', async () => {
    const { items } = (await (await send('GET', '/v1/catalog/tools')).json()) as { items: CatalogTool[] };
    expect(items.map((t) => `${t.pack}/${t.key}`)).toEqual([
      'core/current_time',
      'web/web_search',
      'web/fetch_page',
      'knowledge/knowledge_search',
      'workspace/files',
      'workspace/shell',
    ]);
  });

  it('creates a department with a lead and a specialist', async () => {
    const created = await send('POST', '/v1/departments', {
      slug: 'research',
      name: 'Research',
      description: 'Finds and summarizes information from the web.',
    });
    expect(created.status).toBe(201);
    department = (await created.json()) as Department;

    const leadRes = await send('POST', '/v1/agents', {
      key: 'research-lead',
      name: 'Research lead',
      role: 'lead',
      departmentId: department.id,
      description: 'Plans research and reviews findings.',
      instructions: 'Keep final answers under five sentences.',
      tools: [{ key: 'current_time' }],
    });
    expect(leadRes.status).toBe(201);
    lead = (await leadRes.json()) as AgentDefinition;
    expect(lead).toMatchObject({
      activeVersion: 1,
      current: { model: null, tools: [{ key: 'current_time', requireApproval: false }] },
    });

    const specialistRes = await send('POST', '/v1/agents', {
      key: 'web-researcher',
      name: 'Web researcher',
      role: 'specialist',
      departmentId: department.id,
      description: 'Searches the web and reads pages.',
      instructions: 'Always list your sources.',
      tools: [{ key: 'web_search' }, { key: 'fetch_page' }],
    });
    expect(specialistRes.status).toBe(201);
    specialist = (await specialistRes.json()) as AgentDefinition;

    const view = (await (await send('GET', `/v1/departments/${department.id}`)).json()) as Department;
    expect(view.lead?.key).toBe('research-lead');
    expect(view.members.map((m) => m.key)).toEqual(['web-researcher']);
  });

  it('rejects invalid definitions', async () => {
    const base = {
      name: 'X',
      role: 'specialist',
      departmentId: department.id,
      description: 'x',
      instructions: 'x',
    };
    const cases: Array<[unknown, number, string]> = [
      [{ ...base, key: 'chief' }, 400, 'reserved_agent_key'],
      [{ ...base, key: 'x-agent', tools: [{ key: 'rm_rf' }] }, 400, 'unknown_tool'],
      [
        { ...base, key: 'x-agent', tools: [{ key: 'web_search' }, { key: 'web_search' }] },
        400,
        'duplicate_tool',
      ],
      [{ ...base, key: 'x-agent', model: { provider: 'nope', model: 'x' } }, 400, 'unknown_provider'],
      [{ ...base, key: 'web-researcher' }, 409, 'agent_key_taken'],
      [{ ...base, key: 'second-lead', role: 'lead' }, 409, 'lead_exists'],
    ];
    for (const [payload, status, code] of cases) {
      const res = await send('POST', '/v1/agents', payload);
      expect(res.status, code).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
  });

  it('runs new agents through Mastra right away', async () => {
    const agents = Object.keys((await (await send('GET', '/api/agents')).json()) as object);
    expect(agents).toEqual(expect.arrayContaining(['chief', 'scratch', 'research-lead', 'web-researcher']));
  });

  it('lets the lead delegate to the specialist, who searches the web', async () => {
    const mark = fake.requests.length;
    const res = await ask('research-lead', 'What is Mastra?');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text.length).toBeGreaterThan(0);

    const calls = chatRequests(fake, mark);
    const leadCall = calls.find((r) => systemPrompt(r).includes('lead of the Research department'));
    expect(leadCall && toolNames(leadCall)).toEqual(
      expect.arrayContaining(['agent-web-researcher', 'current_time']),
    );
    expect(leadCall && systemPrompt(leadCall)).toContain('Keep final answers under five sentences.');

    const specialistCall = calls.find((r) =>
      systemPrompt(r).includes('specialist in the Research department'),
    );
    expect(specialistCall && toolNames(specialistCall)).toEqual(['web_search', 'fetch_page']);
    // The specialist sees the lead's delegation prompt, not the lead's system prompt.
    expect(JSON.stringify(specialistCall?.body?.messages)).not.toContain('lead of the Research department');
    expect(JSON.stringify(specialistCall?.body?.messages)).toContain('Find out what Mastra is');

    expect(web.searches).toContain('mastra agent framework');
  });

  it('applies an edited specialist on the next run, and rolls back', async () => {
    const updated = await send('PATCH', `/v1/agents/${specialist.id}`, {
      instructions: 'Always answer in French.',
    });
    expect(((await updated.json()) as AgentDefinition).activeVersion).toBe(2);

    let mark = fake.requests.length;
    await ask('research-lead', 'What is Mastra?');
    const edited = chatRequests(fake, mark).find((r) =>
      systemPrompt(r).includes('specialist in the Research'),
    );
    expect(edited && systemPrompt(edited)).toContain('Always answer in French.');

    const versions = (await (await send('GET', `/v1/agents/${specialist.id}/versions`)).json()) as {
      items: AgentVersion[];
    };
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);

    const rolledBack = await send('POST', `/v1/agents/${specialist.id}/versions/1/activate`);
    expect(((await rolledBack.json()) as AgentDefinition).current.instructions).toBe(
      'Always list your sources.',
    );
    mark = fake.requests.length;
    await ask('research-lead', 'What is Mastra?');
    const restored = chatRequests(fake, mark).find((r) =>
      systemPrompt(r).includes('specialist in the Research'),
    );
    expect(restored && systemPrompt(restored)).not.toContain('Always answer in French.');
  });

  it('gives the chief of staff a view of the organization', async () => {
    const mark = fake.requests.length;
    expect((await ask('chief', 'Who can research things for me?')).status).toBe(200);
    const chiefCall = chatRequests(fake, mark)[0];
    expect(chiefCall && systemPrompt(chiefCall)).toContain('Research (research)');
    expect(chiefCall && systemPrompt(chiefCall)).toContain('Lead: Research lead');
  });

  it('blocks deleting a provider an agent still uses', async () => {
    const pinned = await send('PATCH', `/v1/agents/${lead.id}`, {
      model: { provider: 'fake', model: 'fake-chat' },
    });
    expect(pinned.status).toBe(200);
    const providers = (await (await send('GET', '/v1/providers')).json()) as { items: Provider[] };
    const blocked = await send('DELETE', `/v1/providers/${providers.items[0]?.id}`);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { detail: string }).detail).toContain('agent "research-lead"');
  });

  it('keeps every write visible when organization writes overlap', async () => {
    const [ops, finance, patched, helper] = await Promise.all([
      send('POST', '/v1/departments', { slug: 'ops', name: 'Operations' }),
      send('POST', '/v1/departments', { slug: 'finance', name: 'Finance' }),
      send('PATCH', `/v1/departments/${department.id}`, { description: 'Finds, checks and summarizes.' }),
      send('POST', '/v1/agents', {
        key: 'fact-checker',
        name: 'Fact checker',
        role: 'specialist',
        departmentId: department.id,
        description: 'Checks claims.',
        instructions: 'Be strict.',
      }),
    ]);
    expect([ops.status, finance.status, patched.status, helper.status]).toEqual([201, 201, 200, 201]);
    expect(((await patched.json()) as Department).description).toBe('Finds, checks and summarizes.');
    expect(Object.keys((await (await send('GET', '/api/agents')).json()) as object)).toContain(
      'fact-checker',
    );

    // An edit racing an archive never brings the agent back.
    const checker = (await helper.json()) as AgentDefinition;
    const [archived, edited] = await Promise.all([
      send('DELETE', `/v1/agents/${checker.id}`),
      send('PATCH', `/v1/agents/${checker.id}`, { instructions: 'Be very strict.' }),
    ]);
    expect(archived.status).toBe(204);
    expect([200, 409]).toContain(edited.status);
    expect(Object.keys((await (await send('GET', '/api/agents')).json()) as object)).not.toContain(
      'fact-checker',
    );

    for (const res of [ops, finance]) {
      expect((await send('DELETE', `/v1/departments/${((await res.json()) as Department).id}`)).status).toBe(
        204,
      );
    }
  });

  it('archives agents and departments', async () => {
    expect((await send('DELETE', `/v1/departments/${department.id}`)).status).toBe(409);

    expect((await send('DELETE', `/v1/agents/${specialist.id}`)).status).toBe(204);
    const agents = Object.keys((await (await send('GET', '/api/agents')).json()) as object);
    expect(agents).not.toContain('web-researcher');

    const mark = fake.requests.length;
    await ask('research-lead', 'Anyone on the team?');
    const leadCall = chatRequests(fake, mark).find((r) => systemPrompt(r).includes('lead of the Research'));
    expect(leadCall && toolNames(leadCall)).not.toContain('agent-web-researcher');
    expect(leadCall && systemPrompt(leadCall)).toContain('no specialists yet');

    expect((await send('DELETE', `/v1/agents/${lead.id}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/departments/${department.id}`)).status).toBe(204);
    const active = (await (await send('GET', '/v1/departments')).json()) as { items: Department[] };
    expect(active.items).toHaveLength(0);
    const all = (await (await send('GET', '/v1/departments?includeArchived=true')).json()) as {
      items: Department[];
    };
    expect(all.items.map((d) => d.slug)).toEqual(['finance', 'ops', 'research']);
  });
});
