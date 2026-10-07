// Spike 4: createTool execute context; tools as request-time function; approval survives agent replacement.
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { startFakeServer } from './fake-openai.mjs';

const srv = await startFakeServer();
const mastra = new Mastra({ storage: new LibSQLStore({ id: 'st', url: ':memory:' }), logger: false });
let ctxInfo; let executions = 0;

const makeWeather = (version, requireApproval = false) => createTool({
  id: 'get-weather',
  description: `Get weather (${version})`,
  inputSchema: z.object({ city: z.string().describe('City name'), units: z.enum(['c', 'f']).optional() }),
  outputSchema: z.object({ city: z.string(), tempC: z.number(), version: z.string() }),
  requireApproval,
  execute: async (input, context) => {
    executions++;
    ctxInfo = {
      inputKeys: Object.keys(input),
      contextKeys: Object.keys(context).sort(),
      agentKeys: context.agent ? Object.keys(context.agent).sort() : null,
      threadId: context.agent?.threadId, resourceId: context.agent?.resourceId, toolCallId: context.agent?.toolCallId, agentId: context.agent?.agentId,
      userId: context.requestContext.get('userId'),
      hasWriter: !!context.writer, hasAbort: !!context.abortSignal, hasMastra: !!context.mastra,
    };
    await context.writer?.custom({ type: 'data-progress', data: { pct: 50 } });
    return { city: input.city, tempC: 21, version };
  },
});

const toolsFn = ({ requestContext }) => {
  const v = requestContext.get('toolVersion') ?? 'v1';
  return { getWeather: makeWeather(v, requestContext.get('approve') === true) };
};
const mk = (tag) => new Agent({ id: 'tooluser', name: 'Tool user', instructions: `TOOLS-${tag}`, model: { providerId: 'local', modelId: 'tooluser-model', url: srv.url }, tools: toolsFn });
mastra.addAgent(mk('A'));

const rc = new RequestContext([['userId', 'u-42'], ['toolVersion', 'v7']]);
const r = await mastra.getAgentById('tooluser').generate('weather?', { requestContext: rc, memory: { thread: 'th1', resource: 'u-42' } });
console.log('T1 text:', r.text.slice(0, 120));
console.log('T1 ctx:', JSON.stringify(ctxInfo, null, 0));
const firstReq = srv.log.find(e => e.body?.model === 'tooluser-model').body;
console.log('T1 tool JSON schema sent:', JSON.stringify(firstReq.tools[0].function));

// approval + replace instance before approving
const rc2 = new RequestContext([['userId', 'u-42'], ['approve', true]]);
const before = executions;
const s1 = await mastra.getAgentById('tooluser').generate('weather needing approval', { requestContext: rc2, memory: { thread: 'th2', resource: 'u-42' } });
console.log('T2 finishReason:', s1.finishReason, 'runId:', !!s1.runId, 'suspendPayload:', JSON.stringify(s1.suspendPayload)?.slice(0, 120), 'executed?', executions > before);
mastra.removeAgent('tooluser');
mastra.addAgent(mk('B'));
const pending = await mastra.getAgentById('tooluser').listSuspendedRuns({ threadId: 'th2', resourceId: 'u-42' });
console.log('T2 suspended runs seen by NEW instance:', pending.runs?.length);
const resumed = await mastra.getAgentById('tooluser').approveToolCallGenerate({ runId: s1.runId, toolCallId: s1.suspendPayload?.toolCallId, requestContext: rc2 });
console.log('T2 resumed on new instance:', resumed.finishReason, 'executed?', executions > before, 'text:', resumed.text?.slice(0, 100));
console.log('T2 system prompt used after resume:', srv.log.filter(e => e.body?.model === 'tooluser-model').at(-1).body.messages[0].content);
srv.close(); process.exit(0);
