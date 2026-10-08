import type { Task } from '@superagent/shared';
import { canTransition } from '@superagent/shared/phases';
import { Check, ChevronRight, CircleSlash, Ellipsis, Pencil, RotateCcw, Send } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage, ProblemError } from '../../api/client';
import { useAttention, useCancelTask, useTask, useUpdateTask } from '../../api/queries';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton, Spinner } from '../../ui/feedback';
import { Field, Textarea } from '../../ui/field';
import { Page, Panel } from '../../ui/layout';
import { Markdown } from '../../ui/markdown';
import { Menu, MenuItem, MenuSeparator } from '../../ui/menu';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';
import { ApprovalCard } from './approval-card';
import { attentionLine } from './attention';
import { EditTaskDialog } from './edit-task-dialog';
import { type OrgLookup, useOrg } from './org';
import { TaskActivity } from './task-activity';
import { DepartmentLabel, DueBadge, PhaseBadge, PriorityBadge, SourceBadge } from './task-bits';
import { TaskComposer } from './task-composer';
import { TaskArtifacts, TaskChecklist, TaskDetails, TaskUsage } from './task-rail';

export function TaskPage() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const task = useTask(taskId);
  const org = useOrg();

  if (task.isPending) return <TaskSkeleton />;
  if (task.isError) {
    const missing =
      task.error instanceof ProblemError && (task.error.status === 404 || task.error.status === 400);
    return (
      <Page>
        {missing ? (
          <EmptyState
            title="No such task"
            description="It may have been a mistyped link."
            action={
              <Link to="/board" className="text-label text-foreground underline underline-offset-4">
                Back to the board
              </Link>
            }
          />
        ) : (
          <Notice
            tone="destructive"
            title="Couldn’t load the task"
            action={
              <Button size="sm" onClick={() => task.refetch()}>
                Retry
              </Button>
            }
          >
            {errorMessage(task.error)}
          </Notice>
        )}
      </Page>
    );
  }
  return <TaskView task={task.data} org={org} />;
}

