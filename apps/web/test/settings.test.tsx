import type { Provider, ProviderModel, ProviderTestResult, Settings } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, SETTINGS, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const acme: Provider = {
  id: '0199d000-0000-7000-8000-000000000001',
  slug: 'acme',
  name: 'Acme',
  baseUrl: 'https://api.acme.test/v1',
  hasApiKey: true,
  secretsReadable: true,
  headerNames: [],
  strictJson: false,
  enabled: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

const large: ProviderModel = {
  modelId: 'large-1',
  kind: 'chat',
  source: 'discovered',
  enabled: true,
  discoveredAt: '2026-10-01T09:00:00.000Z',
  ref: 'sa/acme/large-1',
  price: { inputUsd: 2, cachedInputUsd: null, outputUsd: 8 },
};
const small: ProviderModel = { ...large, modelId: 'small-1', ref: 'sa/acme/small-1', price: null };
const embed: ProviderModel = {
  ...large,
  modelId: 'embed-1',
  kind: 'embedding',
  ref: 'sa/acme/embed-1',
  price: null,
};

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Refused', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** Acme with its three models, and the settings, which PATCH updates (each body noted). */
function modelHandlers(sent: { settings?: unknown[] } = {}) {
  let settings: Settings = SETTINGS;
  return [
    http.get(api('/v1/providers'), () => HttpResponse.json({ items: [acme] })),
    http.get(api('/v1/providers/:id/models'), () => HttpResponse.json({ items: [large, small, embed] })),
    http.get(api('/v1/settings'), () => HttpResponse.json(settings)),
    http.patch(api('/v1/settings'), async ({ request }) => {
      const body = (await request.json()) as Partial<Settings>;
      sent.settings?.push(body);
      settings = { ...settings, ...body, models: { ...settings.models, ...body.models } };
      return HttpResponse.json(settings);
    }),
  ];
}

describe('settings', () => {
  it('opens on the models, with every section beside it', async () => {
    server.use(...modelHandlers(), ...signedInHandlers());
    const { router } = renderApp('/settings');
    // The page is on screen once the redirect has rendered.
    expect(await screen.findByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
    expect(router.state.location.pathname).toBe('/settings/models');
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
    for (const section of [
      'General',
      'Your profile',
      'Devices',
      'Secrets',
      'MCP servers',
      'Plugins',
      'Skills',
    ])
      expect(within(nav).getByRole('link', { name: section })).toBeVisible();
  });
});

describe('models', () => {
  it('lists each provider’s models with their prices, and sets the roles as you pick them', async () => {
    const sent = { settings: [] as unknown[] };
    server.use(...modelHandlers(sent), ...signedInHandlers());
    renderApp('/settings/models');
    const user = userEvent.setup();

    const panel = await screen.findByRole('group', { name: /Acme/ });
    expect(panel).toHaveTextContent('https://api.acme.test/v1');
    expect(panel).toHaveTextContent('Key set');
    const [first, second, third] = within(
      await within(panel).findByRole('list', { name: 'Models' }),
    ).getAllByRole('listitem');
    expect(first).toHaveTextContent('large-1');
    expect(first).toHaveTextContent('$2.00 in · $8.00 out per M');
    expect(second).toHaveTextContent('No price');
    expect(third).toHaveTextContent('embedding');

    expect(screen.getByRole('combobox', { name: 'Default model' })).toHaveTextContent('Acme · large-1');
    await user.click(screen.getByRole('combobox', { name: 'Fast model' }));
    await user.click(await screen.findByRole('option', { name: 'Acme · small-1' }));
    await waitFor(() =>
      expect(sent.settings).toEqual([{ models: { fast: { provider: 'acme', model: 'small-1' } } }]),
    );
    expect(await screen.findByText('Fast model: small-1')).toBeVisible();

    // Only embedding models can be the embedding model.
    await user.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    expect(await screen.findByRole('option', { name: 'Acme · embed-1' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Acme · large-1' })).toBeNull();
  });

  it('tests a provider and says what works and what doesn’t', async () => {
    const tests: unknown[] = [];
    const result: ProviderTestResult = {
      ok: false,
      model: 'large-1',
      embeddingModel: 'embed-1',
      checks: [
        { name: 'chat', ok: true, ms: 420 },
        { name: 'stream', ok: true, ms: 380 },
        { name: 'tools', ok: false, ms: 912, error: 'It answered without calling the tool.' },
        { name: 'embedding', ok: true, ms: 120 },
      ],
    };
    server.use(
      http.post(api('/v1/providers/:id/test'), async ({ request }) => {
        tests.push(await request.json());
        return HttpResponse.json(result);
      }),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    const panel = await screen.findByRole('group', { name: /Acme/ });
    await within(panel).findByRole('list', { name: 'Models' });
    await user.click(within(panel).getByRole('button', { name: 'Test' }));

    const verdict = await within(panel).findByRole('status');
    expect(verdict).toHaveTextContent('It answers, but not everything works with large-1');
    expect(verdict).toHaveTextContent('Tool calls · fails · 912 ms');
    expect(verdict).toHaveTextContent('It answered without calling the tool.');
    expect(verdict).toHaveTextContent('Embeddings · works');
    // Its embedding model is checked too.
    expect(tests).toEqual([{ embeddingModel: 'embed-1' }]);
  });

  it('prices a model from now on', async () => {
    const prices: unknown[] = [];
    server.use(
      http.put(api('/v1/providers/:id/prices'), async ({ request }) => {
        prices.push(await request.json());
        return HttpResponse.json({
          items: [large, { ...small, price: { inputUsd: 0.5, cachedInputUsd: null, outputUsd: 1.5 } }, embed],
        });
      }),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    const models = await screen.findByRole('list', { name: 'Models' });
    const row = within(models).getAllByRole('listitem')[1] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Set price of small-1' }));

    const dialog = await screen.findByRole('dialog', { name: 'Price of small-1' });
    await user.type(within(dialog).getByLabelText('Input'), '0.5');
    await user.type(within(dialog).getByLabelText('Output'), '1.5');
    await user.click(within(dialog).getByRole('button', { name: 'Save price' }));
    await waitFor(() => expect(prices).toEqual([{ modelId: 'small-1', inputUsd: 0.5, outputUsd: 1.5 }]));
    await waitFor(() => expect(row).toHaveTextContent('$0.50 in · $1.50 out'));
  });

  it('removes a price, and each model’s dialog starts from its own price', async () => {
    const removed: Array<string | null> = [];
    server.use(
      http.delete(api('/v1/providers/:id/prices'), ({ request }) => {
        removed.push(new URL(request.url).searchParams.get('modelId'));
        return new HttpResponse(null, { status: 204 });
      }),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    const models = await screen.findByRole('list', { name: 'Models' });

    await user.click(within(models).getByRole('button', { name: 'Change price of large-1' }));
    let dialog = await screen.findByRole('dialog', { name: 'Price of large-1' });
    expect(within(dialog).getByLabelText('Input')).toHaveValue(2);
    expect(within(dialog).getByLabelText('Output')).toHaveValue(8);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(models).getByRole('button', { name: 'Set price of small-1' }));
    dialog = await screen.findByRole('dialog', { name: 'Price of small-1' });
    expect(within(dialog).getByLabelText('Input')).toHaveValue(null);
    expect(within(dialog).queryByRole('button', { name: 'Remove price' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(models).getByRole('button', { name: 'Change price of large-1' }));
    dialog = await screen.findByRole('dialog', { name: 'Price of large-1' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(removed).toEqual(['large-1']));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows prices to the hundredth of a cent', async () => {
    server.use(
      http.get(api('/v1/providers/:id/models'), () =>
        HttpResponse.json({
          items: [{ ...small, price: { inputUsd: 0.075, cachedInputUsd: null, outputUsd: 0.3 } }],
        }),
      ),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    expect(await screen.findByRole('list', { name: 'Models' })).toHaveTextContent('$0.075 in · $0.30 out');
  });

  it('looks for a provider’s new models, and says when it can’t', async () => {
    let answer: 'list' | 'fail' = 'list';
    server.use(
      http.post(api('/v1/providers/:id/refresh-models'), () =>
        answer === 'list'
          ? HttpResponse.json({ items: [large, small, embed, { ...small, modelId: 'small-2' }] })
          : problem(502, 'The provider answered 500.'),
      ),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    const panel = await screen.findByRole('group', { name: /Acme/ });
    await within(panel).findByRole('list', { name: 'Models' });

    await user.click(within(panel).getByRole('button', { name: 'More for Acme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Look for new models' }));
    expect(await screen.findByText('4 models listed')).toBeVisible();
    await waitFor(() =>
      expect(within(panel).getByRole('list', { name: 'Models' })).toHaveTextContent('small-2'),
    );

    answer = 'fail';
    await user.click(within(panel).getByRole('button', { name: 'More for Acme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Look for new models' }));
    expect(await screen.findByText('Couldn’t list its models')).toBeVisible();
    expect(screen.getByText('The provider answered 500.')).toBeVisible();
  });

  it('adds a provider, then lists its models', async () => {
    const created: unknown[] = [];
    const local: Provider = {
      ...acme,
      id: '0199d000-0000-7000-8000-000000000002',
      slug: 'local-models',
      name: 'Local models',
      baseUrl: 'http://10.0.0.5:8000/v1',
    };
    let listed = 0;
    server.use(
      http.post(api('/v1/providers'), async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json(local, { status: 201 });
      }),
      http.post(api(`/v1/providers/${local.id}/refresh-models`), () => {
        listed++;
        return HttpResponse.json({ items: [large, small] });
      }),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a provider' });
    await user.type(within(dialog).getByLabelText('Name'), 'Local models');
    // The slug follows the name until it is edited.
    expect(within(dialog).getByLabelText('Slug')).toHaveValue('local-models');
    await user.type(within(dialog).getByLabelText('Base URL'), 'http://10.0.0.5:8000/v1');
    await user.type(within(dialog).getByLabelText('API key'), 'not-a-real-key');
    await user.click(within(dialog).getByRole('button', { name: 'Add a header' }));
    await user.type(within(dialog).getByLabelText('Header 1 name'), 'X-Org-Id');
    await user.type(within(dialog).getByLabelText('Header 1 value'), 'org-7');
    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));

    await waitFor(() =>
      expect(created).toEqual([
        {
          slug: 'local-models',
          name: 'Local models',
          baseUrl: 'http://10.0.0.5:8000/v1',
          apiKey: 'not-a-real-key',
          headers: { 'X-Org-Id': 'org-7' },
          strictJson: false,
          enabled: true,
        },
      ]),
    );
    expect(await screen.findByText('2 models found.')).toBeVisible();
    expect(listed).toBe(1);
  });

  it('checks the form, and says when the slug is taken', async () => {
    server.use(
      http.post(api('/v1/providers'), () => problem(409, 'provider_slug_taken')),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a provider' });
    await user.type(within(dialog).getByLabelText('Name'), 'Acme');
    await user.type(within(dialog).getByLabelText('Base URL'), 'api.acme.test');
    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    expect(within(dialog).getByLabelText('Base URL')).toHaveAccessibleDescription(
      'An http(s) address, usually ending in /v1.',
    );

    await user.clear(within(dialog).getByLabelText('Base URL'));
    await user.type(within(dialog).getByLabelText('Base URL'), 'https://api.acme.test/v1');
    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Slug')).toHaveAccessibleDescription(
        'Another provider has this slug.',
      ),
    );
  });

  it('edits a provider, sending only what changed and never its key back', async () => {
    const updates: unknown[] = [];
    server.use(
      http.patch(api(`/v1/providers/${acme.id}`), async ({ request }) => {
        updates.push(await request.json());
        return HttpResponse.json({ ...acme, name: 'Acme Cloud', hasApiKey: false });
      }),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    const panel = await screen.findByRole('group', { name: /Acme/ });
    await user.click(within(panel).getByRole('button', { name: 'More for Acme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit Acme' });
    expect(within(dialog).getByLabelText('Slug')).toBeDisabled();
    expect(within(dialog).getByLabelText('API key')).toHaveValue('');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Acme Cloud');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Remove its key' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updates).toEqual([{ name: 'Acme Cloud', apiKey: null }]));
  });

  it('deletes a provider after asking', async () => {
    let deleted = 0;
    let modelLists = 0;
    let providers = [acme];
    server.use(
      http.delete(api(`/v1/providers/${acme.id}`), () => {
        deleted++;
        providers = [];
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(api('/v1/providers'), () => HttpResponse.json({ items: providers })),
      http.get(api('/v1/providers/:id/models'), () => {
        modelLists++;
        return HttpResponse.json({ items: [large] });
      }),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    const user = userEvent.setup();
    const panel = await screen.findByRole('group', { name: /Acme/ });
    await within(panel).findByRole('list', { name: 'Models' });
    const before = modelLists;
    await user.click(within(panel).getByRole('button', { name: 'More for Acme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Acme?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete provider' }));

    expect(await screen.findByText('No providers yet')).toBeVisible();
    expect(deleted).toBe(1);
    // Its models aren't asked for again.
    expect(modelLists).toBe(before);
  });

  it('warns when a provider’s key can’t be read any more', async () => {
    server.use(
      http.get(api('/v1/providers'), () =>
        HttpResponse.json({ items: [{ ...acme, secretsReadable: false }] }),
      ),
      ...modelHandlers(),
      ...signedInHandlers(),
    );
    renderApp('/settings/models');
    expect(await screen.findByText('Its key can’t be read')).toBeVisible();
  });
});

describe('general settings', () => {
  it('saves the timezone, and won’t save one this browser doesn’t know', async () => {
    const sent = { settings: [] as unknown[] };
    server.use(...modelHandlers(sent), ...signedInHandlers());
    renderApp('/settings/general');
    const user = userEvent.setup();
    const timezone = await screen.findByLabelText('Timezone');
    expect(timezone).toHaveValue('Europe/Paris');

    await user.clear(timezone);
    await user.type(timezone, 'Mars/Olympus');
    expect(timezone).toHaveAccessibleDescription('Not a timezone this browser knows.');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    expect(sent.settings).toEqual([]);

    await user.clear(timezone);
    await user.type(timezone, 'Asia/Tokyo');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent.settings).toEqual([{ timezone: 'Asia/Tokyo' }]));
    expect(await screen.findByText('Timezone saved')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull());
  });

  it('switches the theme in this browser', async () => {
    server.use(...modelHandlers(), ...signedInHandlers());
    renderApp('/settings/general');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dark' }));
    expect(document.documentElement).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });
});
