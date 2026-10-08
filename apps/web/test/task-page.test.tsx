import type { AttentionItem, Task } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, event, research, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

/** The task's routes. The task is read from `state` on every request, so a test can change it. */
function withTask(current: Task, options: { attention?: AttentionItem[]; state?: { task: Task } } = {}) {
  const state = options.state ?? { task: current };
  return [
    ...signedInHandlers({ tasks: [current], attention: options.attention }),
    http.get(api(`/v1/tasks/${current.id}`), () => HttpResponse.json(state.task)),
    http.get(api(`/v1/tasks/${current.id}/events`), () =>
      HttpResponse.json({
        items: [
          event({ type: 'created', taskId: current.id }),
          event({ type: 'dispatched', taskId: current.id, actor: 'system', data: { lead: 'research-lead' } }),
        ],
      }),
    ),
    http.get(api(`/v1/tasks/${current.id}/artifacts`), () =>
      HttpResponse.json({
        items: [
          {
            id: 'artifact-1',
            taskId: current.id,
            kind: 'link',
            title: 'Bad link',
            content: null,
            url: 'javascript:alert(1)',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    ),
  ];
}

describe('a task', () => {
  it('shows its report as markdown, never raw HTML', async () => {
    const reviewed = task({
      title: 'Compare frameworks',
      phase: 'review',
      result:
        '## Recommendation\n\n**Mastra** fits.\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>',
    });
    server.use(...withTask(reviewed));
    const { container } = renderApp(`/tasks/${reviewed.id}`);

    expect(await screen.findByRole('heading', { name: 'Recommendation' })).toBeVisible();
    expect(screen.getByText('Mastra').tagName).toBe('STRONG');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // A link artifact with a javascript: URL is listed, not clickable.
    expect(await screen.findByText('Bad link')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Bad link' })).not.toBeInTheDocument();
    expect(screen.getByText('Sent to Ada')).toBeVisible();
  });

  it('accepts a task in review', async () => {
    const reviewed = task({ title: 'Proofread', phase: 'review', result: 'Done.' });
    const patches: unknown[] = [];
    const state = { task: reviewed };
    server.use(
      ...withTask(reviewed, { state }),
      http.patch(api(`/v1/tasks/${reviewed.id}`), async ({ request }) => {
        patches.push(await request.json());
        state.task = { ...reviewed, phase: 'done', closedAt: new Date().toISOString() };
        return HttpResponse.json(state.task);
      }),
    );
    renderApp(`/tasks/${reviewed.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(patches).toEqual([{ phase: 'done' }]));
    expect(await screen.findByRole('button', { name: /send back to lead/i })).toBeVisible();
  });

  const approvalFor = (waiting: Task): AttentionItem => ({
    id: 'approval:run-1:call-1',
    kind: 'approval',
    title: 'Ada wants to run web_search',
    detail: null,
    taskId: waiting.id,
    taskNumber: waiting.number,
    departmentId: research.id,
    agent: 'research-lead',
    tool: 'web_search',
    args: { query: 'agent memory papers' },
    since: new Date().toISOString(),
  });
  const decision = (target: string, taskId: string) => ({
    id: '0199d000-0000-7000-8000-000000000001',
    kind: 'approve',
    target,
    reason: null,
    status: 'applied',
    taskId,
    createdAt: new Date().toISOString(),
  });

  it('approves a waiting tool call once, retrying with the same idempotency key', async () => {
    const waiting = task({ title: 'Find papers', phase: 'waiting' });
    const approval = approvalFor(waiting);
    const decisions: Array<{ path: string; key: string | null }> = [];
    server.use(
      http.post(api('/v1/attention/:id/approve'), ({ request }) => {
        decisions.push({ path: new URL(request.url).pathname, key: request.headers.get('idempotency-key') });
        // The first attempt's answer is lost; the retry gets through.
        if (decisions.length === 1) return HttpResponse.error();
        return HttpResponse.json(decision(approval.id, waiting.id));
      }),
      ...withTask(waiting, { attention: [approval] }),
    );
    renderApp(`/tasks/${waiting.id}`);

    const card = await screen.findByRole('region', { name: /waiting for your approval/i });
    expect(within(card).getByText(/"query": "agent memory papers"/)).toBeVisible();
    // The lead takes no messages until the call is decided.
    expect(screen.getByText(/approve or decline the tool call above first/i)).toBeVisible();
    expect(screen.queryByLabelText('Message the lead')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Couldn’t record your decision')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await within(card).findByText('Approved. The lead carries on.')).toBeVisible();
    expect(within(card).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.path).toBe('/v1/attention/approval%3Arun-1%3Acall-1/approve');
    expect(decisions[0]?.key).toMatch(/^[0-9a-f-]{32,36}$/);
    expect(decisions[1]?.key).toBe(decisions[0]?.key);
  });

  it('says so, quietly, when the call was decided elsewhere', async () => {
    const waiting = task({ title: 'Find papers', phase: 'waiting' });
    const approval = approvalFor(waiting);
    server.use(
      http.post(api('/v1/attention/:id/approve'), () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Conflict', status: 409, code: 'already_decided' },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
      ...withTask(waiting, { attention: [approval] }),
    );
    renderApp(`/tasks/${waiting.id}`);
    const user = userEvent.setup();
    const card = await screen.findByRole('region', { name: /waiting for your approval/i });
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Already decided')).toBeVisible();
    expect(screen.queryByText('Couldn’t record your decision')).not.toBeInTheDocument();
  });

  it('messages the lead, now or after its turn', async () => {
    const working = task({ title: 'Draft', phase: 'working' });
    const sent: unknown[] = [];
    server.use(
      ...withTask(working),
      http.post(api(`/v1/tasks/${working.id}/messages`), async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json(working);
      }),
    );
    renderApp(`/tasks/${working.id}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Message the lead'), 'Add a source for each point');
    await user.click(screen.getByRole('button', { name: 'After this turn' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent).toEqual([{ message: 'Add a source for each point', mode: 'queue' }]));
    await waitFor(() => expect(screen.getByLabelText('Message the lead')).toHaveValue(''));
  });

  it('cancels after asking, with an optional reason', async () => {
    const working = task({ title: 'Rotate keys', phase: 'working' });
    const cancels: unknown[] = [];
    server.use(
      ...withTask(working),
      http.post(api(`/v1/tasks/${working.id}/cancel`), async ({ request }) => {
        cancels.push(await request.json());
        return HttpResponse.json({ ...working, phase: 'cancelled', closedAt: new Date().toISOString() });
      }),
    );
    renderApp(`/tasks/${working.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /cancel task/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Done by hand');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(cancels).toEqual([{ reason: 'Done by hand' }]));
  });

  it('says so when the task doesn’t exist', async () => {
    server.use(
      ...signedInHandlers(),
      http.get(api('/v1/tasks/:id'), () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Not Found', status: 404, code: 'task_not_found' },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderApp('/tasks/0199b000-0000-7000-8000-ffffffffffff');
    expect(await screen.findByText('No such task')).toBeVisible();
  });

  it('never puts an id that isn’t a task id into a request', async () => {
    // Unhandled requests fail the test: /v1/tokens, or any other path, must not be asked for.
    server.use(...signedInHandlers());
    renderApp('/tasks/..%2F..%2Fv1%2Ftokens');
    expect(await screen.findByText('No such task')).toBeVisible();
  });

  it('makes only web links clickable, and shows images as links', async () => {
    const reviewed = task({
      phase: 'review',
      result:
        '[site](https://example.com/page) [mail](mailto:someone@example.com) [inside](/v1/tokens)\n\n![chart](https://example.com/chart.png)',
    });
    server.use(...withTask(reviewed));
    const { container } = renderApp(`/tasks/${reviewed.id}`);
    expect(await screen.findByRole('link', { name: 'site' })).toHaveAttribute(
      'href',
      'https://example.com/page',
    );
    expect(screen.queryByRole('link', { name: 'mail' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'inside' })).not.toBeInTheDocument();
    expect(screen.getByText('mail')).toBeVisible();
    expect(screen.getByRole('link', { name: '[chart]' })).toHaveAttribute(
      'href',
      'https://example.com/chart.png',
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('offers no "send back" on a waiting task: answering the lead does that', async () => {
    const waiting = task({ title: 'A question', phase: 'waiting' });
    server.use(...withTask(waiting));
    renderApp(`/tasks/${waiting.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /cancel task/i })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /send back/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message the lead')).toBeVisible();
  });

  it('leaves a due date alone when you edit something else', async () => {
    const dated = task({ title: 'Dated', phase: 'working', dueAt: '2026-10-09T15:30:45.000Z' });
    const patches: unknown[] = [];
    server.use(
      http.patch(api(`/v1/tasks/${dated.id}`), async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ ...dated, title: 'Dated, renamed' });
      }),
      ...withTask(dated),
    );
    renderApp(`/tasks/${dated.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /edit title/i }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Dated, renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toEqual([{ title: 'Dated, renamed' }]));
  });
});
