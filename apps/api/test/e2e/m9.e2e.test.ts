// M9 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`; CI runs the stack
// with compose.prod.yaml, from tagged images). No model here: the integration suite runs agents and
// checks that their calls are counted and priced; this checks the shapes, prices, auth and the runner's
// limits as the packaged API serves them. Backups and their restore drill run after this suite in CI.
import type {
  AttentionList,
  Board,
  Department,
  Provider,
  ProviderModel,
  Task,
  UsageReport,
} from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/env';

loadDotEnv();
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4112'}`;
const headers = {
  Authorization: `Bearer ${process.env.SUPERAGENT_ADMIN_TOKEN ?? ''}`,
  'content-type': 'application/json',
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe(`M9 against ${BASE_URL}`, () => {
  it('shows tokens and cost on every task card, and reports usage', async () => {
    const suffix = Date.now().toString(36);
    const department = (await (
      await call('POST', '/v1/departments', { slug: `e2e-m9-${suffix}`, name: `E2E M9 ${suffix}` })
    ).json()) as Department;
    const created = await call('POST', '/v1/tasks', {
      departmentId: department.id,
      title: 'Count me',
      brief: 'Nothing runs: no lead.',
      dispatch: false,
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as Task;
    const none = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, unpricedCalls: 0 };
    expect(task.usage).toMatchObject(none);
    const board = (await (await call('GET', `/v1/board?departmentId=${department.id}`)).json()) as Board;
    expect(board.columns.flatMap((c) => c.tasks).find((t) => t.id === task.id)?.usage).toMatchObject(none);

    for (const group of ['department', 'task', 'agent', 'model', 'day']) {
      const res = await call('GET', `/v1/usage?group=${group}`);
      expect(res.status, group).toBe(200);
      const report = (await res.json()) as UsageReport;
      expect(report).toMatchObject({ group, items: expect.any(Array), total: expect.any(Object) });
    }
    const scoped = (await (
      await call('GET', `/v1/usage?departmentId=${department.id}`)
    ).json()) as UsageReport;
    expect(scoped.total.calls).toBe(0);
    expect((await call('GET', '/v1/usage?group=everything')).status).toBe(400);
    expect((await fetch(`${BASE_URL}/v1/usage`)).status).toBe(401);
  });

  it("prices a provider's models", async () => {
    const suffix = Date.now().toString(36);
    const created = await call('POST', '/v1/providers', {
      slug: `e2e-m9-${suffix}`,
      name: 'E2E M9',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const provider = (await created.json()) as Provider;
    try {
      expect(
        (await call('POST', `/v1/providers/${provider.id}/models`, { modelId: 'm9-model' })).status,
      ).toBe(200);
      const priced = await call('PUT', `/v1/providers/${provider.id}/prices`, {
        modelId: 'm9-model',
        inputUsd: 0.5,
        cachedInputUsd: 0.05,
        outputUsd: 1.5,
      });
      expect(priced.status, await priced.clone().text()).toBe(200);
      const models = (
        (await (await call('GET', `/v1/providers/${provider.id}/models`)).json()) as {
          items: ProviderModel[];
        }
      ).items;
      expect(models.find((m) => m.modelId === 'm9-model')?.price).toEqual({
        inputUsd: 0.5,
        cachedInputUsd: 0.05,
        outputUsd: 1.5,
      });
      expect((await call('DELETE', `/v1/providers/${provider.id}/prices?modelId=m9-model`)).status).toBe(204);
      expect(
        (
          await call('PUT', `/v1/providers/${provider.id}/prices`, {
            modelId: 'm9-model',
            inputUsd: -1,
            outputUsd: 1,
          })
        ).status,
      ).toBe(400);
    } finally {
      expect((await call('DELETE', `/v1/providers/${provider.id}`)).status).toBe(204);
    }
  });

  it("runs on a Docker that enforces the runner's container limits", async () => {
    const attention = (await (await call('GET', '/v1/attention')).json()) as AttentionList;
    expect(attention.items.map((item) => item.id)).not.toContain('health:runner-limits');
  });
});
