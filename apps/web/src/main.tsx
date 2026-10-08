import '@fontsource-variable/mona-sans/wght.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { createQueryClient } from './api/query-client';
import { AppProviders } from './app';
import { reloadOnce } from './layout/route-error';
import { createRouter } from './router';

// A page's code preloaded from a build the server no longer has (upgraded while this tab was open):
// reload once to get the new build, instead of failing on the next navigation.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnce()) event.preventDefault();
});

const queryClient = createQueryClient();
const router = createRouter();

const root = document.getElementById('root');
if (!root) throw new Error('No #root element in index.html');

createRoot(root).render(
  <StrictMode>
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
