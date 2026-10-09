import { errorMessage, formatCost, formatTokens, PRIORITIES, plural } from '@superagent/client';
import type { AttentionItem, Task, TaskPhase } from '@superagent/shared';
import { ArrowRight, CircleCheck, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAttention, useBoard, useProfile, useUsage } from '../../api/queries';
import { useMe } from '../../api/session';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/title';
import { TONE_TEXT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { PhaseIcon } from '../../ui/icons';
import { Page, Panel, ProgressBar, Section } from '../../ui/layout';
import { colorTransition, focusRingInset } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { QuickAsk } from '../conversations/quick-ask';
import { KINDS } from '../inbox/kinds';
import { NewTaskDialog } from '../tasks/new-task-dialog';
import { type OrgLookup, useOrg } from '../tasks/org';
import { DepartmentLabel, taskProgress } from '../tasks/task-bits';

/** With a lead now: sent, being worked on, or waiting for you. The inbox hasn't started yet. */
const IN_PROGRESS = new Set<TaskPhase>(['queued', 'working', 'waiting']);

function greeting(hour: number): string {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Local midnight six days ago: the start of "this week", stable for the whole day. */
function weekStart(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 6);
  return date.toISOString();
}

const rowLink = cn(
  'flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 outline-hidden hover:bg-fill',
  colorTransition,
  focusRingInset,
);

export function HomePage() {
  useDocumentTitle('Home');
  const me = useMe();
  const profile = useProfile();
  const org = useOrg();
  const attention = useAttention();
  const board = useBoard();
  const [from] = useState(weekStart);
  const usage = useUsage('day', from);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const name = profile.data?.name?.trim().split(/\s+/)[0];
  const tasks = useMemo(() => board.data?.columns.flatMap((column) => column.tasks) ?? [], [board.data]);
  const running = tasks
    .filter((task) => IN_PROGRESS.has(task.phase))
    .sort(
      (a, b) =>
        PRIORITIES[a.priority].rank - PRIORITIES[b.priority].rank ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  const finished = tasks
    .filter((task) => task.phase === 'review' || task.closedAt)
    .sort((a, b) => Date.parse(b.closedAt ?? b.updatedAt) - Date.parse(a.closedAt ?? a.updatedAt))
    .slice(0, 6);
  const doneThisWeek = tasks.filter((task) => task.phase === 'done').length;
  const needs = attention.data ?? [];

  const today = new Date();
  const summary = [
    needs.length ? plural(needs.length, 'thing needs you', 'things need you') : 'Nothing needs you',
    running.length ? `${plural(running.length, 'task')} in progress` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Page>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-caption text-muted-foreground">
            {today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <h1 className="text-display text-foreground">
            {greeting(today.getHours())}
            {name ? `, ${name}` : me.name !== 'Owner' ? `, ${me.name}` : ''}
          </h1>
          <p className="text-body-sm text-muted-foreground">
            {attention.isSuccess && board.isSuccess ? summary : ' '}
          </p>
        </div>
        <Button variant="primary" onClick={() => setNewTaskOpen(true)}>
          <Plus aria-hidden />
          New task
        </Button>
      </header>

      <div className="flex flex-col gap-10">
        <QuickAsk />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Need you" value={attention.isSuccess ? String(needs.length) : null} />
          <Stat label="In progress" value={board.isSuccess ? String(running.length) : null} />
          <Stat label="Done this week" value={board.isSuccess ? String(doneThisWeek) : null} />
          <Stat
            label="Spent this week"
            value={usage.isSuccess ? formatCost(usage.data.total.costUsd) : null}
            hint={usage.isSuccess ? `${formatTokens(usage.data.total.totalTokens)} tokens` : undefined}
          />
        </div>

        <Section
          title="Needs you"
          id="home-needs"
          action={
            <Link
              to="/inbox"
              className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
            >
              Inbox <ArrowRight aria-hidden className="size-3" />
            </Link>
          }
        >
          {attention.isPending ? (
            <ListSkeleton />
          ) : attention.isError ? (
            <Notice tone="destructive">{errorMessage(attention.error)}</Notice>
          ) : needs.length === 0 ? (
            <Panel>
              <EmptyState
                compact
                icon={<CircleCheck />}
                title="You’re all caught up"
                description="Approvals, questions and results to review show up here."
              />
            </Panel>
          ) : (
            <Panel className="p-1">
              <ul className="flex flex-col">
                {needs.slice(0, 8).map((item) => (
                  <AttentionRow key={item.id} item={item} org={org} />
                ))}
              </ul>
            </Panel>
          )}
        </Section>

        <Section
          title="In progress"
          id="home-running"
          action={
            <Link
              to="/board"
              className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
            >
              Board <ArrowRight aria-hidden className="size-3" />
            </Link>
          }
        >
          {board.isPending ? (
            <ListSkeleton />
          ) : board.isError ? (
            <Notice tone="destructive">{errorMessage(board.error)}</Notice>
          ) : running.length === 0 ? (
            <Panel>
              <EmptyState
                compact
                title="Nothing in progress"
                description="Tasks your departments are working on show up here."
              />
            </Panel>
          ) : (
            <Panel className="p-1">
              <ul className="flex flex-col">
                {running.slice(0, 8).map((task) => (
                  <TaskRow key={task.id} task={task} org={org} />
                ))}
              </ul>
            </Panel>
          )}
        </Section>

        {finished.length > 0 ? (
          <Section title="Recently finished" id="home-finished">
            <Panel className="p-1">
              <ul className="flex flex-col">
                {finished.map((task) => (
                  <TaskRow key={task.id} task={task} org={org} />
                ))}
              </ul>
            </Panel>
          </Section>
        ) : null}
      </div>

      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />
    </Page>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <Panel className="flex flex-col gap-1 px-4 py-3">
      <span className="text-caption text-muted-foreground">{label}</span>
      {value === null ? (
        <Skeleton className="h-7 w-12" />
      ) : (
        <span className="text-display text-foreground tabular-nums">{value}</span>
      )}
      {hint ? <span className="text-meta text-muted-foreground">{hint}</span> : null}
    </Panel>
  );
}

function AttentionRow({ item, org }: { item: AttentionItem; org: OrgLookup }) {
  const kind = KINDS[item.kind];
  const Icon = kind.icon;
  const department = item.departmentId ? org.department(item.departmentId) : undefined;
  const body = (
    <>
      <Icon aria-hidden className={cn('size-4 shrink-0', TONE_TEXT[kind.tone])} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body-sm text-foreground">{item.title}</span>
        {item.detail ? (
          <span className="line-clamp-1 text-caption text-muted-foreground">{item.detail}</span>
        ) : null}
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-0.5 text-caption text-muted-foreground sm:flex">
        {department ? <DepartmentLabel department={department} /> : <span>{kind.label}</span>}
        <RelativeTime iso={item.since} className="text-meta text-placeholder" />
      </div>
    </>
  );
  return (
    <li>
      {item.taskId ? (
        <Link to={`/tasks/${item.taskId}`} className={rowLink}>
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">{body}</div>
      )}
    </li>
  );
}

function TaskRow({ task, org }: { task: Task; org: OrgLookup }) {
  const department = org.department(task.departmentId);
  const progress = task.closedAt ? null : taskProgress(task);
  return (
    <li>
      <Link to={`/tasks/${task.id}`} className={rowLink}>
        <PhaseIcon phase={task.phase} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-caption text-placeholder tabular-nums">#{task.number}</span>
            <span className="truncate text-body-sm text-foreground">{task.title}</span>
          </span>
          {progress ? <ProgressBar value={progress.percent} className="max-w-48" /> : null}
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-0.5 text-caption text-muted-foreground sm:flex">
          <DepartmentLabel department={department} />
          <RelativeTime iso={task.closedAt ?? task.updatedAt} className="text-meta text-placeholder" />
        </div>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <Panel className="flex flex-col gap-1 p-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </Panel>
  );
}
