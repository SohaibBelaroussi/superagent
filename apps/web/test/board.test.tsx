import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, NO_USAGE, research, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

describe('the board', () => {
  it('shows each phase as a column of cards, with what each task waits for', async () => {
    const waiting = task({ title: 'Find recent papers', phase: 'waiting', priority: 'urgent' });
    const working = task({
      title: 'Draft the weekly update',
      phase: 'working',
      progress: 40,
      checklist: [
        { text: 'Collect', done: true },
        { text: 'Draft', done: false },
      ],
      usage: {
        ...NO_USAGE,
        calls: 3,
        totalTokens: 12_300,
        inputTokens: 10_000,
        outputTokens: 2_300,
        costUsd: 0.042,
      },
    });
    server.use(
      ...signedInHandlers({
        tasks: [waiting, working, task({ title: 'Summarize Q3 spending' })],
        attention: [
          {
            id: 'approval:run-1:call-1',
            kind: 'approval',
            title: 'Ada wants to run web_search',
            detail: null,
            taskId: waiting.id,
            taskNumber: waiting.number,
            departmentId: research.id,
            agent: 'research-lead',
            tool: 'web_search',
            args: { query: 'agent memory' },
            since: new Date().toISOString(),
          },
        ],
      }),
    );
    renderApp('/board');

    const needsYou = await screen.findByRole('region', { name: /needs you, 1 task/i });
    const card = within(needsYou).getByRole('article', { name: 'Find recent papers' });
    expect(within(card).getByText('Approve web_search?')).toBeVisible();
    expect(within(card).getByText('Urgent')).toBeVisible();
    expect(within(card).getByText('Ada')).toBeVisible();

    const workingColumn = screen.getByRole('region', { name: /working, 1 task/i });
    const workingCard = within(workingColumn).getByRole('article', { name: 'Draft the weekly update' });
    expect(within(workingCard).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(within(workingCard).getByText('1/2')).toBeVisible();
    expect(within(workingCard).getByText('12.3k tok · $0.04')).toBeVisible();

    expect(
      within(screen.getByRole('region', { name: /inbox, 1 task/i })).getByText('Summarize Q3 spending'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: /review, 0 tasks/i })).getByText(/reported\. accept it/i),
    ).toBeVisible();
  });

  it('filters by title or number as you type', async () => {
    const first = task({ title: 'Compare frameworks' });
    server.use(...signedInHandlers({ tasks: [first, task({ title: 'Rotate keys' })] }));
    renderApp('/board');
    await screen.findByText('Rotate keys');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter tasks'), 'compare');
    expect(screen.queryByText('Rotate keys')).not.toBeInTheDocument();
    expect(screen.getByText('Compare frameworks')).toBeVisible();
    await user.clear(screen.getByLabelText('Filter tasks'));
    await user.type(screen.getByLabelText('Filter tasks'), `#${first.number}`);
    expect(screen.getByText('Compare frameworks')).toBeVisible();
  });

  it('shows one department from the URL, asking the API for its tasks only', async () => {
    const asked: Array<string | null> = [];
    server.use(
      http.get(api('/v1/board'), ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('departmentId'));
        return HttpResponse.json({
          columns: [{ phase: 'inbox', tasks: [task({ title: 'Research only' })] }],
        });
      }),
      ...signedInHandlers(),
    );
    renderApp('/board?department=research');
    expect(await screen.findByText('Research only')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Research' })).toBeVisible();
    expect(asked).toContain(research.id);
  });

  it('marks only the department being shown as the current page in the rail', async () => {
    server.use(...signedInHandlers());
    renderApp('/board?department=research');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByRole('link', { name: /research/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Board' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('invites you to start when the board is empty', async () => {
    server.use(...signedInHandlers({ tasks: [] }));
    renderApp('/board');
    expect(await screen.findByText('Nothing on the board')).toBeVisible();
  });
});
