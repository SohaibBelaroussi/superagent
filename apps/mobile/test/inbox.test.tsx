import { describe, expect, it } from '@jest/globals';
import type { AttentionItem, Task } from '@superagent/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { browser } from './device';
import { api, approval, SERVER, server, signedIn, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const since = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function item(
  target: Task,
  overrides: Partial<AttentionItem> & Pick<AttentionItem, 'kind' | 'title'>,
): AttentionItem {
  return {
    id: `task:${target.id}`,
    detail: null,
    taskId: target.id,
    taskNumber: target.number,
    departmentId: target.departmentId,
    agent: null,
    tool: null,
    since: since(5),
    ...overrides,
  };
}

const searching = task({ phase: 'waiting', number: 3, title: 'Find the papers' });
const planning = task({ phase: 'waiting', number: 8, title: 'Plan the launch' });
const reviewing = task({ phase: 'review', number: 9, title: 'Write the summary' });
const failing = task({ phase: 'failed', number: 11, title: 'Translate the notes' });

const everything: AttentionItem[] = [
  item(reviewing, { kind: 'review', title: '#9 is ready for review', detail: 'Three papers, summarised.' }),
  item(failing, { kind: 'problem', title: '#11 failed', detail: 'The model refused the request.' }),
  approval(searching),
  item(planning, { kind: 'question', title: '#8 has a question', detail: 'Which markets first?' }),
  {
    id: 'health:models',
    kind: 'health',
    title: 'No model for the chief',
    detail: 'Pick a default model in settings.',
    taskId: null,
    taskNumber: null,
    departmentId: null,
    agent: null,
    tool: null,
    since: since(60),
  },
];

describe('the inbox', () => {
  it('lists what needs you, approvals first, each with its action', async () => {
    signedIn();
    server.use(
      ...signedInHandlers({ tasks: [searching, planning, reviewing, failing], attention: everything }),
    );
    await renderApp('/inbox');

    expect(await screen.findByText('5 things need you.')).toBeOnTheScreen();
    const headings = screen.getAllByRole('header').map((heading) => heading.props.children);
    expect(headings).toEqual([
      'Inbox',
      'APPROVALS · 1',
      'QUESTIONS · 1',
      'PROBLEMS · 1',
      'RESULTS TO REVIEW · 1',
      'SETUP · 1',
    ]);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeOnTheScreen();
    expect(screen.getByText('Which markets first?')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open the task' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Open the web app' }));
    expect(browser.openBrowserAsync).toHaveBeenCalledWith(SERVER);
  });

  it('answers a lead’s question, and drops it at once', async () => {
    signedIn();
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/v1/tasks/:id/messages'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...planning, phase: 'queued' });
      }),
      ...signedInHandlers({ tasks: [planning], attention: [everything[3] as AttentionItem] }),
    );
    await renderApp('/inbox');

    await fireEvent.changeText(await screen.findByLabelText('Answer Ada'), 'Europe first.');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(bodies).toEqual([{ message: 'Europe first.', mode: 'steer' }]));
    expect(await screen.findByText('Sent to Ada')).toBeOnTheScreen();
    expect(screen.queryByText('Which markets first?')).toBeNull();
  });

  it('accepts a result, or sends it back with what to change', async () => {
    signedIn();
    const patches: unknown[] = [];
    const messages: unknown[] = [];
    const second = task({ phase: 'review', number: 12, title: 'Draft the post' });
    server.use(
      http.patch(api('/v1/tasks/:id'), async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ ...reviewing, phase: 'done' });
      }),
      http.post(api('/v1/tasks/:id/messages'), async ({ request }) => {
        messages.push(await request.json());
        return HttpResponse.json({ ...second, phase: 'queued' });
      }),
      ...signedInHandlers({
        tasks: [reviewing, second],
        attention: [
          everything[0] as AttentionItem,
          item(second, { kind: 'review', title: '#12 is ready for review', since: since(2) }),
        ],
      }),
    );
    await renderApp('/inbox');

    const accepted = await screen.findByLabelText('Review: #9 is ready for review');
    await fireEvent.press(within(accepted).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(patches).toEqual([{ phase: 'done' }]));
    await waitFor(() => expect(screen.queryByText('#9 is ready for review')).toBeNull());

    await fireEvent.press(screen.getByRole('button', { name: 'Ask for changes' }));
    await fireEvent.changeText(screen.getByLabelText('What should Ada change?'), 'Shorter, please.');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(messages).toEqual([{ message: 'Shorter, please.', mode: 'steer' }]));
    expect(await screen.findByText('You’re all caught up')).toBeOnTheScreen();
  });

  it('says when nothing needs you', async () => {
    signedIn();
    server.use(...signedInHandlers());
    await renderApp('/inbox');
    expect(await screen.findByText('You’re all caught up')).toBeOnTheScreen();
    expect(screen.getByText('Nothing needs you.')).toBeOnTheScreen();
  });
});
