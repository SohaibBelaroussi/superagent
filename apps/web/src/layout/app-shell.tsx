import { Menu as MenuIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { LiveEventsProvider } from '../api/live';
import { useSession } from '../api/session';
import { useAttentionNotifications } from '../features/inbox/attention-notifications';
import { cn } from '../lib/cn';
import { Button } from '../ui/button';
import { Sheet } from '../ui/dialog';
import { Spinner } from '../ui/feedback';
import { Logo } from '../ui/icons';
import { frameSurface } from '../ui/recipes';
import { ServerUnreachable } from './server-unreachable';
import { Sidebar } from './sidebar';

/** Every page but sign-in: checks the session first, then keeps the app's data live. */
export function RequireSession() {
  const { state } = useSession();
  const location = useLocation();
  if (state.status === 'checking') {
    return (
      <div className="flex h-dvh items-center justify-center bg-sidebar text-muted-foreground">
        <Spinner label="Loading" />
      </div>
    );
  }
  if (state.status === 'unreachable') return <ServerUnreachable />;
  if (state.status === 'signed-out') {
    return (
      <Navigate
        to="/sign-in"
        replace
        state={{ from: `${location.pathname}${location.search}`, reason: state.reason }}
      />
    );
  }
  return (
    <LiveEventsProvider token={state.token}>
      <Outlet />
    </LiveEventsProvider>
  );
}

/** The command palette, loaded the first time it opens: most visits never use it. */
const CommandPalette = lazy(async () => ({
  default: (await import('../features/palette/command-palette')).CommandPalette,
}));

/**
 * The frame: the rail on the left (a drawer on phones) and the page in a rounded card beside it. It
 * also answers ⌘K with the command palette, and tells you of new things that need you (if you asked).
 */
export function AppShell() {
  useAttentionNotifications();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  const openPalette = () => {
    setDrawerOpen(false);
    setPaletteLoaded(true);
    setPaletteOpen(true);
  };

  // ⌘K (Ctrl+K) opens the palette from anywhere, and closes it again.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteLoaded(true);
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-sidebar lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-card px-4 py-2 text-label focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside className="hidden min-h-0 lg:block">
        <Sidebar onSearch={openPalette} />
      </aside>

      <header className="flex h-12 shrink-0 items-center gap-1.5 px-2 lg:hidden">
        <Button variant="ghost" size="icon-md" tooltip="Menu" onClick={() => setDrawerOpen(true)}>
          <MenuIcon aria-hidden />
        </Button>
        <Logo />
      </header>
      <Sheet
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        label="Navigation"
        className="bg-sidebar shadow-overlay"
      >
        <Sidebar onNavigate={() => setDrawerOpen(false)} onSearch={openPalette} />
      </Sheet>

      <div className="flex min-h-0 flex-1 flex-col px-1.5 pb-1.5 lg:py-2 lg:pr-2 lg:pl-0">
        <main
          id="main"
          className={cn(
            'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-frame p-px',
            frameSurface,
          )}
        >
          <Outlet />
        </main>
      </div>
      {paletteLoaded ? (
        <Suspense fallback={null}>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
