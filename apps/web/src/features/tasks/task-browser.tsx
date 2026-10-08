import { useCallback, useState } from 'react';
import { useCloseTaskBrowser, useTaskBrowser } from '../../api/browsers';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { RelativeTime } from '../../ui/time';
import { LiveView } from '../browsers/live-view';

/** The browser an agent opened for a task, live: watch it, or take over and use it. */
export function TaskBrowser({ taskId }: { taskId: string }) {
  const browser = useTaskBrowser(taskId);
  const close = useCloseTaskBrowser(taskId);
  const [closing, setClosing] = useState(false);
  const { refetch } = browser;
  // Opened or closed while watched: what it is changes too.
  const onStatus = useCallback(() => void refetch(), [refetch]);
  const session = browser.data;

  return (
    <div className="flex flex-col gap-3">
      <LiveView
        path={`/v1/tasks/${encodeURIComponent(taskId)}/browser/stream`}
        kind="task"
        label="The task’s browser"
        waiting={{
          title: 'No browser open',
          description: 'When an agent opens one for this task, it shows here as it browses.',
        }}
        onStatus={onStatus}
      />
      {session ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption text-muted-foreground">
          <span>
            {session.identity ? `Signed in as ${session.identity}` : 'Not signed in anywhere'} · opened{' '}
            <RelativeTime iso={session.openedAt} />
          </span>
          <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
            Close the browser
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title="Close the task’s browser?"
        description="Its identity’s cookies are saved. An agent’s next browser call opens a new one."
        confirmLabel="Close browser"
        busy={close.isPending}
        onConfirm={() =>
          close.mutate(undefined, {
            onSuccess: () => setClosing(false),
            onError: () => setClosing(false),
          })
        }
      />
    </div>
  );
}
