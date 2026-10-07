import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { scripted } from './mock.ts';

const log = (label: string, v: unknown) => console.log(label.padEnd(52), typeof v === 'string' ? v : JSON.stringify(v));
const withTimeout = <T>(p: Promise<T>, ms = 8000, label = 'op') =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);
async function step(label: string, fn: () => Promise<unknown>) {
  try {
    log(label, await withTimeout(Promise.resolve().then(fn), 10000, label));
  } catch (e: any) {
    log(label, `ERROR ${e?.message?.slice(0, 200)}`);
  }
}

const calls: string[] = [];
const createTask = createTool({
  id: 'createTask',
  description: 'Create a task',
  inputSchema: z.object({ title: z.string() }),
  execute: async ({ title }) => {
    calls.push(title);
    return { id: 'task_1' };
  },
});
const deploy = createTool({
  id: 'deploy',
  description: 'Deploy',
  inputSchema: z.object({ env: z.string() }),
  requireApproval: true,
  execute: async ({ env }) => ({ deployed: env }),
});

const memory = new Memory();
const worker = new Agent({
  id: 'worker',
  name: 'Worker',
  instructions: 'x',
  tools: { createTask },
  model: scripted([{ toolCall: { name: 'createTask', input: { title: 'Write spec' } } }, { text: 'Created task_1' }]),
});
const lead = new Agent({
  id: 'lead',
  name: 'Lead',
  instructions: 'x',
  memory,
  model: scripted(Array.from({ length: 10 }, (_, i) => ({ text: `lead reply ${i}` }))),
});
const approver = new Agent({
  id: 'approver',
  name: 'Approver',
  instructions: 'x',
  memory,
  tools: { deploy },
  model: scripted([{ toolCall: { name: 'deploy', input: { env: 'prod' } } }, { text: 'Deployed to prod' }]),
});

const hookEvents: string[] = [];
const mastra = new Mastra({
  agents: { worker, lead, approver },
  storage: new LibSQLStore({ id: 'spike', url: ':memory:' }),
  logger: false as any,
  backgroundTasks: { enabled: true },
  schedules: {
    onFinish: async ({ agentId, outcome, trigger }) => {
      hookEvents.push(`onFinish:${agentId}:${outcome}:${trigger.kind}`);
    },
    onError: async ({ agentId, phase, error }) => {
      hookEvents.push(`onError:${agentId}:${phase}:${error.message}`);
    },
  },
});

await step('1 generate: text', async () => {
  const r = await worker.generate('make a task');
  return { text: r.text, finishReason: r.finishReason, toolCalls: calls };
});

const thread = { resourceId: 'owner', threadId: 'task_123' };
await step('2 memory.createThread with metadata', async () => {
  const mem = await lead.getMemory();
  const t = await mem!.createThread({ ...thread, title: 'Task 123', metadata: { taskId: '123', kind: 'task' } });
  const back = await mem!.getThreadById({ threadId: thread.threadId });
  return { id: t.id, metadata: back?.metadata };
});

await step('3 subscribeToThread + sendMessage(wake)', async () => {
  const sub = await lead.subscribeToThread(thread);
  const res = lead.sendMessage({ contents: 'Please handle task 123', attributes: { from: 'chief' } }, thread);
  const acc = await res.accepted;
  const types: string[] = [];
  const reader = (async () => {
    for await (const chunk of sub.stream as AsyncIterable<any>) {
      types.push(chunk.type);
      if (chunk.type === 'finish') break;
    }
  })();
  const text = acc.action === 'wake' ? await acc.output.text : undefined;
  await withTimeout(reader, 3000, 'sub').catch(() => {});
  sub.unsubscribe();
  return { action: acc.action, runId: (acc as any).runId?.slice(0, 8), text, signalId: res.signal.id.slice(0, 12), subChunkTypes: [...new Set(types)].slice(0, 8) };
});

await step('4 queueMessage on idle thread', async () => {
  const res = lead.queueMessage('follow-up', thread);
  const acc = await res.accepted;
  const text = acc.action === 'wake' ? await acc.output.text : undefined;
  return { action: acc.action, text };
});

