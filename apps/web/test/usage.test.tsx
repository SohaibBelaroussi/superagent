import type { UsageGroup, UsageReport } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { fillDays, rangeStart } from '../src/features/usage/usage-page';
import { addDays, dayIn } from '../src/lib/timezones';
import { api, NO_USAGE, research, SETTINGS, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const TASK_ID = '0199b000-0000-7000-8000-000000000012';

const used = (costUsd: number, totalTokens: number, calls: number, unpricedCalls = 0) => ({
  ...NO_USAGE,
  inputTokens: totalTokens - 100,
  outputTokens: 100,
  totalTokens,
  costUsd,
  calls,
  unpricedCalls,
});

/** What the API reports for a group: today and yesterday (the owner's days), and what made the calls. */
function report(group: UsageGroup, from: string | null): UsageReport {
  const today = dayIn(new Date(), SETTINGS.timezone);
  const items: Record<UsageGroup, UsageReport['items']> = {
    day: [
      { key: addDays(today, -1), label: addDays(today, -1), ...used(0.12, 4_000, 2) },
      { key: today, label: today, ...used(0.3, 8_300, 2, 1) },
    ],
    department: [
      { key: research.id, label: 'Research', ...used(0.4, 11_000, 3) },
      { key: null, label: 'Outside tasks', ...used(0.02, 1_300, 1, 1) },
    ],
    model: [{ key: 'acme/large-1', label: 'acme/large-1', ...used(0.42, 12_300, 4, 1) }],
    agent: [
      { key: 'research-lead', label: 'research-lead', ...used(0.4, 11_000, 3) },
      { key: 'chief', label: 'chief', ...used(0.02, 1_000, 1) },
      { key: 'provider-test-tools', label: 'provider-test-tools', ...used(0, 300, 1, 1) },
    ],
    task: [{ key: TASK_ID, label: '#12 Find a venue', ...used(0.4, 11_000, 3) }],
  };
  return { group, from, to: null, items: items[group], total: used(0.42, 12_300, 4, 1) };
}

/** Answers each usage query, noting what was asked: [group, from]. */
function usageHandler(asked: Array<[string | null, string | null]>, answer = report) {
  return http.get(api('/v1/usage'), ({ request }) => {
    const params = new URL(request.url).searchParams;
    asked.push([params.get('group'), params.get('from')]);
    return HttpResponse.json(answer((params.get('group') ?? 'department') as UsageGroup, params.get('from')));
  });
}

describe('usage periods', () => {
  it('start at the start of the owner’s day, today counted as one of their days', () => {
    const now = new Date('2026-10-08T10:00:00Z');
    expect(rangeStart('7', 'Europe/Paris', now)).toBe('2026-10-01T22:00:00.000Z');
    expect(rangeStart('30', 'Asia/Tokyo', now)).toBe('2026-09-08T15:00:00.000Z');
    expect(rangeStart('all', 'Europe/Paris', now)).toBeUndefined();
    // Already tomorrow in Paris.
    expect(rangeStart('7', 'Europe/Paris', new Date('2026-10-08T23:30:00Z'))).toBe(
      '2026-10-02T22:00:00.000Z',
    );
  });

  it('give every day a slot, from the period’s first to today', () => {
    expect(fillDays(['2026-10-05'], '2026-10-02', '2026-10-05')).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
    // All time starts at the first day with calls.
    expect(fillDays(['2026-10-07', '2026-10-05'], undefined, '2026-10-08')).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ]);
    // A day with calls outside the period still shows.
    expect(fillDays(['2026-10-01'], '2026-10-02', '2026-10-02')).toEqual(['2026-10-01', '2026-10-02']);
    expect(fillDays([], '2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});

describe('the usage page', () => {
  it('adds up the period by day, in the owner’s days, and by what made the calls', async () => {
    const asked: Array<[string | null, string | null]> = [];
    server.use(usageHandler(asked), ...signedInHandlers());
    const { router } = renderApp('/usage');
    const user = userEvent.setup();

    const chart = await screen.findByRole('list', { name: 'Cost by day' });
    // The totals: each a term and its value.
    const total = (label: string) =>
      screen.getAllByRole('term').find((term) => term.textContent === label)?.nextElementSibling;
    expect(total('Cost')).toHaveTextContent('$0.42');
    expect(total('Model calls')).toHaveTextContent('4');
    // Thirty days, today last, each day its own bar.
    const bars = within(chart).getAllByRole('listitem');
    expect(bars).toHaveLength(30);
    expect(bars.at(-1)).toHaveTextContent('$0.30');
    expect(bars.at(-2)).toHaveTextContent('$0.12');
    expect(bars[0]).toHaveTextContent('$0');
    // Asked once, from the start of the owner's day 29 days ago (the settings' timezone).
    expect(asked.filter(([group]) => group === 'day')).toEqual([
      ['day', rangeStart('30', SETTINGS.timezone)],
    ]);

    await user.click(screen.getByRole('button', { name: 'Tokens' }));
    expect(
      within(screen.getByRole('list', { name: 'Tokens by day' }))
        .getAllByRole('listitem')
        .at(-1),
    ).toHaveTextContent('8.3k tokens');

    expect(screen.getByText(/1 call went to models without a price/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Set prices' })).toHaveAttribute('href', '/settings/models');

    const departments = await screen.findByRole('list', { name: 'By department' });
    expect(within(departments).getByRole('link', { name: 'Research' })).toHaveAttribute(
      'href',
      '/departments/research',
    );
    expect(departments).toHaveTextContent('Outside tasks');
    // Agents by name; the built-in ones too.
    const agents = await screen.findByRole('list', { name: 'By agent' });
    expect(within(agents).getByRole('link', { name: 'Ada' })).toHaveAttribute(
      'href',
      '/agents/research-lead',
    );
    expect(agents).toHaveTextContent('Chief of staff');
    expect(agents).toHaveTextContent('Provider test (tools)');
    expect(agents).not.toHaveTextContent('provider-test');
    const tasks = await screen.findByRole('list', { name: 'By task' });
    expect(within(tasks).getByRole('link', { name: '#12 Find a venue' })).toHaveAttribute(
      'href',
      `/tasks/${TASK_ID}`,
    );

    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(router.state.location.search).toBe('?range=7'));
    expect(
      within(await screen.findByRole('list', { name: 'Cost by day' })).getAllByRole('listitem'),
    ).toHaveLength(7);
    await waitFor(() => expect(asked).toContainEqual(['agent', rangeStart('7', SETTINGS.timezone)]));
  });

  it('starts all time at the first day with calls', async () => {
    const asked: Array<[string | null, string | null]> = [];
    server.use(usageHandler(asked), ...signedInHandlers());
    renderApp('/usage?range=all');
    const chart = await screen.findByRole('list', { name: 'Cost by day' });
    expect(within(chart).getAllByRole('listitem')).toHaveLength(2);
    expect(asked).toContainEqual(['day', null]);
  });

  it('says so before there are any calls', async () => {
    server.use(
      usageHandler([], (group, from) => ({ group, from, to: null, items: [], total: NO_USAGE })),
      ...signedInHandlers(),
    );
    renderApp('/usage');
    expect(await screen.findByText('No model calls yet')).toBeVisible();
  });
});
