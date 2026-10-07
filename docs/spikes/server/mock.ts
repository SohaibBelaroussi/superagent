import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export type Step = { text: string } | { toolCall: { name: string; input: Record<string, unknown> } };

const finish = (s: Step) => ({ unified: ('toolCall' in s ? 'tool-calls' : 'stop') as any, raw: undefined });

/**
 * Scripted model: the Nth model call (generate OR stream, shared counter) returns steps[N].
 * Provides both doGenerate and doStream because Agent.generate() and Agent.stream()/signals
 * hit different model methods.
 */
export function scripted(steps: Step[]) {
  let n = 0;
  const next = () => {
    const s = steps[n++];
    if (!s) throw new Error(`scripted model exhausted after ${steps.length} calls`);
    return s;
  };
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const s = next();
      return {
        content:
          'toolCall' in s
            ? [{ type: 'tool-call', toolCallId: `call_${n}`, toolName: s.toolCall.name, input: JSON.stringify(s.toolCall.input) }]
            : [{ type: 'text', text: s.text }],
        finishReason: finish(s),
        usage,
        warnings: [],
      } as any;
    },
    doStream: async () => {
      const s = next();
      return {
        stream: convertArrayToReadableStream<any>([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `r${n}`, modelId: 'mock', timestamp: new Date(0) },
          ...('toolCall' in s
            ? [{ type: 'tool-call', toolCallId: `call_${n}`, toolName: s.toolCall.name, input: JSON.stringify(s.toolCall.input) }]
            : [
                { type: 'text-start', id: `t${n}` },
                { type: 'text-delta', id: `t${n}`, delta: s.text },
                { type: 'text-end', id: `t${n}` },
              ]),
          { type: 'finish', finishReason: finish(s), usage },
        ]),
      };
    },
  });
}
