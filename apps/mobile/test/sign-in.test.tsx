import { describe, expect, it } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { copyToClipboard, keystoreText, stored } from './device';
import {
  ADMIN_TOKEN,
  api,
  DEVICE_TOKEN,
  me,
  PAIR_CODE,
  PHONE,
  SERVER,
  server,
  signedIn,
  signedInHandlers,
} from './msw';
import { renderApp } from './render';

const LINK = `superagent://pair?server=${encodeURIComponent(SERVER)}&code=${PAIR_CODE}`;

describe('signing in', () => {
  it('pairs with a pasted link, after naming the server, and keeps only the device token', async () => {
    const seen: Array<{ auth: string | null; body: unknown }> = [];
    server.use(
      http.post(api('/v1/tokens/claim'), async ({ request }) => {
        seen.push({ auth: request.headers.get('authorization'), body: await request.json() });
        return HttpResponse.json(
          {
            token: DEVICE_TOKEN,
            record: {
              id: 'phone-1',
              name: PHONE,
              prefix: 'sa_dddddd',
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
    copyToClipboard(LINK);
    await renderApp('/');

    await fireEvent.press(await screen.findByRole('button', { name: 'Paste' }));
    // The link isn't followed blindly: the server it names comes first, and waits for you.
    expect(await screen.findByText(SERVER)).toBeOnTheScreen();
    expect(seen).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Pair this phone' }));

    expect(await screen.findByText(/Good (morning|afternoon|evening), Sohaib/)).toBeOnTheScreen();
    expect(seen).toEqual([{ auth: `Bearer ${PAIR_CODE}`, body: { name: PHONE } }]);
    expect(stored()).toEqual({ server: SERVER, token: DEVICE_TOKEN, tokenId: 'phone-1', tokenName: PHONE });
    expect(keystoreText()).not.toContain(PAIR_CODE);
  });

  it('says what’s wrong with a link it can’t use', async () => {
    await renderApp('/');
    await fireEvent.changeText(
      await screen.findByLabelText('Or paste the pairing link'),
      `superagent://pair?server=${encodeURIComponent('http://192.168.1.20:4111')}&code=${PAIR_CODE}`,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText(/https:\/\//)).toBeOnTheScreen();
    expect(stored()).toBeNull();
  });

  it('swaps an admin token for a device token named after the phone, and forgets the admin token', async () => {
    const created: unknown[] = [];
    server.use(
      // Nothing answers HTTPS there: a server address without a scheme is taken as https://.
      http.get('https://localhost:4111/v1/me', () => HttpResponse.error()),
      http.get(api('/v1/me'), ({ request }) =>
        request.headers.get('authorization') === `Bearer ${ADMIN_TOKEN}`
          ? HttpResponse.json(me('admin', 'admin (env)'))
          : HttpResponse.json(me()),
      ),
      http.post(api('/v1/tokens'), async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json(
          {
            token: DEVICE_TOKEN,
            record: {
              id: 'phone-2',
              name: PHONE,
              prefix: 'sa_dddddd',
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
    await renderApp('/');
    await fireEvent.press(await screen.findByRole('button', { name: 'Use a server address and a token' }));
    await fireEvent.changeText(screen.getByLabelText('Server'), 'localhost:4111');
    await fireEvent.changeText(screen.getByLabelText('Token'), ADMIN_TOKEN);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    // localhost without a scheme is taken as https: it must be named with http:// to use plain HTTP.
    expect(await screen.findByText(/Couldn’t sign in/)).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Server'), SERVER);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Good (morning|afternoon|evening)/)).toBeOnTheScreen();
    expect(created).toEqual([{ name: PHONE }]);
    expect(stored()?.token).toBe(DEVICE_TOKEN);
    expect(keystoreText()).not.toContain(ADMIN_TOKEN);
  });

  it('signs out a phone whose token was revoked, and says so', async () => {
    signedIn();
    server.use(
      http.get(api('/v1/me'), () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'unauthorized' },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
      ...signedInHandlers(),
    );
    await renderApp('/');
    expect(await screen.findByText('This phone was signed out')).toBeOnTheScreen();
    await waitFor(() => expect(stored()).toBeNull());
  });

  it('asks a signed-in phone to sign out before pairing again', async () => {
    signedIn();
    server.use(...signedInHandlers());
    await renderApp(`/pair?server=${encodeURIComponent('https://other.example.ts.net')}&code=${PAIR_CODE}`);
    expect(await screen.findByText('This phone is signed in already')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Pair this phone' })).toBeNull();
  });
});
