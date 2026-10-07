import { Agent } from '@mastra/core/agent';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import type { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import type { ProviderCheck, ProviderTestResult } from '@superagent/shared';
import { z } from 'zod';
import { redactSecrets, truncate } from '../../util/text';
import { routerId } from './model-ref';
import type { ResolvedProvider } from './registry';

export interface ProviderTestOptions {
  mastra: Mastra;
  provider: ResolvedProvider;
  model: string | null;
  embeddingModel: string | null;
  timeoutMs?: number;
}

/**
 * Exercises a provider the way agents will use it: through the `sa` gateway with throwaway agents
 * that are bound to Mastra but never registered. Each check runs independently and reports its own error.
 */
export async function runProviderTest(options: ProviderTestOptions): Promise<ProviderTestResult> {
  const { mastra, provider, model, embeddingModel } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const secrets = [provider.apiKey, ...Object.values(provider.headers)];
  const checks: ProviderCheck[] = [];

  const run = async (name: ProviderCheck['name'], fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const started = performance.now();
    try {
      const { ok, detail } = await fn();
      checks.push({
        name,
        ok,
        ms: Math.round(performance.now() - started),
        detail: redactSecrets(detail, secrets),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name,
        ok: false,
        ms: Math.round(performance.now() - started),
        error: truncate(redactSecrets(message, secrets), 500),
      });
    }
  };

  if (model) {
    const modelId = routerId({ provider: provider.slug, model });
    const plain = new Agent({
      id: 'provider-test',
      name: 'Provider test',
      instructions: 'You are a connectivity test. Follow instructions exactly and keep answers short.',
      model: modelId,
      // Report failures right away instead of retrying with backoff.
      maxRetries: 0,
      mastra,
    });

    await run('chat', async () => {
      const result = await plain.generate('Reply with exactly one word: pong', {
        maxSteps: 1,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      const text = result.text.trim();
      return {
        ok: text.length > 0,
        detail: `replied "${truncate(text, 60)}" (${result.usage?.totalTokens ?? '?'} tokens)`,
      };
    });

    await run('stream', async () => {
      const stream = await plain.stream('Count from 1 to 5, separated by spaces.', {
        maxSteps: 1,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      const text = (await stream.text).trim();
      const usage = await stream.usage;
      const tokens = usage?.totalTokens ?? 0;
      if (!text) return { ok: false, detail: 'stream returned no text' };
      if (!tokens) return { ok: false, detail: 'stream returned text but reported no token usage' };
      return { ok: true, detail: `streamed "${truncate(text, 60)}" (${tokens} tokens)` };
    });

    await run('tools', async () => {
      let calls = 0;
      const magicNumber = createTool({
        id: 'get_magic_number',
        description: 'Returns the magic number. Always call this tool when asked for the magic number.',
        inputSchema: z.object({}),
        execute: async () => {
          calls++;
          return { magicNumber: 42 };
        },
      });
      const withTools = new Agent({
        id: 'provider-test-tools',
        name: 'Provider test (tools)',
        instructions: 'You answer questions by calling the provided tools.',
        model: modelId,
        tools: { get_magic_number: magicNumber },
        maxRetries: 0,
        mastra,
      });
      const result = await withTools.generate(
        'What is the magic number? Call the get_magic_number tool, then reply with the number.',
        { maxSteps: 3, abortSignal: AbortSignal.timeout(timeoutMs) },
      );
      if (calls === 0) return { ok: false, detail: 'the model answered without calling the tool' };
      const usedResult = result.text.includes('42');
      return {
        ok: true,
        detail: usedResult
          ? 'called the tool and used its result'
          : 'called the tool (final answer did not echo 42)',
      };
    });
  }

  if (embeddingModel) {
    await run('embedding', async () => {
      const embedder = new ModelRouterEmbeddingModel({
        providerId: provider.slug,
        modelId: embeddingModel,
        url: provider.baseUrl,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers,
      });
      const { embeddings } = await embedder.doEmbed({
        values: ['superagent connectivity test'],
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      const dimensions = embeddings[0]?.length ?? 0;
      return { ok: dimensions > 0, detail: `${dimensions} dimensions` };
    });
  }

  return {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    model,
    embeddingModel,
    checks,
  };
}
