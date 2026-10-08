import { useEffect } from 'react';
import { type Blocker, useBlocker } from 'react-router';
import { ConfirmDialog } from '../ui/dialog';

/**
 * While `dirty`, leaving the page asks first: going elsewhere in the app opens `UnsavedChangesDialog`,
 * closing or reloading the tab asks the browser's question. Moving between the page's own tabs (its
 * query string) isn't leaving.
 */
export function useUnsavedChanges(dirty: boolean): Blocker {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);
  return blocker;
}

/**
 * Tells a page that holds one blocker (`useUnsavedChanges`) for several forms whether this one has
 * unsaved changes: the router honours one blocker at a time.
 */
export function useReportUnsaved(dirty: boolean, report: ((dirty: boolean) => void) | undefined): void {
  useEffect(() => {
    report?.(dirty);
  }, [dirty, report]);
  // Gone (cancelled, saved, or the form left the page): nothing unsaved here any more.
  useEffect(() => () => report?.(false), [report]);
}

/** Asks whether to throw away unsaved changes when `blocker` stopped a navigation. */
export function UnsavedChangesDialog({ blocker, what }: { blocker: Blocker; what: string }) {
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
      title="Leave without saving?"
      description={`Your changes to ${what} aren’t saved yet.`}
      cancelLabel="Keep editing"
      confirmLabel="Discard and leave"
      destructive
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
