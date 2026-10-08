import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/feedback';

const RELOADED_FOR = 'superagent.reloaded-for';

/**
 * The page asked for code the server no longer has: the server was upgraded while this tab stayed
 * open, and the old build's hashed files are gone.
 */
export function isStaleBuild(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|error loading dynamically imported module/i.test(
    message,
  );
}

/**
 * Reloads the page once for this address. A second failure on the same address shows the error rather
 * than reloading forever; without storage (private mode) there is no guard, so no automatic reload.
 */
export function reloadOnce(): boolean {
  const here = `${window.location.pathname}${window.location.search}`;
  try {
    if (window.sessionStorage.getItem(RELOADED_FOR) === here) return false;
    window.sessionStorage.setItem(RELOADED_FOR, here);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** A page's code loaded: a later stale build on this address may reload again. */
export function clearReloadGuard(): void {
  try {
    window.sessionStorage.removeItem(RELOADED_FOR);
  } catch {
    // Nothing stored.
  }
}

function describe(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`;
  if (error instanceof Error) return error.message;
  return 'Something unexpected happened.';
}

/** What a page shows instead of a blank screen when it fails to load or to render. */
export function RouteError() {
  const error = useRouteError();
  const stale = isStaleBuild(error);

  useEffect(() => {
    if (stale) reloadOnce();
  }, [stale]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <EmptyState
        icon={stale ? <RefreshCw /> : <TriangleAlert />}
        title={stale ? 'superagent was updated' : 'This page ran into a problem'}
        description={
          stale
            ? 'This tab still has the previous version. Reload to get the new one.'
            : `${describe(error)} Reloading usually helps; if it doesn’t, the server’s logs say more.`
        }
        action={
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              <RefreshCw aria-hidden />
              Reload
            </Button>
            <Link
              to="/"
              reloadDocument
              className="px-3 text-label text-muted-foreground hover:text-foreground"
            >
              Go home
            </Link>
          </div>
        }
      />
    </div>
  );
}
