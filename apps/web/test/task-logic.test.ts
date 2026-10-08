import type { AttentionItem } from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { attentionByTask, attentionLine } from '../src/features/tasks/attention';
import { condenseEvents, describeEvent } from '../src/features/tasks/events';
import type { OrgLookup } from '../src/features/tasks/org';
import { taskProgress } from '../src/features/tasks/task-bits';
import { ada, event, research, task } from './msw';

const org: OrgLookup = {
  department: (id) => (id === research.id ? research : undefined),
  departmentBySlug: (slug) => (slug === research.slug ? research : undefined),
  agent: (id) => (id === ada.id ? ada : undefined),
  agentByKey: (key) => (key === ada.key ? ada : undefined),
  departments: [research],
  agents: [ada],
  ready: true,
};

const item = (overrides: Partial<AttentionItem> & Pick<AttentionItem, 'kind'>): AttentionItem => ({
  id: `${overrides.kind}:x`,
  title: 'Something',
  detail: null,
  taskId: 'task-1',
  taskNumber: 4,
  departmentId: research.id,
  agent: null,
  tool: null,
  since: '2026-10-08T12:00:00.000Z',
  ...overrides,
});

describe('describeEvent', () => {
  it('names agents from "agent:<key>" actors, and the owner as you', () => {
    expect(
      describeEvent(event({ type: 'progress', actor: 'agent:research-lead', data: { progress: 40 } }), org)
        .title,
    ).toBe('Ada reported progress: 40%');
    expect(describeEvent(event({ type: 'created', actor: 'owner' }), org).title).toBe('You created the task');
    expect(
      describeEvent(event({ type: 'dispatched', actor: 'system', data: { lead: 'research-lead' } }), org)
        .title,
    ).toBe('Sent to Ada');
    expect(describeEvent(event({ type: 'created', actor: 'schedule' }), org).title).toBe(
      'A schedule created the task',
    );
  });

  it('carries the summary of a report and the text of a message', () => {
    const report = describeEvent(
      event({
        type: 'reported',
        actor: 'agent:research-lead',
        data: { outcome: 'blocked', summary: 'Which year?' },
      }),
      org,
    );
    expect(report).toMatchObject({ title: 'Ada needs you', detail: 'Which year?', tone: 'orange' });
    const message = describeEvent(
      event({ type: 'message', data: { mode: 'queue', text: 'Also add sources' } }),
      org,
    );
    expect(message).toMatchObject({
      title: 'You sent a message for after this turn',
      detail: 'Also add sources',
    });
  });

  it('still reads for event types it doesn’t know', () => {
    expect(describeEvent(event({ type: 'something_new', actor: 'system' }), org).title).toBe(
      'Superagent: something new',
    );
  });
});

describe('condenseEvents', () => {
  it('drops phase changes that restate their neighbour', () => {
    const events = [
      event({ type: 'created' }),
      event({ type: 'phase_changed', data: { from: 'inbox', to: 'queued' } }),
      event({ type: 'dispatched', data: { lead: 'research-lead' } }),
      event({ type: 'phase_changed', data: { from: 'working', to: 'waiting' } }),
      event({ type: 'approval_requested', data: { tool: 'web_search' } }),
      event({ type: 'approval_decided', data: { decision: 'approve', tool: 'web_search' } }),
      event({ type: 'phase_changed', data: { from: 'waiting', to: 'working' } }),
      event({ type: 'phase_changed', data: { from: 'review', to: 'done' } }),
    ];
    expect(condenseEvents(events).map((e) => e.type)).toEqual([
      'created',
      'dispatched',
      'approval_requested',
      'approval_decided',
      'phase_changed',
    ]);
  });
});

describe('attention on cards', () => {
  it('keeps the most pressing item per task', () => {
    const map = attentionByTask([item({ kind: 'review' }), item({ kind: 'approval', tool: 'web_search' })]);
    expect(map.get('task-1')?.kind).toBe('approval');
  });

  it('says what the task waits for, without repeating its name', () => {
    expect(attentionLine(item({ kind: 'approval', tool: 'web_search' }), 'Find papers').text).toBe(
      'Approve web_search?',
    );
    expect(
      attentionLine(item({ kind: 'problem', title: '#4 Find papers stopped' }), 'Find papers').text,
    ).toBe('Stopped');
    expect(
      attentionLine(item({ kind: 'problem', title: '#4 Find papers waits in the inbox' }), 'Find papers')
        .text,
    ).toBe('Waits in the inbox');
  });
});

describe('taskProgress', () => {
  it('prefers the lead’s percentage and labels the checklist', () => {
    const checklist = [
      { text: 'a', done: true },
      { text: 'b', done: false },
    ];
    expect(taskProgress(task({ progress: 70, checklist }))).toEqual({ percent: 70, label: '1/2' });
    expect(taskProgress(task({ checklist }))).toEqual({ percent: 50, label: '1/2' });
    expect(taskProgress(task())).toBeNull();
  });
});