await step('5 sendNotificationSignal(urgent)', async () => {
  const r = await lead.sendNotificationSignal(
    { source: 'worker', kind: 'task-report', summary: 'Task 123 done', priority: 'urgent', dedupeKey: 'task:123:done' },
    thread,
  );
  const acc = r.accepted ? await r.accepted : undefined;
  const text = acc?.action === 'wake' ? await acc.output.text : undefined;
  return { decision: r.decision.action, recordStatus: r.record.status, accepted: acc?.action, text };
});

await step('6 sendSignal(notification, ifIdle persist)', async () => {
  const r = lead.sendSignal({ type: 'notification', contents: 'CI failed', attributes: { source: 'ci' } }, { ...thread, ifIdle: { behavior: 'persist' } });
  const acc = await r.accepted;
  await r.persisted;
  return { action: acc.action };
});

await step('7 startWorkers', async () => {
  await mastra.startWorkers();
  return mastra.workers.map((w: any) => `${w.name}:${w.isRunning}`).join(',');
});

await step('8 schedules CRUD', async () => {
  const mem = await lead.getMemory();
  await mem!.createThread({ resourceId: 'owner', threadId: 'dept_eng', title: 'Eng dept' });
  const s = await mastra.schedules.create({ id: 'standup', agentId: 'lead', name: 'standup', cron: '0 9 * * 1-5', timezone: 'Europe/Paris', prompt: 'Daily standup', threadId: 'dept_eng', resourceId: 'owner', ifIdle: { behavior: 'wake' } });
  const listed = await mastra.schedules.list({ agentId: 'lead' });
  const paused = await mastra.schedules.pause(s.id);
  const resumed = await mastra.schedules.resume(s.id);
  const updated = await mastra.schedules.update(s.id, { cron: '0 10 * * 1-5' });
  const ran = await mastra.schedules.run(s.id);
  await new Promise(r => setTimeout(r, 2500));
  const after = await mastra.schedules.get(s.id);
  return { id: s.id, status: s.status, nextFireAt: new Date(s.nextFireAt).toISOString(), listed: listed.length, paused: paused.status, resumed: resumed.status, cron: (updated as any).cron, ran: Object.keys(ran), lastRunId: !!after?.lastRunId, hooks: hookEvents };
});

await step('9 approval: generate -> suspended', async () => {
  const out = await approver.generate('deploy prod', { memory: { thread: 'appr_1', resource: 'owner' } });
  return { finishReason: out.finishReason, runId: out.runId?.slice(0, 8), suspendPayload: out.suspendPayload ? Object.keys(out.suspendPayload) : null };
});

await step('10 listSuspendedRuns + approveToolCall', async () => {
  const { runs, total } = await approver.listSuspendedRuns({ resourceId: 'owner' });
  if (!runs[0]) return { total };
  const s = await approver.approveToolCall({ runId: runs[0].runId, memory: { thread: 'appr_1', resource: 'owner' } } as any);
  const text = await s.text;
  const after = await approver.listSuspendedRuns({ resourceId: 'owner' });
  return { total, threadId: runs[0].threadId, toolCalls: runs[0].toolCalls.map(t => `${t.toolName}:${t.requiresApproval}`), text, remaining: after.total };
});

await step('11 pubsub custom topic', async () => {
  const got: any[] = [];
  const cb = async (ev: any) => { got.push({ type: ev.type, data: ev.data, runId: ev.runId, hasId: !!ev.id }); };
  await mastra.pubsub.subscribe('board:b1', cb);
  await mastra.pubsub.publish('board:b1', { type: 'task.updated', data: { taskId: 't1', status: 'done' }, runId: 'b1' });
  await new Promise(r => setTimeout(r, 100));
  await mastra.pubsub.unsubscribe('board:b1', cb);
  return got;
});

await step('12 backgroundTaskManager', async () => {
  const m = mastra.backgroundTaskManager;
  if (!m) return 'undefined';
  const l = await m.listTasks({ perPage: 5, page: 0 });
  const st = m.stream({ includeExisting: true, abortSignal: AbortSignal.timeout(200) });
  return { listTasks: l.total, streamIsReadable: st instanceof ReadableStream };
});

await mastra.shutdown({ drainTimeout: 500 });
process.exit(0);