function TaskView({ task, org }: { task: Task; org: OrgLookup }) {
  const department = org.department(task.departmentId);
  const attention = useAttention();
  const items = useMemo(
    () => (attention.data ?? []).filter((item) => item.taskId === task.id),
    [attention.data, task.id],
  );
  const approvals = items.filter((item) => item.kind === 'approval');
  const other = items.find((item) => item.kind === 'question' || item.kind === 'problem');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const update = useUpdateTask(task.id);
  const cancel = useCancelTask(task.id);
  const [cancelReason, setCancelReason] = useState('');

  const canAccept = canTransition('owner', task.phase, 'done');
  const canQueue = canTransition('owner', task.phase, 'queued') && Boolean(department?.lead);
  const canCancel = canTransition('owner', task.phase, 'cancelled');

  const move = (phase: 'done' | 'queued', message: string) =>
    update.mutate(
      { phase },
      { onSuccess: (next) => toast.success(message, `#${next.number} ${next.title}`) },
    );

  const primary =
    task.phase === 'review' && canAccept ? (
      <>
        <Button onClick={() => composerRef.current?.focus()}>Request changes</Button>
        <Button variant="primary" disabled={update.isPending} onClick={() => move('done', 'Accepted')}>
          {update.isPending ? <Spinner /> : <Check aria-hidden />}
          Accept
        </Button>
      </>
    ) : task.phase === 'inbox' && canQueue ? (
      <Button
        variant="primary"
        disabled={update.isPending}
        onClick={() => move('queued', 'Sent to the lead')}
      >
        <Send aria-hidden />
        Send to lead
      </Button>
    ) : (task.phase === 'done' || task.phase === 'failed') && canQueue ? (
      <Button disabled={update.isPending} onClick={() => move('queued', 'Sent back to the lead')}>
        <RotateCcw aria-hidden />
        Send back to lead
      </Button>
    ) : null;

  return (
    <Page width="medium">
      <header className="mb-5 flex flex-col gap-3">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground"
        >
          <Link to="/board" className="hover:text-foreground">
            Board
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-placeholder" />
          {department ? (
            <Link
              to={`/board?department=${encodeURIComponent(department.slug)}`}
              className="min-w-0 hover:text-foreground"
            >
              <DepartmentLabel department={department} />
            </Link>
          ) : null}
          <ChevronRight aria-hidden className="size-3 shrink-0 text-placeholder" />
          <span className="tabular-nums" aria-current="page">
            #{task.number}
          </span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <h1 className="min-w-0 max-w-3xl text-title text-foreground">{task.title}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {primary}
            <Menu
              trigger={
                <Button variant="ghost" size="icon-md" tooltip="More actions">
                  <Ellipsis aria-hidden />
                </Button>
              }
            >
              <MenuItem icon={<Pencil aria-hidden />} onClick={() => setEditOpen(true)}>
                Edit title, priority or due date
              </MenuItem>
              {task.phase === 'waiting' && canQueue ? (
                <MenuItem
                  icon={<RotateCcw aria-hidden />}
                  onClick={() => move('queued', 'Sent back to the lead')}
                >
                  Send back to the lead
                </MenuItem>
              ) : null}
              {canCancel ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    destructive
                    icon={<CircleSlash aria-hidden />}
                    onClick={() => setCancelOpen(true)}
                  >
                    Cancel task…
                  </MenuItem>
                </>
              ) : null}
            </Menu>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PhaseBadge phase={task.phase} size="md" />
          <PriorityBadge priority={task.priority} />
          <SourceBadge task={task} />
          <DueBadge task={task} />
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18.5rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {approvals.map((item) => (
            <ApprovalCard key={item.id} item={item} />
          ))}
          {other ? (
            <Notice
              tone={other.kind === 'question' ? 'warning' : 'destructive'}
              title={attentionLine(other, task.title).text}
            >
              {other.detail ? <span className="whitespace-pre-wrap">{other.detail}</span> : null}
              {other.kind === 'question' ? (
                <span className="mt-1 block text-muted-foreground">Answer it below.</span>
              ) : null}
            </Notice>
          ) : null}

          {task.result ? (
            <Panel className="flex flex-col gap-3 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-subheading text-foreground">Report</h2>
                <span className="text-caption text-muted-foreground">
                  Updated <RelativeTime iso={task.updatedAt} />
                </span>
              </div>
              <Markdown>{task.result}</Markdown>
            </Panel>
          ) : null}

          <section aria-labelledby="brief-title" className="flex flex-col gap-2.5">
            <h2 id="brief-title" className="text-subheading text-foreground">
              Brief
            </h2>
            <Markdown className="text-foreground/90">{task.brief}</Markdown>
          </section>

          <section aria-labelledby="activity-title" className="flex flex-col gap-3">
            <h2 id="activity-title" className="text-subheading text-foreground">
              Activity
            </h2>
            <TaskActivity taskId={task.id} org={org} />
          </section>

          <TaskComposer task={task} inputRef={composerRef} waitingForApproval={approvals.length > 0} />
        </div>

        <aside className="flex flex-col gap-3" aria-label="About this task">
          <TaskDetails task={task} org={org} />
          <TaskChecklist task={task} />
          <TaskArtifacts taskId={task.id} />
          <TaskUsage task={task} />
        </aside>
      </div>

      <EditTaskDialog task={task} open={editOpen} onOpenChange={setEditOpen} />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          setCancelOpen(open);
          if (!open) setCancelReason('');
        }}
        title={`Cancel #${task.number}?`}
        description="The lead stops, and anything waiting for your approval on it is declined. A cancelled task can’t be reopened."
        confirmLabel="Cancel task"
        destructive
        busy={cancel.isPending}
        onConfirm={() =>
          cancel.mutate(cancelReason.trim() || undefined, {
            onSuccess: () => {
              setCancelOpen(false);
              setCancelReason('');
              toast.success('Task cancelled');
            },
          })
        }
      >
        <Field label="Reason" hint="Optional. Kept in the task’s history.">
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              maxLength={500}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            />
          )}
        </Field>
      </ConfirmDialog>
    </Page>
  );
}

function TaskSkeleton() {
  return (
    <Page width="medium">
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading the task…</span>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-5 w-48" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18.5rem]">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </Page>
  );
}
