import type { Schedule } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { formatClock } from '../src/lib/cron';
import { api, research, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const digest: Schedule = {
  id: '0199c000-0000-7000-8000-000000000001',
  departmentId: research.id,
  department: { slug: research.slug, name: research.name },
  title: 'Weekly AI news digest',
  brief: 'The five most important releases.',
  priority: 'normal',
  cron: '0 9 * * 1',
  timezone: 'Europe/Paris',
  status: 'active',
  nextFireAt: '2026-10-12T07:00:00.000Z',
  lastFireAt: null,
  lastTaskId: null,
  createdBy: 'agent:research-lead',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

describe('schedules', () => {
  it('lists each one in words, with its next run and who set it up', async () => {
    server.use(
      ...signedInHandlers({
        schedules: [
          digest,
          {
            ...digest,
            id: '0199c000-0000-7000-8000-000000000002',
            title: 'Monthly report',
            cron: '30 8 1 * *',
            timezone: 'Asia/Qatar',
            status: 'paused',
            nextFireAt: null,
            createdBy: 'owner',
          },
        ],
      }),
    );
    renderApp('/schedules');
    const research = await screen.findByRole('region', { name: 'Research' });
    const [weekly, monthly] = within(research).getAllByRole('listitem');
    expect(weekly).toHaveTextContent(`Every Monday at ${formatClock('09:00')}`);
    expect(weekly).toHaveTextContent('Set up by Ada');
    // Not your timezone: it says which.
    expect(monthly).toHaveTextContent(`On the 1st of every month at ${formatClock('08:30')} (Asia/Qatar)`);
    expect(monthly).toHaveTextContent('Paused');
    expect(monthly).toHaveTextContent('Set up by you');
  });

  it('sets one up from a frequency, days and a time, in your timezone', async () => {
    const created: unknown[] = [];
    server.use(
      http.post(api('/v1/schedules'), async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json(digest, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/schedules');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New schedule' }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    await user.type(within(dialog).getByLabelText('Title'), 'Weekly AI news digest');
    await user.type(within(dialog).getByLabelText('Brief'), 'The five most important releases.');
    await user.click(within(dialog).getByRole('combobox', { name: 'How often' }));
    await user.click(await screen.findByRole('option', { name: 'Every week' }));
    await user.click(within(dialog).getByRole('button', { name: 'Thursday' }));
    expect(within(within(dialog).getByRole('group', { name: 'When' })).getByRole('note')).toHaveTextContent(
      `Every Monday and Thursday at ${formatClock('09:00')} (Europe/Paris)`,
    );
    expect(within(within(dialog).getByRole('group', { name: 'When' })).getByRole('note')).toHaveTextContent(
      /Next: /,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Set up schedule' }));

    await waitFor(() =>
      expect(created).toEqual([
        {
          departmentId: research.id,
          title: 'Weekly AI news digest',
          brief: 'The five most important releases.',
          cron: '0 9 * * 1,4',
          timezone: 'Europe/Paris',
          priority: 'normal',
        },
      ]),
    );
    expect(await screen.findByText('Schedule set up')).toBeVisible();
  });

  it('won’t set one up that runs more often than every 5 minutes', async () => {
    const created: unknown[] = [];
    server.use(
      http.post(api('/v1/schedules'), async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json(digest, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/schedules?new=1');
    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText('Title'), 'Ping');
    await user.type(within(dialog).getByLabelText('Brief'), 'Check.');
    await user.click(within(dialog).getByRole('combobox', { name: 'How often' }));
    await user.click(await screen.findByRole('option', { name: 'Custom (cron)' }));
    // It starts from the cron the form made.
    const cron = within(dialog).getByLabelText('Cron');
    expect(cron).toHaveValue('0 9 * * 1-5');
    await user.clear(cron);
    await user.type(cron, '* * * * *');
    expect(within(within(dialog).getByRole('group', { name: 'When' })).getByRole('note')).toHaveTextContent(
      'A schedule can run at most every 5 minutes.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Set up schedule' }));
    expect(created).toEqual([]);
  });

  it('asks for a timezone when there is none', async () => {
    const created: unknown[] = [];
    server.use(
      http.post(api('/v1/schedules'), async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json(digest, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/schedules?new=1');
    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText('Title'), 'Digest');
    await user.type(within(dialog).getByLabelText('Brief'), 'Summarize.');
    await user.clear(within(dialog).getByLabelText('Timezone'));
    const when = within(within(dialog).getByRole('group', { name: 'When' })).getByRole('note');
    expect(when).toHaveTextContent('Choose a timezone.');
    await user.click(within(dialog).getByRole('button', { name: 'Set up schedule' }));
    expect(created).toEqual([]);
  });

  it('runs one now, pauses it, and deletes it', async () => {
    const made = task({ title: 'Weekly AI news digest', phase: 'queued' });
    const calls: string[] = [];
    server.use(
      http.post(api(`/v1/schedules/${digest.id}/run`), () => {
        calls.push('run');
        return HttpResponse.json(made, { status: 201 });
      }),
      http.patch(api(`/v1/schedules/${digest.id}`), async ({ request }) => {
        calls.push(`patch ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ ...digest, status: 'paused', nextFireAt: null });
      }),
      http.delete(api(`/v1/schedules/${digest.id}`), () => {
        calls.push('delete');
        return new HttpResponse(null, { status: 204 });
      }),
      ...signedInHandlers({ schedules: [digest] }),
    );
    renderApp('/departments/research?tab=schedules');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(`Task #${made.number} created`)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'More for “Weekly AI news digest”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    await waitFor(() => expect(calls).toEqual(['run', 'patch {"status":"paused"}']));

    await user.click(screen.getByRole('button', { name: 'More for “Weekly AI news digest”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await user.click(await screen.findByRole('button', { name: 'Delete schedule' }));
    await waitFor(() => expect(calls.at(-1)).toBe('delete'));
  });
});
