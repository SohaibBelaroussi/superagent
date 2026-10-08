import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, research, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

describe('a new task', () => {
  it('asks for what’s missing, then creates and sends it', async () => {
    const created: unknown[] = [];
    server.use(
      ...signedInHandlers(),
      http.post(api('/v1/tasks'), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        created.push(body);
        return HttpResponse.json(task({ title: String(body.title), phase: 'queued' }), { status: 201 });
      }),
    );
    renderApp('/board');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /new task/i }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });

    await user.click(within(dialog).getByRole('button', { name: /create and send/i }));
    expect(within(dialog).getByText('Give the task a title.')).toBeVisible();
    expect(within(dialog).getByText('Say what you want done.')).toBeVisible();
    expect(created).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Title'), 'Compare frameworks');
    await user.type(within(dialog).getByLabelText('Brief'), 'Three frameworks, one recommendation.');
    await user.click(within(dialog).getByRole('button', { name: 'High' }));
    await user.click(within(dialog).getByRole('button', { name: /create and send/i }));

    await waitFor(() =>
      expect(created).toEqual([
        {
          departmentId: research.id,
          title: 'Compare frameworks',
          brief: 'Three frameworks, one recommendation.',
          priority: 'high',
          dispatch: true,
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).not.toBeInTheDocument());
    expect(await screen.findByText(/task #\d+ created/i)).toBeVisible();
  });

  it('parks the task in the inbox when its department has no lead', async () => {
    const created: Array<Record<string, unknown>> = [];
    server.use(
      http.get(api('/v1/departments'), () => HttpResponse.json({ items: [{ ...research, lead: null }] })),
      http.post(api('/v1/tasks'), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        created.push(body);
        return HttpResponse.json(task({ title: String(body.title) }), { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/board');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /new task/i }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByText(/no lead yet/i)).toBeVisible();
    expect(within(dialog).getByRole('switch', { name: /send it to the lead now/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.type(within(dialog).getByLabelText('Title'), 'Summarize Q3');
    await user.type(within(dialog).getByLabelText('Brief'), 'Totals by category.');
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(created[0]?.dispatch).toBe(false));
  });
});
