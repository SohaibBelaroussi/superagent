// M2 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
// Definitions and live registration only: delegation runs in the integration and live suites.
import type { AgentDefinition, CatalogTool, Department } from '@superagent/shared';
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

describe(`M2 against ${BASE_URL}`, () => {
  it('serves the tool catalog', async () => {
    const { items } = (await (await call('GET', '/v1/catalog/tools')).json()) as { items: CatalogTool[] };
    expect(items.map((t) => t.key)).toEqual(
      expect.arrayContaining(['current_time', 'web_search', 'fetch_page']),
    );
  });

  it('creates a department and agent that go live, then archives them', async () => {
    const suffix = Date.now().toString(36);
    const department = (await (
      await call('POST', '/v1/departments', { slug: `e2e-${suffix}`, name: `E2E ${suffix}` })
    ).json()) as Department;
    const created = await call('POST', '/v1/agents', {
      key: `e2e-lead-${suffix}`,
      name: 'E2E lead',
      role: 'lead',
      departmentId: department.id,
      description: 'End-to-end check.',
      instructions: 'Reply briefly.',
    });
    expect(created.status).toBe(201);
    const agent = (await created.json()) as AgentDefinition;

    const live = Object.keys((await (await call('GET', '/api/agents')).json()) as object);
    expect(live).toEqual(expect.arrayContaining(['chief', agent.key]));

    expect((await call('DELETE', `/v1/agents/${agent.id}`)).status).toBe(204);
    expect((await call('DELETE', `/v1/departments/${department.id}`)).status).toBe(204);
    const after = Object.keys((await (await call('GET', '/api/agents')).json()) as object);
    expect(after).not.toContain(agent.key);
  });
});
