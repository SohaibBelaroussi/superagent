import { createBrowserRouter, Link, type RouteObject } from 'react-router';
import { SignInPage } from './features/auth/sign-in-page';
import { AppShell, RequireSession } from './layout/app-shell';
import { EmptyState } from './ui/feedback';
import { Page } from './ui/layout';

function NotFound() {
  return (
    <Page>
      <EmptyState
        title="Nothing here"
        description="This page doesn’t exist, or the link is out of date."
        action={
          <Link to="/" className="text-label text-foreground underline underline-offset-4">
            Go home
          </Link>
        }
      />
    </Page>
  );
}

/** Pages load on first visit: the shell and sign-in come first, each page brings its own code. */
export const routes: RouteObject[] = [
  { path: '/sign-in', element: <SignInPage /> },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            index: true,
            lazy: async () => ({ Component: (await import('./features/home/home-page')).HomePage }),
          },
          {
            path: 'board',
            lazy: async () => ({ Component: (await import('./features/board/board-page')).BoardPage }),
          },
          {
            path: 'tasks/:taskId',
            lazy: async () => ({ Component: (await import('./features/tasks/task-page')).TaskPage }),
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
