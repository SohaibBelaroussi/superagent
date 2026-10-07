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
  /** Aborts the whole run, e.g. when the HTTP client disconnects. */
  signal?: AbortSignal;
  /** Cap for one check. */
  checkTimeoutMs?: number;
  /** Cap for the whole run. */
  totalTimeoutMs?: number;
}

const TEST_TOOL_ID = 'get_magic_number';
const FAILED_FINISH_REASONS = new Set(['error', 'retry', 'aborted', 'other', 'unknown']);

type CheckResult = { ok: boolean; detail?: string; error?: string };

/**
 * Exercises a provider the way agents will use it: through the `sa` gateway with throwaway agents bound
 * to Mastra but never registered. Mastra resolves (rather than throws) on retryable failures, so an
 * empty or failed answer is followed by one direct request to report the real cause.
 */
export async function runProviderTest(options: ProviderTestOptions): Promise<ProviderTestResult> {
  const { mastra, provider, model, embeddingModel } = options;
  const checkTimeoutMs = options.checkTimeoutMs ?? 45_000;
  const deadline = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.totalTimeoutMs ?? 120_000),
  ]);
  const checkSignal = () => AbortSignal.any([deadline, AbortSignal.timeout(checkTimeoutMs)]);
  const secrets = [provider.apiKey, ...Object.values(provider.headers)];
  const clean = (text: string) => truncate(redactSecrets(text, secrets), 500);
  const checks: ProviderCheck[] = [];

  const run = async (name: ProviderCheck['name'], fn: () => Promise<CheckResult>) => {
    const started = performance.now();
    let result: CheckResult;
    try {
      result = deadline.aborted
        ? { ok: false, error: 'skipped: the test was cancelled or ran out of time' }
        : await fn();
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    checks.push({
      name,
      ok: result.ok,
      ms: Math.round(performance.now() - started),
      ...(result.detail !== undefined ? { detail: clean(result.detail) } : {}),
      ...(result.error !== undefined ? { error: clean(result.error) } : {}),
    });
    return result;
  };

  if (model) {
    const modelId = routerId({ provider: provider.slug, model });
    const failed = async (finishReason: string | undefined): Promise<CheckResult> => ({
      ok: false,
      error: await diagnose(provider, model, finishReason, checkSignal()),
    });
    const plain = new Agent({
      id: 'provider-test',
      name: 'Provider test',
      instructions: 'You are a connectivity test. Follow instructions exactly and keep answers short.',
      model: modelId,
      // Report failures right away instead of retrying with backoff.
      maxRetries: 0,
      mastra,
    });

    const chat = await run('chat', async () => {
      const result = await plain.generate('Reply with exactly one word: pong', {
        maxSteps: 1,
        abortSignal: checkSignal(),
      });
      const text = result.text.trim();
      const finishReason = (result as { finishReason?: string }).finishReason;
      if (!text || FAILED_FINISH_REASONS.has(finishReason ?? '')) return failed(finishReason);
      return {
        ok: true,
        detail: `replied "${truncate(text, 60)}" (${result.usage?.totalTokens ?? '?'} tokens)`,
      };
    });

    if (!chat.ok) {
      // The provider isn't answering at all: don't spend minutes on checks that will fail the same way.
      for (const name of ['stream', 'tools'] as const) {
        checks.push({ name, ok: false, ms: 0, error: 'skipped: the chat check failed' });
      }
    } else {
      await run('stream', async () => {
        const stream = await plain.stream('Count from 1 to 5, separated by spaces.', {
          maxSteps: 1,
          abortSignal: checkSignal(),
        });
        const text = (await stream.text).trim();
        const usage = await stream.usage;
        const finishReason = await (stream as { finishReason?: Promise<string | undefined> }).finishReason;
        if (!text || FAILED_FINISH_REASONS.has(finishReason ?? '')) return failed(finishReason);
        const tokens = usage?.totalTokens ?? 0;
        if (!tokens) {
          return {
            ok: false,
            error:
              'streamed text but reported no token usage (the server may ignore stream_options.include_usage)',
          };
        }
        return { ok: true, detail: `streamed "${truncate(text, 60)}" (${tokens} tokens)` };
      });

      await run('tools', async () => {
        let calls = 0;
        const magicNumber = createTool({
          id: TEST_TOOL_ID,
          description: 'Returns the magic number. Always call this tool when asked for the magic number.',
          inputSchema: z.object({}),
          execute: async () => {
            calls++;
            return { magicNumber: 42 };
          },
        });
        try {
          const withTools = new Agent({
            id: 'provider-test-tools',
            name: 'Provider test (tools)',
            instructions: 'You answer questions by calling the provided tools.',
            model: modelId,
            tools: { [TEST_TOOL_ID]: magicNumber },
            maxRetries: 0,
            mastra,
          });
          const result = await withTools.generate(
            'What is the magic number? Call the get_magic_number tool, then reply with the number.',
            { maxSteps: 3, abortSignal: checkSignal() },
          );
          const finishReason = (result as { finishReason?: string }).finishReason;
          if (calls === 0 && FAILED_FINISH_REASONS.has(finishReason ?? '')) return failed(finishReason);
          if (calls === 0) return { ok: false, error: 'the model answered without calling the tool' };
          return {
            ok: true,
            detail: result.text.includes('42')
              ? 'called the tool and used its result'
              : 'called the tool (final answer did not echo 42)',
          };
        } finally {
          // Binding an agent to Mastra registers its tools globally (/api/tools); don't leave ours behind.
          mastra.removeTool(TEST_TOOL_ID);
        }
      });
    }
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
        abortSignal: checkSignal(),
      });
      const dimensions = embeddings[0]?.length ?? 0;
      return dimensions > 0
        ? { ok: true, detail: `${dimensions} dimensions` }
        : { ok: false, error: 'the embedding response contained no vector' };
    });
  }

  return {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    model,
    embeddingModel,
    checks,
  };
}

/** One direct chat request, to turn "no answer" into a concrete cause (unreachable, HTTP status, body). */
async function diagnose(
  provider: ResolvedProvider,
  model: string,
  finishReason: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const url = `${provider.baseUrl}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...provider.headers,
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal,
    });
    if (!response.ok) {
      const body = truncate((await response.text().catch(() => '')).replace(/\s+/g, ' ').trim(), 200);
      return `the provider returned HTTP ${response.status}${body ? `: ${body}` : ''}`;
    }
    return `the provider answers direct requests, but the agent call did not complete (finish reason: ${finishReason ?? 'none'})`;
  } catch (error) {
    if (signal.aborted) return 'the provider did not answer in time';
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return `could not connect to ${new URL(url).host}: ${cause?.code ?? cause?.message ?? (error as Error).message}`;
  }
}
