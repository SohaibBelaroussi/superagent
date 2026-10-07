import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { scripted } from './mock.ts';

const log = (l: string, v: unknown) => console.log(l.padEnd(56), JSON.stringify(v));
const hooks: string[] = [];
const lead = new Agent({ id: 'lead', name: 'Lead', instructions: 'x', memory: new Memory(), model: scripted(Array.from({ length: 6 }, (_, i) => ({ text: `r${i}` }))) });
const mastra = new Mastra({
  agents: { lead },
  storage: new LibSQLStore({ id: 's', url: ':memory:' }),
  logger: false as any,
  schedules: { onFinish: ({ outcome }) => { hooks.push(`finish:${outcome}`); }, onError: ({ phase, error }) => { hooks.push(`error:${phase}:${error.message.slice(0, 80)}`); } },
});
const mem = await lead.getMemory();

// sendMessage to a thread that does not exist yet
const res = lead.sendMessage('hello new thread', { resourceId: 'owner', threadId: 'fresh_1' });
const acc = await res.accepted;
const text = acc.action === 'wake' ? await acc.output.text : undefined;
const t = await mem!.getThreadById({ threadId: 'fresh_1' });
log('sendMessage on missing thread', { action: acc.action, text, threadCreated: !!t, resourceId: t?.resourceId, metadata: t?.metadata });

// schedule firing into a missing thread
await mastra.startWorkers();
const s = await mastra.schedules.create({ agentId: 'lead', cron: '0 9 * * *', prompt: 'tick', threadId: 'missing_thread', resourceId: 'owner' });
await mastra.schedules.run(s.id);
await new Promise(r => setTimeout(r, 2500));
const t2 = await mem!.getThreadById({ threadId: 'missing_thread' });
log('schedule.run on missing thread', { hooks, threadCreated: !!t2 });

// schedule without threadId
const s2 = await mastra.schedules.create({ agentId: 'lead', cron: '0 9 * * *', prompt: 'tick2' });
await mastra.schedules.run(s2.id);
await new Promise(r => setTimeout(r, 2500));
log('schedule.run without threadId', { hooks });
await mastra.shutdown({ drainTimeout: 300 });
process.exit(0);
