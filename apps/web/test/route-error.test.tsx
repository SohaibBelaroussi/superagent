import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { isStaleBuild, RouteError } from '../src/layout/route-error';

describe('a page that fails', () => {
  it('recognises code missing after an upgrade, in every browser’s words', () => {
    expect(
      isStaleBuild(new TypeError('Failed to fetch dynamically imported module: /assets/board-page-x.js')),
    ).toBe(true);
    expect(isStaleBuild(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleBuild(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isStaleBuild(new Error('Unable to preload CSS for /assets/index.css'))).toBe(true);
    expect(isStaleBuild(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('shows what went wrong and a way out instead of a blank screen', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          loader: () => {
            throw new Error('Something broke while loading.');
          },
          element: <p>never</p>,
          errorElement: <RouteError />,
        },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByText('This page ran into a problem')).toBeVisible();
    expect(screen.getByText(/something broke while loading/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });
});
