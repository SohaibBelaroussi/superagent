import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraServer } from '@mastra/hono';
import { scripted } from '../mock.ts';

describe('deterministic agent', () => {
  it('runs a scripted tool call then answers', async () => {
    const seen: string[] = [];
    const tool = createTool({ id: 'createTask', description: 'c', inputSchema: z.object({ title: z.string() }), execute: async ({ title }) => { seen.push(title); return { id: 't1' }; } });
    const agent = new Agent({ id: 'w', name: 'W', instructions: 'x', tools: { createTask: tool }, model: scripted([{ toolCall: { name: 'createTask', input: { title: 'Spec' } } }, { text: 'done' }]) });
    const r = await agent.generate('go');
    expect(r.text).toBe('done');
    expect(seen).toEqual(['Spec']);
  });
  it('serves routes in-process via app.request', async () => {
    const mastra = new Mastra({ logger: false as any, agents: { w: new Agent({ id: 'w', name: 'W', instructions: 'x', model: scripted([{ text: 'x' }]) }) } });
    const app = new Hono();
    await new MastraServer({ app, mastra }).init();
    app.get('/healthz', c => c.json({ ok: true }));
    expect((await app.request('/healthz')).status).toBe(200);
    expect(Object.keys(await (await app.request('/api/agents')).json())).toEqual(['w']);
  });
});
