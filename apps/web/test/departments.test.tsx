import type { AgentDefinition, Department } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ada, api, research, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const scout: AgentDefinition = {
  ...ada,
  id: '0199a000-0000-7000-8000-0000000000b1',
  key: 'research-scout',
  name: 'Scout',
  role: 'specialist',
  current: { ...ada.current, description: 'Digs up sources.' },
};

const finance: Department = {
  ...research,
  id: '0199a000-0000-7000-8000-000000000002',
  slug: 'finance',
  name: 'Finance',
  description: 'Budgets and invoices.',
  lead: null,
};

describe('the departments', () => {
  it('shows each one with its lead, its specialists and its open work', async () => {
    server.use(
      http.get(api('/v1/departments'), () =>
        HttpResponse.json({
          items: [
            {
              ...research,
              members: [{ id: scout.id, key: scout.key, name: 'Scout', role: 'specialist', description: '' }],
            },
            finance,
            {
              ...finance,
              id: '0199a000-0000-7000-8000-000000000003',
              slug: 'old',
              name: 'Old',
              archivedAt: '2026-10-02T09:00:00.000Z',
            },
          ],
        }),
      ),
      http.get(api('/v1/agents'), () => HttpResponse.json({ items: [ada, scout] })),
      ...signedInHandlers({
        tasks: [task({ phase: 'working' }), task({ phase: 'done', closedAt: new Date().toISOString() })],
      }),
    );
    renderApp('/departments');
    const list = await screen.findByRole('list', { name: 'Departments' });
    const cards = within(list).getAllByRole('article');
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
      'Research',
      'Finance',
    ]);
    expect(cards[0]).toHaveTextContent(/Ada\s*leads/);
    expect(cards[0]).toHaveTextContent('1 open task');
    expect(cards[1]).toHaveTextContent('No lead yet');
    // Archived ones wait behind their own toggle.
    expect(screen.queryByText('Old')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '1 archived department' }));
    expect(screen.getByRole('link', { name: /old/i })).toHaveAttribute('href', '/departments/old');
  });

  it('sets one up, then opens its team to add a lead', async () => {
    const created: unknown[] = [];
    const market: Department = {
      ...finance,
      id: '0199a000-0000-7000-8000-000000000009',
      slug: 'market-research',
      name: 'Market Research',
    };
    const departments = [research];
    server.use(
      http.get(api('/v1/departments'), () => HttpResponse.json({ items: departments })),
      http.post(api('/v1/departments'), async ({ request }) => {
        created.push(await request.json());
        departments.push(market);
        return HttpResponse.json(market, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    const { router } = renderApp('/departments');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New department' }));
    const dialog = await screen.findByRole('dialog', { name: 'New department' });
    await user.type(within(dialog).getByLabelText('Name'), 'Market Research');
    expect(within(dialog).getByLabelText('Slug')).toHaveValue('market-research');
    await user.type(within(dialog).getByLabelText('What it’s for'), 'Sizes markets.');
    await user.click(within(dialog).getByRole('switch', { name: /close finished tasks/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Create department' }));

    await waitFor(() =>
      expect(created).toEqual([
        { name: 'Market Research', slug: 'market-research', description: 'Sizes markets.', autoClose: true },
      ]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/departments/market-research'));
    expect(router.state.location.search).toBe('?tab=team');
    expect(await screen.findByRole('button', { name: 'Add the lead' })).toBeVisible();
  });

  it('says so when the slug is taken', async () => {
    server.use(
      http.post(api('/v1/departments'), () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'department_slug_taken',
            detail: 'taken',
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
      ...signedInHandlers(),
    );
    renderApp('/departments?new=1');
    const dialog = await screen.findByRole('dialog', { name: 'New department' });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText('Name'), 'Research');
    await user.click(within(dialog).getByRole('button', { name: 'Create department' }));
    expect(await within(dialog).findByText('Another department has this slug.')).toBeVisible();
  });
});

describe('a department', () => {
  it('adds a specialist to its team, then opens its page', async () => {
    const created: Array<Record<string, unknown>> = [];
    const agents = [ada];
    server.use(
      http.get(api('/v1/agents'), () => HttpResponse.json({ items: agents })),
      http.post(api('/v1/agents'), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        created.push(body);
        const agent = { ...scout, key: String(body.key), name: String(body.name) };
        agents.push(agent);
        return HttpResponse.json(agent, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    const { router } = renderApp('/departments/research?tab=team');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add a specialist' }));
    const dialog = await screen.findByRole('dialog', { name: 'A specialist for Research' });
    // The department has a lead: only a specialist can be added.
    expect(within(dialog).queryByRole('group', { name: 'Role' })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Grace');
    expect(within(dialog).getByLabelText('Key')).toHaveValue('research-grace');
    await user.type(within(dialog).getByLabelText('What it’s good at'), 'Checks facts.');
    await user.type(within(dialog).getByLabelText('Instructions'), 'Two sources per fact.');
    await user.click(within(dialog).getByRole('button', { name: 'Add the specialist' }));

    await waitFor(() =>
      expect(created).toEqual([
        {
          departmentId: research.id,
          role: 'specialist',
          key: 'research-grace',
          name: 'Grace',
          description: 'Checks facts.',
          instructions: 'Two sources per fact.',
        },
      ]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/research-grace'));
  });

  it('saves its settings, and archives only once it has no agents', async () => {
    const patches: unknown[] = [];
    server.use(
      http.patch(api(`/v1/departments/${research.id}`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        patches.push(body);
        return HttpResponse.json({ ...research, ...body, updatedAt: new Date().toISOString() });
      }),
      ...signedInHandlers(),
    );
    renderApp('/departments/research?tab=settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: /close finished tasks/i }));
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toEqual([{ autoClose: true }]));
    expect(screen.getByText('Archive its agents first: Ada.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
  });

  it('keeps settings changed elsewhere while you edit, and saves only yours', async () => {
    let current = research;
    const patches: unknown[] = [];
    server.use(
      http.get(api('/v1/departments'), () => HttpResponse.json({ items: [current] })),
      http.patch(api(`/v1/departments/${research.id}`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        patches.push(body);
        current = { ...current, ...body, updatedAt: new Date().toISOString() };
        return HttpResponse.json(current);
      }),
      ...signedInHandlers(),
    );
    const { queryClient } = renderApp('/departments/research?tab=settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: /close finished tasks/i }));

    // Its purpose is rewritten on another device.
    current = { ...research, description: 'Finds and checks things.', updatedAt: '2026-10-08T12:00:00.000Z' };
    await queryClient.invalidateQueries({ queryKey: ['departments'] });
    expect(await screen.findByText('Research changed while you were editing')).toBeVisible();
    expect(screen.getByLabelText('What it’s for')).toHaveValue('Finds and checks things.');

    await user.click(
      within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => expect(patches).toEqual([{ autoClose: true }]));
  });

  it('opens a new department at once, before the list comes back', async () => {
    const market: Department = {
      ...finance,
      id: '0199a000-0000-7000-8000-000000000009',
      slug: 'market',
      name: 'Market',
    };
    let created = false;
    server.use(
      http.get(api('/v1/departments'), async () => {
        // The list is slow to come back once the department exists.
        if (created) await new Promise((resolve) => setTimeout(resolve, 3_000));
        return HttpResponse.json({ items: created ? [research, market] : [research] });
      }),
      http.post(api('/v1/departments'), () => {
        created = true;
        return HttpResponse.json(market, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/departments?new=1');
    const dialog = await screen.findByRole('dialog', { name: 'New department' });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText('Name'), 'Market');
    await user.click(within(dialog).getByRole('button', { name: 'Create department' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Market' }, { timeout: 1000 })).toBeVisible();
    expect(screen.queryByText('No such department')).not.toBeInTheDocument();
  });

  it('writes the first notes over empty ones without seeing a conflict', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get(api(`/v1/departments/${research.id}/memory`), () =>
        HttpResponse.json({ departmentId: research.id, notes: '' }),
      ),
      http.put(api(`/v1/departments/${research.id}/memory`), async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({ departmentId: research.id, notes: '- Short answers.' });
      }),
      ...signedInHandlers(),
    );
    renderApp('/departments/research?tab=notes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Write the first notes' }));
    await user.type(screen.getByLabelText('Research’s notes'), '- Short answers.');
    await user.click(screen.getByRole('button', { name: 'Save notes' }));
    await waitFor(() => expect(saved).toEqual([{ notes: '- Short answers.' }]));
    expect(screen.queryByText(/changed these notes/)).not.toBeInTheDocument();
  });

  it('saves notes you corrected, unless its lead changed them meanwhile', async () => {
    let notes: string | null = '- Cite sources.';
    const saved: unknown[] = [];
    server.use(
      http.get(api(`/v1/departments/${research.id}/memory`), () =>
        HttpResponse.json({ departmentId: research.id, notes }),
      ),
      http.put(api(`/v1/departments/${research.id}/memory`), async ({ request }) => {
        const body = (await request.json()) as { notes: string };
        saved.push(body);
        notes = body.notes;
        return HttpResponse.json({ departmentId: research.id, notes });
      }),
      ...signedInHandlers(),
    );
    renderApp('/departments/research?tab=notes');
    const user = userEvent.setup();
    expect(await screen.findByText('Cite sources.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByLabelText('Research’s notes');
    expect(editor).toHaveFocus();
    await user.type(editor, '\n- Keep it short.');

    // Ada saved a note while you typed.
    notes = '- Cite sources.\n- Prefer papers.';
    await user.click(screen.getByRole('button', { name: 'Save notes' }));
    expect(await screen.findByText('Ada changed these notes while you were editing')).toBeVisible();
    expect(saved).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Replace with mine' }));
    await waitFor(() => expect(saved).toEqual([{ notes: '- Cite sources.\n- Keep it short.' }]));
    expect(await screen.findByText('Keep it short.')).toBeVisible();
  });
});
