import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, server, signedInHandlers } from './msw';
import { renderApp } from './render';

describe('your profile', () => {
  it('opens with nothing to save when the chief stored spaces around a value', async () => {
    server.use(
      http.get(api('/v1/profile'), () =>
        HttpResponse.json({
          name: 'Sohaib',
          about: 'Builds superagent. ',
          preferences: ['cite sources', ' '],
        }),
      ),
      ...signedInHandlers(),
    );
    renderApp('/settings/profile');
    expect(await screen.findByLabelText('About you')).toHaveValue('Builds superagent. ');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('corrects what your agents know about you', async () => {
    const patches: unknown[] = [];
    server.use(
      http.get(api('/v1/profile'), () =>
        HttpResponse.json({ name: 'Sohaib', language: 'French', preferences: ['cite sources'] }),
      ),
      http.patch(api('/v1/profile'), async ({ request }) => {
        const patch = await request.json();
        patches.push(patch);
        return HttpResponse.json({ name: 'Sohaib', preferences: ['cite sources', 'no meetings before 10'] });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/profile');
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Language'));
    await user.click(screen.getByRole('button', { name: 'Add a preference' }));
    await user.type(screen.getByLabelText('Preference 2'), 'no meetings before 10');
    await user.click(
      within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() =>
      expect(patches).toEqual([{ language: null, preferences: ['cite sources', 'no meetings before 10'] }]),
    );
    expect(await screen.findByText('Profile saved')).toBeVisible();
  });
});
