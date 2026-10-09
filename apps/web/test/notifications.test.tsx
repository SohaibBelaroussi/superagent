import type { PushStatus } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, api, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Refused', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const KEY_FILE = JSON.stringify({
  type: 'service_account',
  project_id: 'superagent-home',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  client_email: 'push@superagent-home.iam.gserviceaccount.com',
});

/** The push routes: not set up until a key file Google accepts arrives (the second one sent). */
function pushHandlers(seen: { uploads: string[] }) {
  let status: PushStatus = { configured: false, projectId: null, clientEmail: null, devices: [] };
  return [
    http.get(api('/v1/push'), ({ request }) =>
      request.headers.get('authorization') === `Bearer ${ADMIN_TOKEN}`
        ? HttpResponse.json(status)
        : problem(403, 'Admin only.'),
    ),
    http.put(api('/v1/push/config'), async ({ request }) => {
      const { serviceAccount } = (await request.json()) as { serviceAccount: string };
      seen.uploads.push(serviceAccount);
      if (seen.uploads.length === 1)
        return problem(422, 'Google refused the service account (400): invalid_grant');
      status = {
        configured: true,
        projectId: 'superagent-home',
        clientEmail: 'push@superagent-home.iam.gserviceaccount.com',
        devices: [
          {
            id: 'push-1',
            tokenId: 'device-2',
            tokenName: 'App: Pixel 9, Android 16',
            platform: 'android',
            kinds: ['approval', 'chief'],
            createdAt: '2026-10-09T09:00:00.000Z',
            updatedAt: '2026-10-09T09:00:00.000Z',
            lastSentAt: null,
            lastError: null,
          },
        ],
      };
      return HttpResponse.json(status);
    }),
  ];
}

describe('notifications settings', () => {
  it('sets up the Firebase project from its key file, and lists the phones that get pushes', async () => {
    const seen = { uploads: [] as string[] };
    server.use(...pushHandlers(seen), ...signedInHandlers());
    renderApp('/settings/notifications');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Admin token'), ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Show notifications' }));
    const firebase = await screen.findByRole('region', { name: 'Firebase project' });
    expect(firebase).toHaveTextContent('Not set up');

    const keyFile = () => new File([KEY_FILE], 'superagent-home.json', { type: 'application/json' });
    // A key Google refuses says why, and changes nothing.
    await user.upload(screen.getByLabelText('Service account key file'), keyFile());
    expect(await within(firebase).findByText(/invalid_grant/)).toBeVisible();

    await user.upload(screen.getByLabelText('Service account key file'), keyFile());
    await waitFor(() => expect(firebase).toHaveTextContent('Firebase project superagent-home'));
    expect(seen.uploads).toEqual([KEY_FILE, KEY_FILE]);
    const phones = await screen.findByRole('list', { name: 'Phones that get notifications' });
    expect(phones).toHaveTextContent('App: Pixel 9, Android 16');
    expect(phones).toHaveTextContent('Approvals');
    expect(phones).toHaveTextContent('The chief’s answers');
    // The key's text is never shown on the page.
    expect(document.body.textContent).not.toContain('PRIVATE KEY');
  });
});
