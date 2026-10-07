// M5 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
// Schedules and attention without a model: approvals are covered by the integration and live suites.
import type { AttentionList, Department, Schedule, Task } from '@superagent/shared';
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

describe(`M5 against ${BASE_URL}`, () => {
  it('runs a schedule by hand, and shows what a department without a lead needs', async () => {
    const marker = `e2e-${Date.now().toString(36)}`;
    const department = (await (
      await call('POST', '/v1/departments', { slug: marker, name: `E2E ${marker}` })
    ).json()) as Department;

    const created = await call('POST', '/v1/schedules', {
      departmentId: department.id,
      title: 'Morning digest',
      brief: 'Summarize the news.',
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
    });
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as Schedule;
    expect(schedule).toMatchObject({ status: 'active', department: { slug: marker } });
    expect(new Date(schedule.nextFireAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    const run = await call('POST', `/v1/schedules/${schedule.id}/run`);
    expect(run.status).toBe(201);
    const task = (await run.json()) as Task;
    // No lead to send it to: it waits in the inbox, and attention says why.
    expect(task).toMatchObject({ source: 'schedule', scheduleId: schedule.id, phase: 'inbox' });
    const attention = (await (await call('GET', '/v1/attention')).json()) as AttentionList;
    expect(attention.items.find((i) => i.taskId === task.id)).toMatchObject({ kind: 'problem' });
    expect(attention.items.some((i) => i.id === `health:schedules-${department.id}`)).toBe(true);

    const paused = await call('PATCH', `/v1/schedules/${schedule.id}`, { status: 'paused' });
    expect(await paused.json()).toMatchObject({ status: 'paused', nextFireAt: null });

    const unknown = await call('POST', `/v1/attention/${encodeURIComponent('approval:nope:nope')}/approve`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/problem+json');

    expect((await call('DELETE', `/v1/schedules/${schedule.id}`)).status).toBe(204);
    expect((await call('POST', `/v1/tasks/${task.id}/cancel`)).status).toBe(200);
    expect((await call('DELETE', `/v1/departments/${department.id}`)).status).toBe(204);
  });
});
