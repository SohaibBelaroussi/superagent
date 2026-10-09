import { errorMessage, ProblemError } from '@superagent/client';
import type { Sandbox } from '@superagent/shared';
import { Box, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useRemoveSandbox, useSandboxes } from '../../api/workspaces';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Page, PageHeader, Panel } from '../../ui/layout';
import { raisedSurface } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';

const taskName = (sandbox: Sandbox) =>
  sandbox.taskNumber ? `#${sandbox.taskNumber}${sandbox.taskTitle ? ` ${sandbox.taskTitle}` : ''}` : 'A task';

/** The containers tasks run commands in: one per task, with no network and only its own files. */
export function SandboxesPage() {
  useDocumentTitle('Sandboxes');
  const sandboxes = useSandboxes();
  const remove = useRemoveSandbox();
  const [removing, setRemoving] = useState<Sandbox | null>(null);
  const off = sandboxes.error instanceof ProblemError && sandboxes.error.status === 503;

  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Sandboxes"
          description="A task whose agents run commands gets a container of its own: no network, only the task’s files. Idle ones stop, and long-stopped ones go."
        />
      }
    >
      {sandboxes.isPending ? (
        <div role="status">
          <span className="sr-only">Loading the sandboxes…</span>
          <Skeleton className="h-32 rounded-xl" />
        </div>
      ) : sandboxes.isError ? (
        <Notice
          tone={off ? 'warning' : 'destructive'}
          title={off ? 'Sandboxes aren’t available' : 'Couldn’t load the sandboxes'}
          action={
            <Button size="sm" onClick={() => sandboxes.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(sandboxes.error)}
        </Notice>
      ) : sandboxes.data.length === 0 ? (
        <Panel>
          <EmptyState
            compact
            icon={<Box />}
            title="No sandboxes"
            description="A task gets one when an agent runs a command in it."
          />
        </Panel>
      ) : (
        <ul className={cn('divide-y divide-border rounded-xl', raisedSurface)} aria-label="Sandboxes">
          {sandboxes.data.map((sandbox) => (
            <li key={sandbox.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link
                    to={`/tasks/${sandbox.taskId}?view=files`}
                    className="min-w-0 truncate text-label text-foreground hover:underline hover:underline-offset-2"
                  >
                    {taskName(sandbox)}
                  </Link>
                  <Badge tone={sandbox.state === 'running' ? 'green' : 'neutral'} dot>
                    {sandbox.state === 'running' ? 'Running' : 'Stopped'}
                  </Badge>
                  <Badge>{sandbox.profile}</Badge>
                </p>
                <p className="text-caption text-muted-foreground">
                  Started <RelativeTime iso={sandbox.createdAt} /> ·{' '}
                  {sandbox.lastUsedAt ? (
                    <>
                      last used <RelativeTime iso={sandbox.lastUsedAt} />
                    </>
                  ) : (
                    'not used yet'
                  )}
                </p>
              </div>
              <Button
                size="sm"
                variant="destructive-ghost"
                aria-label={`Remove the sandbox of ${taskName(sandbox)}`}
                onClick={() => setRemoving(sandbox)}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        title={`Remove the sandbox of ${removing ? taskName(removing) : ''}?`}
        description="Its container goes; the task’s files stay, and its next command starts a fresh sandbox."
        confirmLabel="Remove sandbox"
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.taskId, {
            onSuccess: () => {
              toast.success('Sandbox removed');
              setRemoving(null);
            },
            onError: () => setRemoving(null),
          });
        }}
      />
    </Page>
  );
}
