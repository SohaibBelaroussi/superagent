// M6 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
// The packaged API reaches the runner, and the runner reaches Docker. Agent runs in sandboxes are
// covered by the integration and live suites (they need a model).
import type { AttentionList, Department, SandboxList, Task } from '@superagent/shared';
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

describe(`M6 against ${BASE_URL}`, () => {
  it('lists sandboxes through the runner, which reaches Docker', async () => {
    const res = await call('GET', '/v1/sandboxes');
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as SandboxList).items)).toBe(true);
    expect((await call('DELETE', `/v1/sandboxes/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('serves no files for a task no agent worked in, and keeps paths inside the workspace', async () => {
    const marker = `e2e-${Date.now().toString(36)}`;
    const department = (await (
      await call('POST', '/v1/departments', { slug: marker, name: `E2E ${marker}` })
    ).json()) as Department;
    const coder = (await (
      await call('POST', '/v1/agents', {
        key: `${marker}-coder`,
        name: 'E2E coder',
        role: 'specialist',
        departmentId: department.id,
        description: 'Codes.',
        instructions: 'Code.',
        tools: [{ key: 'files' }, { key: 'shell' }],
      })
    ).json()) as { id: string };
    const task = (await (
      await call('POST', '/v1/tasks', {
        departmentId: department.id,
        title: 'No files',
        brief: 'Nothing yet.',
        // The department has no lead: the task stays in the inbox.
        dispatch: false,
      })
    ).json()) as Task;
    expect(task.phase).toBe('inbox');

    // The runner looked for the task's folder in Docker's volume: there is none.
    const files = await call('GET', `/v1/tasks/${task.id}/files`);
    expect(files.status).toBe(404);
    expect(await files.json()).toMatchObject({ code: 'workspace_not_found' });
    expect((await call('GET', `/v1/tasks/${task.id}/files?path=..%2Fx`)).status).toBe(400);
    // The runner answers, so nothing in attention says sandboxes are off or unreachable.
    const attention = (await (await call('GET', '/v1/attention')).json()) as AttentionList;
    expect(attention.items.some((i) => i.id === 'health:sandboxes')).toBe(false);

    expect((await call('POST', `/v1/tasks/${task.id}/cancel`)).status).toBe(200);
    expect((await call('DELETE', `/v1/agents/${coder.id}`)).status).toBe(204);
    expect((await call('DELETE', `/v1/departments/${department.id}`)).status).toBe(204);
  });
});
