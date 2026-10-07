import type { AttentionList, Department, Provider, Schedule, Task, TaskEvent } from '@superagent/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { schedules } from '../../src/db/schema';
import { type FakeOpenAI, startFakeOpenAI } from '../support/fake-openai';
import { jsonHeaders, startTestSystem } from './helpers';

type TaskPage = { items: Task[]; nextCursor: string | null };

/** The hour and weekday of a moment, in a timezone. */
const local = (iso: string, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('weekday')} ${get('hour')}:${get('minute')}`;
};

describe('schedules', () => {
  let system: System;
  let fake: FakeOpenAI;
  let research: Department;

  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;
  const waitForReport = async (id: string) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if ((await eventsOf(id)).some((e) => e.type === 'reported')) return;
      if (Date.now() > deadline) throw new Error('Timed out waiting for the report');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const create = async (body: Record<string, unknown>) => {
    const res = await send('POST', '/v1/schedules', { departmentId: research.id, ...body });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return (await res.json()) as Schedule;
  };

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat']);
    // A slow ticker: tests drive ticks themselves.
    system = await startTestSystem({ env: { SCHEDULER_TICK_MS: '3600000', DEFAULT_TIMEZONE: 'Asia/Qatar' } });
    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    research = (await (
      await send('POST', '/v1/departments', {
        slug: 'research',
        name: 'Research',
        description: 'Finds things out.',
      })
    ).json()) as Department;
    await send('POST', '/v1/agents', {
      key: 'research-lead',
      name: 'Research lead',
      role: 'lead',
      departmentId: research.id,
      description: 'Plans research.',
      instructions: 'Be brief.',
    });
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
  });

  it('creates, edits, pauses, resumes and deletes schedules', async () => {
    const schedule = await create({
      title: 'Weekly digest',
      brief: 'Summarize the week.',
      cron: '0 9 * * 1',
    });
    expect(schedule).toMatchObject({
      timezone: 'Asia/Qatar',
      status: 'active',
      priority: 'normal',
      createdBy: 'owner',
      department: { slug: 'research', name: 'Research' },
    });
    expect(local(schedule.nextFireAt ?? '', 'Asia/Qatar')).toBe('Mon 09:00');

    const paused = (await (
      await send('PATCH', `/v1/schedules/${schedule.id}`, { status: 'paused' })
    ).json()) as Schedule;
    expect(paused).toMatchObject({ status: 'paused', nextFireAt: null });
    const resumed = (await (
      await send('PATCH', `/v1/schedules/${schedule.id}`, {
        status: 'active',
        cron: '30 7 * * 3',
        timezone: 'Europe/Paris',
      })
    ).json()) as Schedule;
    expect(local(resumed.nextFireAt ?? '', 'Europe/Paris')).toBe('Wed 07:30');

    const listed = (await (await send('GET', `/v1/schedules?departmentId=${research.id}`)).json()) as {
      items: Schedule[];
    };
    expect(listed.items.map((s) => s.id)).toContain(schedule.id);

    expect((await send('DELETE', `/v1/schedules/${schedule.id}`)).status).toBe(204);
    expect((await send('GET', `/v1/schedules/${schedule.id}`)).status).toBe(404);
  });

  it('refuses bad timing', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ cron: 'not a cron' }, 400, 'invalid_cron'],
      [{ cron: '* * * * *' }, 400, 'schedule_too_frequent'],
      [{ cron: '0 9 * * 1', timezone: 'Mars/Phobos' }, 400, 'invalid_timezone'],
      [
        { cron: '0 9 * * 1', departmentId: '01900000-0000-7000-8000-000000000000' },
        404,
        'department_not_found',
      ],
    ];
    for (const [body, status, code] of cases) {
      const res = await send('POST', '/v1/schedules', {
        departmentId: research.id,
        title: 't',
        brief: 'b',
        ...body,
      });
      expect(res.status, code).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
  });

  it('sends a task to the lead when run by hand', async () => {
    const schedule = await create({ title: 'Digest now', brief: 'Summarize the news.', cron: '0 9 * * 1-5' });
    const res = await send('POST', `/v1/schedules/${schedule.id}/run`);
    expect(res.status).toBe(201);
    const task = (await res.json()) as Task;
    expect(task).toMatchObject({
      source: 'schedule',
      scheduleId: schedule.id,
      phase: 'queued',
      title: 'Digest now',
    });
    await waitForReport(task.id);
    const created = (await (await send('GET', `/v1/tasks?scheduleId=${schedule.id}`)).json()) as TaskPage;
    expect(created.items.map((t) => t.id)).toEqual([task.id]);
    expect(((await (await send('GET', `/v1/schedules/${schedule.id}`)).json()) as Schedule).lastTaskId).toBe(
      task.id,
    );
  });

  it('fires a due schedule once, and catches up once after downtime', async () => {
    const schedule = await create({
      title: 'Monday digest',
      brief: 'Summarize the week.',
      cron: '0 9 * * 1',
    });
    // As if the server had been down for three Mondays.
    const due = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    await system.db.update(schedules).set({ nextFireAt: due }).where(eq(schedules.id, schedule.id));

    await Promise.all([system.schedules.tick(), system.schedules.tick()]);
    await system.schedules.tick();
    const fired = (await (await send('GET', `/v1/tasks?scheduleId=${schedule.id}`)).json()) as TaskPage;
    expect(fired.items).toHaveLength(1);
    expect(fired.items[0]?.brief).toMatch(/earlier runs? (was|were) skipped/);
    const after = (await (await send('GET', `/v1/schedules/${schedule.id}`)).json()) as Schedule;
    expect(new Date(after.nextFireAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(local(after.nextFireAt ?? '', 'Asia/Qatar')).toBe('Mon 09:00');
    await waitForReport(fired.items[0]?.id ?? '');
  });

  it('lets the chief set up a schedule from a request', async () => {
    const res = await send('POST', '/api/agents/chief/generate', {
      messages: [
        { role: 'user', content: '[schedule] Every weekday at 9, have research summarize Mastra news.' },
      ],
      memory: { thread: 'chief:main', resource: 'owner' },
    });
    expect(res.status).toBe(200);
    const all = (await (await send('GET', '/v1/schedules')).json()) as { items: Schedule[] };
    expect(all.items.find((s) => s.title === 'Weekday digest')).toMatchObject({
      createdBy: 'chief',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Qatar',
      department: { slug: 'research' },
    });
  });

  it('parks the tasks of a department without a lead, and pauses an archived one', async () => {
    const ops = (await (
      await send('POST', '/v1/departments', { slug: 'ops', name: 'Operations' })
    ).json()) as Department;
    const orphan = await create({
      departmentId: ops.id,
      title: 'Rotate keys',
      brief: 'Rotate the keys.',
      cron: '0 6 1 * *',
    });
    const task = (await (await send('POST', `/v1/schedules/${orphan.id}/run`)).json()) as Task;
    expect(task.phase).toBe('inbox');
    const attention = (await (await send('GET', '/v1/attention')).json()) as AttentionList;
    expect(attention.items.find((i) => i.taskId === task.id)).toMatchObject({ kind: 'problem' });
    expect(attention.items.find((i) => i.id === `health:schedules-${ops.id}`)).toMatchObject({
      kind: 'health',
    });

    expect((await send('DELETE', `/v1/departments/${ops.id}`)).status).toBe(204);
    await system.db
      .update(schedules)
      .set({ nextFireAt: new Date(Date.now() - 1000) })
      .where(eq(schedules.id, orphan.id));
    await system.schedules.tick();
    expect(((await (await send('GET', `/v1/schedules/${orphan.id}`)).json()) as Schedule).status).toBe(
      'paused',
    );
    const fired = (await (await send('GET', `/v1/tasks?scheduleId=${orphan.id}`)).json()) as TaskPage;
    expect(fired.items).toHaveLength(1);
  });
});
