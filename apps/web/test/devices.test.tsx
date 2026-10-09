import type { TokenRecord } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, api, DEVICE_TOKEN, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const record = (overrides: Partial<TokenRecord>): TokenRecord => ({
  id: 'device-1',
  name: 'Web: Chrome on Windows',
  prefix: 'sa_device_dd',
  createdAt: '2026-10-01T09:00:00.000Z',
  lastUsedAt: '2026-10-08T08:00:00.000Z',
  revokedAt: null,
  ...overrides,
});

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Refused', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const NEW_TOKEN = `sa_device_${'n'.repeat(40)}`;
const PAIR_CODE = `sa_pair_${'p'.repeat(43)}`;

/**
 * The pairing routes, before the token routes: each code works for 10 minutes, the first one for
 * `firstExpiresInMs` if given (to watch one run out). Withdrawals are counted.
 */
function pairingHandlers(state: { made: number; withdrawn: number }, firstExpiresInMs?: number) {
  return [
    http.delete(api('/v1/tokens/pairing'), ({ request }) => {
      if (request.headers.get('authorization') !== `Bearer ${ADMIN_TOKEN}`)
        return problem(403, 'Admin only.');
      state.withdrawn += 1;
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(api('/v1/tokens/pairing'), ({ request }) => {
      if (request.headers.get('authorization') !== `Bearer ${ADMIN_TOKEN}`)
        return problem(403, 'Admin only.');
      state.made += 1;
      const ms = state.made === 1 && firstExpiresInMs !== undefined ? firstExpiresInMs : 10 * 60_000;
      return HttpResponse.json(
        {
          code: `${PAIR_CODE.slice(0, -1)}${state.made}`,
          expiresAt: new Date(Date.now() + ms).toISOString(),
        },
        { status: 201 },
      );
    }),
  ];
}

/** The token routes, which take only the admin token; what reaches them is noted. */
function tokenHandlers(seen: { auth: string[]; created: unknown[]; revoked: string[] }) {
  let tokens = [
    record({}),
    record({ id: 'device-2', name: 'Phone', prefix: 'sa_device_ph', lastUsedAt: null }),
    record({ id: 'device-3', name: 'Old laptop', revokedAt: '2026-10-05T09:00:00.000Z' }),
  ];
  const refusal = (request: Request) => {
    const auth = request.headers.get('authorization') ?? '';
    seen.auth.push(auth);
    if (auth === `Bearer ${DEVICE_TOKEN}`) return problem(403, 'Takes the admin token.');
    if (auth !== `Bearer ${ADMIN_TOKEN}`) return problem(401, 'Unknown token.');
    return null;
  };
  return [
    http.get(api('/v1/tokens'), ({ request }) => refusal(request) ?? HttpResponse.json({ items: tokens })),
    http.post(api('/v1/tokens'), async ({ request }) => {
      const refused = refusal(request);
      if (refused) return refused;
      const body = (await request.json()) as { name: string };
      seen.created.push(body);
      const created = record({ id: 'device-4', name: body.name, prefix: 'sa_device_nn', lastUsedAt: null });
      tokens = [...tokens, created];
      return HttpResponse.json({ token: NEW_TOKEN, record: created }, { status: 201 });
    }),
    http.delete(api('/v1/tokens/:id'), ({ request, params }) => {
      const refused = refusal(request);
      if (refused) return refused;
      seen.revoked.push(String(params.id));
      tokens = tokens.map((token) =>
        token.id === params.id ? { ...token, revokedAt: '2026-10-08T10:00:00.000Z' } : token,
      );
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

describe('devices', () => {
  it('lists the devices with the admin token, after a refused one, and keeps it in the page only', async () => {
    const seen = { auth: [] as string[], created: [] as unknown[], revoked: [] as string[] };
    server.use(...tokenHandlers(seen), ...signedInHandlers());
    renderApp('/settings/devices');
    const user = userEvent.setup();

    // Nothing is asked for until there is an admin token.
    const field = await screen.findByLabelText('Admin token');
    expect(seen.auth).toEqual([]);
    await user.type(field, DEVICE_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Show devices' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Admin token')).toHaveAccessibleDescription(
        'That’s a device token. Managing devices takes the admin token.',
      ),
    );

    // Another token is asked about afresh.
    await user.clear(screen.getByLabelText('Admin token'));
    await user.type(screen.getByLabelText('Admin token'), ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Show devices' }));
    const devices = await screen.findByRole('list', { name: 'Devices' });
    const [mine, phone] = within(devices).getAllByRole('listitem');
    expect(mine).toHaveTextContent('Web: Chrome on Windows');
    expect(mine).toHaveTextContent('This browser');
    expect(phone).toHaveTextContent('Phone');
    expect(phone).toHaveTextContent('Never used');
    expect(screen.getByRole('region', { name: 'Revoked' })).toHaveTextContent('Old laptop');
    expect(seen.auth).toEqual([`Bearer ${DEVICE_TOKEN}`, `Bearer ${ADMIN_TOKEN}`]);
    // Only the session's device token is kept in the browser.
    expect(Object.values({ ...window.localStorage }).join(' ')).not.toContain(ADMIN_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Forget the admin token' }));
    expect(await screen.findByLabelText('Admin token')).toHaveValue('');
    expect(screen.queryByRole('list', { name: 'Devices' })).toBeNull();
  });

  it('refuses an unknown token without signing this browser out', async () => {
    const seen = { auth: [] as string[], created: [] as unknown[], revoked: [] as string[] };
    server.use(...tokenHandlers(seen), ...signedInHandlers());
    const { router } = renderApp('/settings/devices');
    const user = userEvent.setup();
    const field = await screen.findByLabelText('Admin token');
    // Not a password field: browsers would offer to save the admin token (D45).
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAttribute('data-1p-ignore');
    await user.type(field, `sa_admin_${'x'.repeat(40)}`);
    await user.click(screen.getByRole('button', { name: 'Show devices' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Admin token')).toHaveAccessibleDescription(
        'The server doesn’t know that token.',
      ),
    );
    expect(router.state.location.pathname).toBe('/settings/devices');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect(window.localStorage.getItem('superagent.token')).toBe(DEVICE_TOKEN);
  });

  it('makes a token for another device and shows it once', async () => {
    const seen = { auth: [] as string[], created: [] as unknown[], revoked: [] as string[] };
    server.use(...tokenHandlers(seen), ...signedInHandlers());
    renderApp('/settings/devices');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Admin token'), ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Show devices' }));
    await screen.findByRole('list', { name: 'Devices' });

    await user.click(screen.getByRole('button', { name: 'New device token' }));
    const dialog = await screen.findByRole('dialog', { name: 'New device token' });
    await user.type(within(dialog).getByLabelText('Device'), 'Tablet');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));

    const shown = await screen.findByRole('dialog', { name: 'Copy it now' });
    expect(within(shown).getByLabelText('Its token')).toHaveValue(NEW_TOKEN);
    expect(seen.created).toEqual([{ name: 'Tablet' }]);
    expect(seen.auth.at(-2)).toBe(`Bearer ${ADMIN_TOKEN}`);
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    expect(await within(screen.getByRole('list', { name: 'Devices' })).findByText('Tablet')).toBeVisible();
    expect(screen.queryByDisplayValue(NEW_TOKEN)).toBeNull();
  });

  it('revokes a device after asking, and warns when it is this browser', async () => {
    const seen = { auth: [] as string[], created: [] as unknown[], revoked: [] as string[] };
    server.use(...tokenHandlers(seen), ...signedInHandlers());
    renderApp('/settings/devices');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Admin token'), ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Show devices' }));
    const [mine, phone] = within(await screen.findByRole('list', { name: 'Devices' })).getAllByRole(
      'listitem',
    );

    await user.click(
      within(mine as HTMLElement).getByRole('button', { name: 'Revoke Web: Chrome on Windows' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Revoke “Web: Chrome on Windows”?' })).toHaveTextContent(
      'It’s this browser’s token: this browser signs out.',
    );
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    await user.click(within(phone as HTMLElement).getByRole('button', { name: 'Revoke Phone' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke “Phone”?' });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('“Phone” revoked')).toBeVisible();
    expect(seen.revoked).toEqual(['device-2']);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Revoked' })).toHaveTextContent('Phone'));
  });

  it('pairs a phone with a QR code or a link, and sees it arrive', async () => {
    const seen = { auth: [] as string[], created: [] as unknown[], revoked: [] as string[] };
    const pairing = { made: 0, withdrawn: 0 };
    const tokens = tokenHandlers(seen);
    let phoneClaimed = false;
    server.use(
      ...pairingHandlers(pairing),
      // The phone claims its token while the dialog is open: the list then has it.
      http.get(api('/v1/tokens'), () => {
        if (!phoneClaimed) return undefined;
        return HttpResponse.json({
          items: [
            record({}),
            record({
              id: 'device-9',
              name: 'App: Pixel 9, Android 16',
              prefix: 'sa_device_p9',
              lastUsedAt: null,
            }),
          ],
        });
      }),
      ...tokens,
      ...signedInHandlers(),
    );
    renderApp('/settings/devices');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Admin token'), ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Show devices' }));
    await screen.findByRole('list', { name: 'Devices' });

    await user.click(screen.getByRole('button', { name: 'Pair a phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pair a phone' });
    expect(
      await within(dialog).findByRole('img', { name: 'Pairing code for the superagent app' }),
    ).toBeVisible();
    const link = within(dialog).getByLabelText('Or open this link on the phone');
    const code = `${PAIR_CODE.slice(0, -1)}1`;
    expect(link).toHaveValue(
      `superagent://pair?server=${encodeURIComponent(window.location.origin)}&code=${encodeURIComponent(code)}`,
    );
    expect(dialog).toHaveTextContent(/Expires in (10:00|9:5d)/);
    expect(pairing.made).toBe(1);

    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe((link as HTMLInputElement).value);

    phoneClaimed = true;
    const paired = await screen.findByRole('dialog', { name: 'Phone paired' }, { timeout: 5_000 });
    expect(paired).toHaveTextContent('“App: Pixel 9, Android 16” is signed in.');
    await user.click(within(paired).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByDisplayValue(new RegExp(code))).toBeNull();
    // Closing the dialog ends the code on the server too.
    await waitFor(() => expect(pairing.withdrawn).toBe(1));
    expect(
      within(screen.getByRole('list', { name: 'Devices' })).getByText('App: Pixel 9, Android 16'),
    ).toBeVisible();
    expect(pairing.made).toBe(1);
  });

  it('offers a new code once one has expired', async () => {
    const seen = { auth: [] as string[], created: [] as unknown[], revoked: [] as string[] };
    const pairing = { made: 0, withdrawn: 0 };
    server.use(...pairingHandlers(pairing, 1_500), ...tokenHandlers(seen), ...signedInHandlers());
    renderApp('/settings/devices');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Admin token'), ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Show devices' }));
    await screen.findByRole('list', { name: 'Devices' });

    await user.click(screen.getByRole('button', { name: 'Pair a phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pair a phone' });
    expect(await within(dialog).findByText('This code has expired.', {}, { timeout: 4_000 })).toBeVisible();
    expect(within(dialog).queryByRole('img')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Make a new code' }));
    expect(
      await within(dialog).findByRole('img', { name: 'Pairing code for the superagent app' }),
    ).toBeVisible();
    expect(pairing.made).toBe(2);
  });
});
