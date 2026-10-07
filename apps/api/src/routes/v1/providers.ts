import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AddModelInputSchema,
  CreateProviderInputSchema,
  type Provider,
  ProviderListSchema,
  type ProviderModel,
  ProviderModelListSchema,
  ProviderSchema,
  ProviderTestInputSchema,
  ProviderTestResultSchema,
  UpdateProviderInputSchema,
} from '@superagent/shared';
import { ApiError, problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';
import { routerId } from '../../modules/providers/model-ref';
import type { ResolvedModel, ResolvedProvider } from '../../modules/providers/registry';
import { runProviderTest } from '../../modules/providers/testing';

function toProvider(p: ResolvedProvider): Provider {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    baseUrl: p.baseUrl,
    hasApiKey: p.apiKey !== null,
    secretsReadable: p.secretsReadable,
    headerNames: Object.keys(p.headers).sort(),
    strictJson: p.strictJson,
    enabled: p.enabled,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function toModels(slug: string, models: ResolvedModel[]): ProviderModel[] {
  return models.map((m) => ({
    modelId: m.modelId,
    kind: m.kind,
    source: m.source,
    enabled: m.enabled,
    discoveredAt: m.discoveredAt?.toISOString() ?? null,
    ref: routerId({ provider: slug, model: m.modelId }),
  }));
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});
const params = z.object({ id: z.uuid() });
const notFound = problemResponse('No provider with this id');
const tags = ['providers'];

const listProviders = createRoute({
  method: 'get',
  path: '/providers',
  tags,
  summary: 'List model providers',
  responses: { 200: json(ProviderListSchema, 'Providers, by slug') },
});

const createProvider = createRoute({
  method: 'post',
  path: '/providers',
  tags,
  summary: 'Add an OpenAI-compatible provider',
  description: 'The API key and headers are stored encrypted and never returned.',
  request: body(CreateProviderInputSchema),
  responses: {
    201: json(ProviderSchema, 'Provider created'),
    400: problemResponse('Invalid request'),
    409: problemResponse('Slug already taken'),
  },
});

const getProvider = createRoute({
  method: 'get',
  path: '/providers/{id}',
  tags,
  summary: 'Get a provider',
  request: { params },
  responses: { 200: json(ProviderSchema, 'The provider'), 404: notFound },
});

const updateProvider = createRoute({
  method: 'patch',
  path: '/providers/{id}',
  tags,
  summary: 'Update a provider',
  description: 'Changes apply to the next model call, no restart needed. `apiKey: null` removes the key.',
  request: { params, ...body(UpdateProviderInputSchema) },
  responses: {
    200: json(ProviderSchema, 'Updated provider'),
    400: problemResponse('Invalid request'),
    404: notFound,
  },
});

const deleteProvider = createRoute({
  method: 'delete',
  path: '/providers/{id}',
  tags,
  summary: 'Delete a provider',
  request: { params },
  responses: {
    204: { description: 'Deleted' },
    404: notFound,
    409: problemResponse('Provider is still used by a model role'),
  },
});

const listModels = createRoute({
  method: 'get',
  path: '/providers/{id}/models',
  tags,
  summary: "List a provider's models",
  request: { params },
  responses: { 200: json(ProviderModelListSchema, 'Known models'), 404: notFound },
});

const refreshModels = createRoute({
  method: 'post',
  path: '/providers/{id}/refresh-models',
  tags,
  summary: 'Discover models from GET {baseUrl}/models',
  request: { params },
  responses: {
    200: json(ProviderModelListSchema, 'Known models after discovery'),
    404: notFound,
    502: problemResponse('The provider could not be reached or returned an error'),
  },
});

const addModel = createRoute({
  method: 'post',
  path: '/providers/{id}/models',
  tags,
  summary: 'Add a model by hand',
  description: 'For servers without a /models endpoint, or to correct a guessed kind.',
  request: { params, ...body(AddModelInputSchema) },
  responses: { 200: json(ProviderModelListSchema, 'Known models'), 404: notFound },
});

const removeModel = createRoute({
  method: 'delete',
  path: '/providers/{id}/models',
  tags,
  summary: 'Remove a model',
  request: { params, query: z.object({ modelId: z.string().min(1) }) },
  responses: { 204: { description: 'Removed' }, 404: problemResponse('No such provider or model') },
});

const testProvider = createRoute({
  method: 'post',
  path: '/providers/{id}/test',
  tags,
  summary: 'Run connectivity checks',
  description:
    'Checks plain chat, streaming with token usage, tool calling and (optionally) embeddings. ' +
    'Always 200; read `ok` and each check.',
  request: {
    params,
    body: { required: false, content: { 'application/json': { schema: ProviderTestInputSchema } } },
  },
  responses: {
    200: json(ProviderTestResultSchema, 'Check results'),
    400: problemResponse('Nothing to test'),
    404: notFound,
  },
});

export function registerProviderRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  v1.openapi(listProviders, (c) => c.json({ items: deps.providers.list().map(toProvider) }, 200));

  v1.openapi(createProvider, async (c) => {
    const provider = await deps.providers.create(c.req.valid('json'));
    return c.json(toProvider(provider), 201);
  });

  v1.openapi(getProvider, (c) => c.json(toProvider(deps.providers.get(c.req.valid('param').id)), 200));

  v1.openapi(updateProvider, async (c) => {
    const provider = await deps.providers.update(c.req.valid('param').id, c.req.valid('json'));
    return c.json(toProvider(provider), 200);
  });

  v1.openapi(deleteProvider, async (c) => {
    const { id } = c.req.valid('param');
    // Under the settings lock, so no role can be pointed at this provider while it's being deleted.
    await deps.settings.lock.run(async () => {
      const roles = deps.settings.rolesUsingProvider(deps.providers.get(id).slug);
      if (roles.length > 0) {
        throw new ApiError(
          409,
          'provider_in_use',
          `Used by model roles: ${roles.join(', ')}. Change them first.`,
        );
      }
      await deps.providers.remove(id);
    });
    return c.body(null, 204);
  });

  v1.openapi(listModels, (c) => {
    const provider = deps.providers.get(c.req.valid('param').id);
    return c.json({ items: toModels(provider.slug, provider.models) }, 200);
  });

  v1.openapi(refreshModels, async (c) => {
    const { id } = c.req.valid('param');
    const models = await deps.providers.refreshModels(id);
    return c.json({ items: toModels(deps.providers.get(id).slug, models) }, 200);
  });

  v1.openapi(addModel, async (c) => {
    const { id } = c.req.valid('param');
    const models = await deps.providers.addModel(id, c.req.valid('json'));
    return c.json({ items: toModels(deps.providers.get(id).slug, models) }, 200);
  });

  v1.openapi(removeModel, async (c) => {
    await deps.providers.removeModel(c.req.valid('param').id, c.req.valid('query').modelId);
    return c.body(null, 204);
  });

  v1.openapi(testProvider, async (c) => {
    const provider = deps.providers.get(c.req.valid('param').id);
    const input = (c.req.valid('json') as z.infer<typeof ProviderTestInputSchema> | undefined) ?? {};
    const model = input.model ?? provider.models.find((m) => m.enabled && m.kind === 'chat')?.modelId ?? null;
    const embeddingModel = input.embeddingModel ?? null;
    if (!model && !embeddingModel) {
      throw new ApiError(
        400,
        'nothing_to_test',
        'No chat model known: pass "model", or refresh models first',
      );
    }
    const result = await runProviderTest({
      mastra: deps.mastra,
      provider,
      model,
      embeddingModel,
      // Stop calling the provider if the client goes away.
      signal: c.req.raw.signal,
    });
    deps.logger.info('Provider test finished', {
      providerId: provider.id,
      ok: result.ok,
      checks: result.checks.map((check) => `${check.name}:${check.ok ? 'ok' : 'failed'}`),
    });
    return c.json(result, 200);
  });
}
