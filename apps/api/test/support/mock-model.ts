import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export type ScriptedStep = { text: string } | { toolCall: { name: string; input: Record<string, unknown> } };

const finishReason = (step: ScriptedStep) => ({
  unified: ('toolCall' in step ? 'tool-calls' : 'stop') as 'tool-calls' | 'stop',
  raw: undefined,
});

/**
 * A deterministic model: the Nth call returns steps[N], whether it came through
 * Agent.generate() (doGenerate) or Agent.stream()/signals/schedules (doStream).
 */
export function scripted(steps: ScriptedStep[]): MockLanguageModelV4 {
  let calls = 0;
  const next = (): ScriptedStep => {
    const step = steps[calls++];
    if (!step) throw new Error(`Scripted model exhausted after ${steps.length} calls`);
    return step;
  };

  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = next();
      return {
        content:
          'toolCall' in step
            ? [
                {
                  type: 'tool-call',
                  toolCallId: `call_${calls}`,
                  toolName: step.toolCall.name,
                  input: JSON.stringify(step.toolCall.input),
                },
              ]
            : [{ type: 'text', text: step.text }],
        finishReason: finishReason(step),
        usage,
        warnings: [],
        // biome-ignore lint/suspicious/noExplicitAny: the mock's result type is wider than what we return
      } as any;
    },
    doStream: async () => {
      const step = next();
      return {
        stream: convertArrayToReadableStream<unknown>([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `resp_${calls}`, modelId: 'scripted', timestamp: new Date(0) },
          ...('toolCall' in step
            ? [
                {
                  type: 'tool-call',
                  toolCallId: `call_${calls}`,
                  toolName: step.toolCall.name,
                  input: JSON.stringify(step.toolCall.input),
                },
              ]
            : [
                { type: 'text-start', id: `text_${calls}` },
                { type: 'text-delta', id: `text_${calls}`, delta: step.text },
                { type: 'text-end', id: `text_${calls}` },
              ]),
          { type: 'finish', finishReason: finishReason(step), usage },
        ]),
        // biome-ignore lint/suspicious/noExplicitAny: stream part union is wider than what we emit
      } as any;
    },
  });
}
