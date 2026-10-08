import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { deviceName, TOKEN_KEY } from '../src/api/session';
import { ADMIN_TOKEN, api, DEVICE_TOKEN, me, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const unauthorized = () =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'unauthorized' },
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );

describe('deviceName', () => {
  it('names the browser and the system', () => {
    expect(
      deviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      ),
    ).toBe('Web: Chrome on Windows');
    expect(
      deviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Web: Safari on iOS');
    expect(
      deviceName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0'),
    ).toBe('Web: Edge on Windows');
  });
});

describe('signing in', () => {
  it('swaps an admin token for a device token and keeps only that one', async () => {
    const created: Array<{ name: unknown; auth: string | null }> = [];
    server.use(
      http.get(api('/v1/me'), ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth === `Bearer ${ADMIN_TOKEN}`) return HttpResponse.json(me('admin', 'admin (env)'));
        if (auth === `Bearer ${DEVICE_TOKEN}`) return HttpResponse.json(me('device-1'));
        return unauthorized();
      }),
      http.post(api('/v1/tokens'), async ({ request }) => {
        const body = (await request.json()) as { name: unknown };
        created.push({ name: body.name, auth: request.headers.get('authorization') });
        return HttpResponse.json(
          {
            token: DEVICE_TOKEN,
            record: {
              id: '0199c000-0000-7000-8000-000000000001',
              name: String(body.name),
              prefix: 'sa_dev',
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: null,
            },
          },
          { status: 201 },
        );
      }),
      ...signedInHandlers(),
    );
    renderApp('/sign-in', { token: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('API token'), ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(
      await screen.findByRole('heading', { level: 1, name: /good (morning|afternoon|evening), sohaib/i }),
    ).toBeVisible();
    expect(created).toEqual([{ name: expect.stringMatching(/^Web: /), auth: `Bearer ${ADMIN_TOKEN}` }]);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(DEVICE_TOKEN);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(ADMIN_TOKEN);
  });

  it('keeps a device token as it is', async () => {
    let created = 0;
    server.use(
      http.post(api('/v1/tokens'), () => {
        created += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/sign-in', { token: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('API token'), DEVICE_TOKEN);
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /sohaib/i })).toBeVisible();
    expect(created).toBe(0);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(DEVICE_TOKEN);
  });

  it('says so when the token is wrong, and keeps nothing', async () => {
    server.use(http.get(api('/v1/me'), unauthorized));
    renderApp('/sign-in', { token: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('API token'), 'sa_wrong_token_value_000000000000');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/that token isn’t valid/i)).toBeVisible();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('sends a revoked browser back to sign-in, saying why', async () => {
    server.use(http.get(api('/v1/me'), unauthorized));
    const { router } = renderApp('/board');
    expect(await screen.findByText(/you were signed out/i)).toBeVisible();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('goes back to sign-in when the token is revoked mid-session', async () => {
    server.use(...signedInHandlers());
    const { router, queryClient } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: /sohaib/i })).toBeVisible();

    server.use(http.get(api('/v1/attention'), unauthorized));
    await act(() => queryClient.invalidateQueries({ queryKey: ['attention'] }));
    expect(await screen.findByText(/you were signed out/i)).toBeVisible();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('leaves another tab’s newer token alone when its own is revoked', async () => {
    server.use(...signedInHandlers());
    const { queryClient } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: /sohaib/i })).toBeVisible();

    // Another tab signed out (revoking this tab's token) and signed in again with a new one.
    window.localStorage.setItem(TOKEN_KEY, 'sa_newer_token_from_another_tab_0000000000');
    server.use(http.get(api('/v1/attention'), unauthorized));
    await act(() => queryClient.invalidateQueries({ queryKey: ['attention'] }));
    expect(await screen.findByText(/you were signed out/i)).toBeVisible();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('sa_newer_token_from_another_tab_0000000000');
  });

  it('offers a retry, not a sign-out, when the server is down', async () => {
    server.use(http.get(api('/v1/me'), () => HttpResponse.error()));
    renderApp('/');
    expect(await screen.findByText(/can’t reach superagent/i)).toBeVisible();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(DEVICE_TOKEN);
  });

  it('signs out by revoking this browser’s token', async () => {
    const revoked: string[] = [];
    server.use(
      http.delete(api('/v1/tokens/:id'), ({ params }) => {
        revoked.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      ...signedInHandlers(),
    );
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /account and theme/i }));
    await user.click(await screen.findByRole('menuitem', { name: /sign out/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(revoked).toEqual(['device-1']);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
