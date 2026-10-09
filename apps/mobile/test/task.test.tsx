import { describe, expect, it } from '@jest/globals';
import type { Task } from '@superagent/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { api, approval, server, signedIn, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const decision = (kind: 'approve' | 'decline', target: string, reason: string | null = null) => ({
  id: '0199c000-0000-7000-8000-000000000001',
  kind,
  target,
  reason,
  status: 'applied',
  taskId: null,
  createdAt: new Date().toISOString(),
});

describe('a task', () => {
  it('approves a waiting call once, with an idempotency key', async () => {
    signedIn();
    const waiting = task({ phase: 'waiting', title: 'Find the papers' });
    const item = approval(waiting);
    const seen: Array<{ key: string | null; body: string }> = [];
    server.use(
      http.post(api('/v1/attention/:id/approve'), async ({ request, params }) => {
        seen.push({ key: request.headers.get('idempotency-key'), body: await request.text() });
        return HttpResponse.json(decision('approve', String(params.id)));
      }),
      ...signedInHandlers({ tasks: [waiting], attention: [item] }),
    );
    await renderApp(`/tasks/${waiting.id}`);

    expect(await screen.findByText('Ada wants to run web_search')).toBeOnTheScreen();
    expect(screen.getByText(/"query": "agent frameworks"/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Approved. The lead carries on.')).toBeOnTheScreen();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toMatch(/^[0-9a-f-]{32,36}$/);
  });

  it('declines a call with the reason the agent reads', async () => {
    signedIn();
    const waiting = task({ phase: 'waiting' });
    const item = approval(waiting);
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/v1/attention/:id/decline'), async ({ request, params }) => {
        bodies.push(await request.json());
        return HttpResponse.json(decision('decline', String(params.id), 'Use the knowledge base'));
      }),
      ...signedInHandlers({ tasks: [waiting], attention: [item] }),
    );
    await renderApp(`/tasks/${waiting.id}`);

    await fireEvent.press(await screen.findByRole('button', { name: 'Decline…' }));
    await fireEvent.changeText(screen.getByLabelText('Reason'), 'Use the knowledge base');
    await fireEvent.press(screen.getByRole('button', { name: 'Decline web_search' }));

    expect(await screen.findByText('Declined. The lead carries on without it.')).toBeOnTheScreen();
    expect(bodies).toEqual([{ reason: 'Use the knowledge base' }]);
  });

  it('accepts a result to review', async () => {
    signedIn();
    const reported = task({ phase: 'review', result: '## Findings\n\n**Mastra** fits best.' });
    let current: Task = reported;
    const patches: unknown[] = [];
    server.use(
      http.patch(api('/v1/tasks/:id'), async ({ request }) => {
        patches.push(await request.json());
        current = { ...reported, phase: 'done', closedAt: new Date().toISOString() };
        return HttpResponse.json(current);
      }),
      http.get(api('/v1/tasks/:id'), () => HttpResponse.json(current)),
      ...signedInHandlers({ tasks: [reported] }),
    );
    await renderApp(`/tasks/${reported.id}`);

    // The report, drawn from its Markdown.
    expect(await screen.findByText('Findings')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Accept' }));

    expect(await screen.findByText('Done')).toBeOnTheScreen();
    expect(patches).toEqual([{ phase: 'done' }]);
    expect(screen.getByRole('button', { name: 'Send back to lead' })).toBeOnTheScreen();
  });

  it('sends the lead a message for after its current turn', async () => {
    signedIn();
    const working = task({ phase: 'working' });
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/v1/tasks/:id/messages'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(working);
      }),
      ...signedInHandlers({ tasks: [working] }),
    );
    await renderApp(`/tasks/${working.id}`);

    await fireEvent.changeText(await screen.findByLabelText('Message to the lead'), 'Cite the sources too');
    await fireEvent.press(screen.getByRole('switch'));
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(bodies).toEqual([{ message: 'Cite the sources too', mode: 'queue' }]));
    expect(await screen.findByText('Sent for after this turn')).toBeOnTheScreen();
  });

  it('cancels a task after asking, with a reason', async () => {
    signedIn();
    const queued = task({ phase: 'queued', title: 'Old idea' });
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/v1/tasks/:id/cancel'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...queued, phase: 'cancelled', closedAt: new Date().toISOString() });
      }),
      ...signedInHandlers({ tasks: [queued] }),
    );
    await renderApp(`/tasks/${queued.id}`);

    await fireEvent.press(await screen.findByRole('button', { name: 'Cancel task…' }));
    expect(screen.getByText('Cancel “Old idea”?')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Reason'), 'Not needed now');
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel task' }));

    expect(await screen.findByText('Cancelled')).toBeOnTheScreen();
    expect(bodies).toEqual([{ reason: 'Not needed now' }]);
  });
});
