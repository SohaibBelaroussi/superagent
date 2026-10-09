import { describe, expect, it } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { api, approval, research, server, signedIn, signedInHandlers, task, writing } from './msw';
import { renderApp } from './render';

describe('home', () => {
  it('greets you, says what needs you and what’s running, and opens a task', async () => {
    signedIn();
    const waiting = task({ phase: 'waiting', title: 'Find the papers' });
    const working = task({ phase: 'working', title: 'Draft the summary', progress: 40 });
    server.use(...signedInHandlers({ tasks: [waiting, working], attention: [approval(waiting)] }));
    await renderApp('/');

    expect(await screen.findByText(/Good (morning|afternoon|evening), Sohaib$/)).toBeOnTheScreen();
    expect(await screen.findByText('1 thing needs you · 2 tasks in progress')).toBeOnTheScreen();
    expect(screen.getByLabelText('Spent this week: $0.42')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Approval: Ada wants to run web_search' }));
    expect(await screen.findByRole('header', { name: 'Find the papers' })).toBeOnTheScreen();
  });
});

describe('the board', () => {
  it('opens on what needs you, counts each phase, and filters by department', async () => {
    signedIn();
    const waiting = task({ phase: 'waiting', title: 'Find the papers' });
    const drafting = task({ phase: 'working', title: 'Draft the post', departmentId: writing.id });
    const done = task({ phase: 'done', title: 'Old report', closedAt: new Date().toISOString() });
    const requested: Array<string | null> = [];
    server.use(
      http.get(api('/v1/board'), ({ request }) => {
        requested.push(new URL(request.url).searchParams.get('departmentId'));
        return undefined;
      }),
      ...signedInHandlers({ tasks: [waiting, drafting, done], attention: [approval(waiting)] }),
    );
    await renderApp('/board');

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Needs you, 1' })).toBeSelected());
    expect(screen.getByRole('tab', { name: 'Working, 1' })).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Done, 1' })).toBeOnTheScreen();
    expect(screen.getByText('Approve web_search?')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Writing' }));
    await waitFor(() => expect(requested).toContain(writing.id));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Working, 1' })).toBeOnTheScreen());
    expect(screen.getByRole('tab', { name: 'Needs you, 0' })).toBeOnTheScreen();
  });
});

describe('a new task', () => {
  it('goes to the chosen department’s lead, at the chosen priority', async () => {
    signedIn();
    const made = task({ title: 'Compare vector stores', phase: 'queued' });
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/v1/tasks'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(made, { status: 201 });
      }),
      ...signedInHandlers({ tasks: [made] }),
    );
    await renderApp('/new-task');

    await fireEvent.press(await screen.findByRole('radio', { name: 'Research' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Compare vector stores');
    await fireEvent.changeText(screen.getByLabelText('Brief'), 'Which fits Postgres best?');
    await fireEvent.press(screen.getByRole('tab', { name: 'High' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create task' }));

    expect(await screen.findByRole('header', { name: 'Compare vector stores' })).toBeOnTheScreen();
    expect(bodies).toEqual([
      {
        departmentId: research.id,
        title: 'Compare vector stores',
        brief: 'Which fits Postgres best?',
        priority: 'high',
        dispatch: true,
      },
    ]);
  });

  it('keeps a task for a department without a lead in its inbox', async () => {
    signedIn();
    const made = task({ title: 'Draft the post', departmentId: writing.id });
    const bodies: Array<{ dispatch?: boolean }> = [];
    server.use(
      http.post(api('/v1/tasks'), async ({ request }) => {
        bodies.push((await request.json()) as { dispatch?: boolean });
        return HttpResponse.json(made, { status: 201 });
      }),
      ...signedInHandlers({ tasks: [made] }),
    );
    await renderApp('/new-task');

    await fireEvent.press(await screen.findByRole('radio', { name: 'Writing' }));
    expect(
      screen.getByText('This department has no lead yet: the task waits in its inbox.'),
    ).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Draft the post');
    await fireEvent.changeText(screen.getByLabelText('Brief'), 'About the launch.');
    await fireEvent.press(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(bodies[0]?.dispatch).toBe(false));
  });
});
