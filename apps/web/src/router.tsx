import type { ComponentType } from 'react';
import { createBrowserRouter, Link, Navigate, type RouteObject } from 'react-router';
import { SignInPage } from './features/auth/sign-in-page';
import { AppShell, RequireSession } from './layout/app-shell';
import { clearReloadGuard, RouteError } from './layout/route-error';
import { useDocumentTitle } from './lib/title';
import { EmptyState } from './ui/feedback';
import { Page } from './ui/layout';

function NotFound() {
  useDocumentTitle('Not found');
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

/** A page whose code loads on first visit. Loading it clears the stale-build reload guard. */
function page(load: () => Promise<ComponentType>): Pick<RouteObject, 'lazy'> {
  return {
    lazy: async () => {
      const Component = await load();
      clearReloadGuard();
      return { Component };
    },
  };
}

/**
 * Pages load on first visit: the shell and sign-in come first, each page brings its own code. A page
 * that fails to load or render shows RouteError inside the frame; anything above it, on its own.
 */
export const routes: RouteObject[] = [
  { path: '/sign-in', element: <SignInPage />, errorElement: <RouteError /> },
  {
    element: <RequireSession />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            errorElement: <RouteError />,
            children: [
              { index: true, ...page(async () => (await import('./features/home/home-page')).HomePage) },
              { path: 'inbox', ...page(async () => (await import('./features/inbox/inbox-page')).InboxPage) },
              {
                path: 'chief',
                ...page(async () => (await import('./features/conversations/chief-page')).ChiefPage),
              },
              { path: 'board', ...page(async () => (await import('./features/board/board-page')).BoardPage) },
              {
                path: 'tasks/:taskId',
                ...page(async () => (await import('./features/tasks/task-page')).TaskPage),
              },
              {
                path: 'departments',
                ...page(
                  async () => (await import('./features/departments/departments-page')).DepartmentsPage,
                ),
              },
              {
                path: 'departments/:slug',
                ...page(async () => (await import('./features/departments/department-page')).DepartmentPage),
              },
              {
                path: 'agents/:agentKey',
                ...page(async () => (await import('./features/agents/agent-page')).AgentPage),
              },
              {
                path: 'schedules',
                ...page(async () => (await import('./features/schedules/schedules-page')).SchedulesPage),
              },
              {
                path: 'knowledge',
                ...page(async () => (await import('./features/knowledge/knowledge-page')).KnowledgePage),
              },
              { path: 'usage', ...page(async () => (await import('./features/usage/usage-page')).UsagePage) },
              {
                path: 'settings',
                ...page(async () => (await import('./features/settings/settings-layout')).SettingsLayout),
                children: [
                  { index: true, element: <Navigate to="models" replace /> },
                  {
                    path: 'models',
                    ...page(async () => (await import('./features/settings/models-page')).ModelsPage),
                  },
                  {
                    path: 'general',
                    ...page(async () => (await import('./features/settings/general-page')).GeneralPage),
                  },
                  {
                    path: 'profile',
                    ...page(async () => (await import('./features/profile/profile-page')).ProfilePage),
                  },
                  {
                    path: 'devices',
                    ...page(async () => (await import('./features/settings/devices-page')).DevicesPage),
                  },
                  {
                    path: 'notifications',
                    ...page(
                      async () => (await import('./features/settings/notifications-page')).NotificationsPage,
                    ),
                  },
                  {
                    path: 'secrets',
                    ...page(async () => (await import('./features/settings/secrets-page')).SecretsPage),
                  },
                  {
                    path: 'mcp',
                    ...page(async () => (await import('./features/settings/mcp-page')).McpPage),
                  },
                  {
                    path: 'plugins',
                    ...page(async () => (await import('./features/settings/plugins-page')).PluginsPage),
                  },
                  {
                    path: 'skills',
                    ...page(async () => (await import('./features/settings/skills-page')).SkillsPage),
                  },
                  {
                    path: 'browsers',
                    ...page(async () => (await import('./features/settings/browsers-page')).BrowsersPage),
                  },
                  {
                    path: 'browsers/:identityId/sign-in',
                    ...page(
                      async () =>
                        (await import('./features/settings/identity-sign-in-page')).IdentitySignInPage,
                    ),
                  },
                  {
                    path: 'sandboxes',
                    ...page(async () => (await import('./features/settings/sandboxes-page')).SandboxesPage),
                  },
                  { path: '*', element: <NotFound /> },
                ],
              },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
