import type { AttentionItem, Task } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, research, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const itemFor = (
  kind: AttentionItem['kind'],
  subject: Task | null,
  extra: Partial<AttentionItem> = {},
): AttentionItem => ({
  id: subject
    ? kind === 'approval'
      ? `approval:run-${subject.number}:call-1`
      : `task:${subject.id}`
    : `health:${kind}`,
  kind,
  title: subject ? `#${subject.number} ${subject.title}` : 'No default model is set: agents cannot run',
  detail: null,
  taskId: subject?.id ?? null,
  taskNumber: subject?.number ?? null,
  departmentId: subject ? research.id : null,
  agent: kind === 'approval' ? 'research-lead' : null,
  tool: kind === 'approval' ? 'web_search' : null,
  since: ago(5),
  ...extra,
});

/** The inbox with these items; the attention list shrinks as the test settles them (`state`). */
function inbox(items: AttentionItem[], tasks: Task[] = []) {
  const state = { items };
  return {
    state,
    handlers: [
      http.get(api('/v1/attention'), () => HttpResponse.json({ items: state.items })),
      ...signedInHandlers({ tasks }),
    ],
  };
}

describe('the inbox', () => {
  it('puts what blocks an agent first, and counts everything in the rail', async () => {
    const reviewed = task({ title: 'Proofread', phase: 'review' });
    const waiting = task({ title: 'Find papers', phase: 'waiting' });
    const { handlers } = inbox(
      [
        itemFor('review', reviewed, {
          title: `#${reviewed.number} Proofread is ready for review`,
          since: ago(1),
        }),
        itemFor('approval', waiting, {
          title: 'Ada wants to run web_search',
          detail: `#${waiting.number} Find papers`,
          since: ago(30),
        }),
        itemFor('health', null, { detail: 'Pick one in settings.', since: ago(60) }),
      ],
      [reviewed, waiting],
    );
    server.use(...handlers);
    renderApp('/inbox');

    const list = await screen.findByRole('list', { name: 'Waiting for you' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Ada wants to run web_search'),
      expect.stringContaining('ready for review'),
      expect.stringContaining('No default model is set'),
    ]);
    // The approval names its task, with a link to it.
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: `#${waiting.number} Find papers` }),
    ).toHaveAttribute('href', `/tasks/${waiting.id}`);
    expect(screen.getByText('Pick one in settings.')).toBeVisible();
    const rail = screen.getByRole('navigation', { name: 'Main' });
    expect(within(rail).getByRole('link', { name: /inbox/i })).toHaveTextContent('3 waiting');
    expect(document.title).toBe('Inbox · superagent');
  });

  it('answers a lead’s question, which sends the task back to it', async () => {
    const asked = task({ title: 'Pick a framework', phase: 'waiting' });
    const sent: unknown[] = [];
    const { state, handlers } = inbox(
      [
        itemFor('question', asked, {
          title: `#${asked.number} Pick a framework: the lead needs you`,
          detail: 'Should I include LangGraph?',
        }),
      ],
      [asked],
    );
    server.use(
      http.post(api(`/v1/tasks/${asked.id}/messages`), async ({ request }) => {
        sent.push(await request.json());
        state.items = [];
        return HttpResponse.json({ ...asked, phase: 'queued' });
      }),
      ...handlers,
    );
    renderApp('/inbox');
    expect(await screen.findByText('Should I include LangGraph?')).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Answer Ada'), 'Yes, and CrewAI.');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(sent).toEqual([{ message: 'Yes, and CrewAI.', mode: 'steer' }]));
    expect(await screen.findByText('You’re all caught up')).toBeVisible();
  });

  it('accepts a result, or sends it back with the changes you want', async () => {
    const first = task({ title: 'Draft the update', phase: 'review' });
    const second = task({ title: 'Proofread the post', phase: 'review' });
    const patches: unknown[] = [];
    const messages: unknown[] = [];
    const { state, handlers } = inbox(
      [
        itemFor('review', first, {
          title: `#${first.number} Draft the update is ready for review`,
          detail: 'Drafted.',
        }),
        itemFor('review', second, { title: `#${second.number} Proofread the post is ready for review` }),
      ],
      [first, second],
    );
    server.use(
      http.patch(api(`/v1/tasks/${first.id}`), async ({ request }) => {
        patches.push(await request.json());
        state.items = state.items.filter((item) => item.taskId !== first.id);
        return HttpResponse.json({ ...first, phase: 'done', closedAt: new Date().toISOString() });
      }),
      http.post(api(`/v1/tasks/${second.id}/messages`), async ({ request }) => {
        messages.push(await request.json());
        state.items = state.items.filter((item) => item.taskId !== second.id);
        return HttpResponse.json({ ...second, phase: 'queued' });
      }),
      ...handlers,
    );
    renderApp('/inbox');
    const user = userEvent.setup();
    const accepted = await screen.findByRole('article', {
      name: `#${first.number} Draft the update is ready for review`,
    });
    await user.click(within(accepted).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(patches).toEqual([{ phase: 'done' }]));
    await waitFor(() => expect(screen.queryByText('Drafted.')).not.toBeInTheDocument());

    const other = screen.getByRole('article', {
      name: `#${second.number} Proofread the post is ready for review`,
    });
    await user.click(within(other).getByRole('button', { name: 'Request changes' }));
    await user.type(within(other).getByLabelText('What should Ada change?'), 'Shorter title.');
    await user.click(within(other).getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(messages).toEqual([{ message: 'Shorter title.', mode: 'steer' }]));
  });

  it('sends a task stuck in the inbox to its lead', async () => {
    const parked = task({ title: 'Summarize Q3', phase: 'inbox' });
    const patches: unknown[] = [];
    const { state, handlers } = inbox(
      [
        itemFor('problem', parked, {
          title: `#${parked.number} Summarize Q3 waits in the inbox`,
          detail: 'It could not be sent.',
        }),
      ],
      [parked],
    );
    server.use(
      http.patch(api(`/v1/tasks/${parked.id}`), async ({ request }) => {
        patches.push(await request.json());
        state.items = [];
        return HttpResponse.json({ ...parked, phase: 'queued' });
      }),
      ...handlers,
    );
    renderApp('/inbox');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Send to lead' }));
    await waitFor(() => expect(patches).toEqual([{ phase: 'queued' }]));
  });

  it('shows one kind at a time, from the URL', async () => {
    const reviewed = task({ title: 'Proofread', phase: 'review' });
    const stalled = task({ title: 'Rotate keys', phase: 'waiting' });
    const { handlers } = inbox(
      [
        itemFor('review', reviewed, { title: `#${reviewed.number} Proofread is ready for review` }),
        itemFor('problem', stalled, {
          title: `#${stalled.number} Rotate keys stopped`,
          detail: 'The run failed.',
        }),
      ],
      [reviewed, stalled],
    );
    server.use(...handlers);
    const { router } = renderApp('/inbox');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /problems/i }));
    expect(router.state.location.search).toBe('?kind=problem');
    expect(screen.queryByText(/ready for review/)).not.toBeInTheDocument();
    expect(screen.getByText('The run failed.')).toBeVisible();
    // A stopped task takes a message telling its lead how to go on.
    expect(screen.getByRole('button', { name: 'Tell Ada how to go on' })).toBeVisible();
  });
});
