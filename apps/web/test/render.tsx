import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { createQueryClient } from '../src/api/query-client';
import { TOKEN_KEY } from '../src/api/session';
import { AppProviders } from '../src/app';
import { routes } from '../src/router';
import { DEVICE_TOKEN } from './msw';

/**
 * The whole app at `path`, as a browser would run it: real providers, real routes, real API client;
 * only the network is mocked (MSW). Signed in with a device token unless `token` is null.
 */
export function renderApp(path: string, options: { token?: string | null } = {}) {
  const token = options.token === undefined ? DEVICE_TOKEN : options.token;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...view, router, queryClient };
}
