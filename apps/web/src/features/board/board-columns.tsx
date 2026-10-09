import { BOARD_COLUMNS, CLOSED_PHASES, errorMessage, PHASES, PRIORITIES, plural } from '@superagent/client';
import type { AttentionItem, Task, TaskPhase } from '@superagent/shared';
import { ChevronsLeftRight, Plus, SquareKanban } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAttention, useBoard } from '../../api/queries';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { PhaseIcon } from '../../ui/icons';
import { attentionByTask } from '../tasks/attention';
import { type OrgLookup, useOrg } from '../tasks/org';
import { TaskCard } from './task-card';

/** Open columns put urgent work first; closed ones show the latest first. */
function sortTasks(phase: TaskPhase, tasks: Task[]): Task[] {
  const closed = phase === 'done' || CLOSED_PHASES.includes(phase);
  return [...tasks].sort((a, b) => {
    if (!closed) {
      const byPriority = PRIORITIES[a.priority].rank - PRIORITIES[b.priority].rank;
      if (byPriority !== 0) return byPriority;
    }
    return Date.parse(b.closedAt ?? b.updatedAt) - Date.parse(a.closedAt ?? a.updatedAt);
  });
}

/** Whether a task matches the board's filter: words of its title, or its number ("#12"). */
export function matchesTask(task: Task, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase().replace(/^#/, '');
  return task.title.toLowerCase().includes(needle) || String(task.number) === needle;
}

/**
 * The board's columns, live: every department's tasks, or one department's (`departmentId`). Failed
 * and cancelled tasks fold into one column you open.
 */
export function BoardColumns({
  departmentId,
  query,
  onNewTask,
}: {
  departmentId?: string;
  query: string;
  onNewTask: () => void;
}) {
  const org = useOrg();
  const board = useBoard(departmentId);
  const attention = useAttention();
  const [closedOpen, setClosedOpen] = useState(false);
  const showDepartment = !departmentId;

  const byTask = useMemo(() => attentionByTask(attention.data), [attention.data]);
  const columns = useMemo(() => {
    const map = new Map<TaskPhase, Task[]>();
    for (const column of board.data?.columns ?? []) {
      map.set(
        column.phase,
        sortTasks(
          column.phase,
          column.tasks.filter((task) => matchesTask(task, query)),
        ),
      );
    }
    return map;
  }, [board.data, query]);

  if (board.isError) {
    return (
      <div className="px-4 sm:px-6">
        <Notice
          tone="destructive"
          title="Couldn’t load the board"
          action={
            <Button size="sm" onClick={() => board.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(board.error)}
        </Notice>
      </div>
    );
  }
  if (board.isPending) return <BoardSkeleton />;

  const all = board.data.columns.flatMap((column) => column.tasks);
  if (all.length === 0) {
    return (
      <EmptyState
        icon={<SquareKanban />}
        title="Nothing on the board"
        description="Give a department something to do, or ask your chief of staff to."
        action={
          <Button variant="primary" onClick={onNewTask}>
            <Plus aria-hidden />
            New task
          </Button>
        }
      />
    );
  }

  // Failed and cancelled share one column: newest closed first, whichever way they ended.
  const closed = sortTasks(
    'failed',
    CLOSED_PHASES.flatMap((phase) => columns.get(phase) ?? []),
  );
  return (
    <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-1 sm:snap-none sm:px-6">
      {BOARD_COLUMNS.map((phase) => (
        <Column
          key={phase}
          phase={phase}
          tasks={columns.get(phase) ?? []}
          org={org}
          attention={byTask}
          showDepartment={showDepartment}
        />
      ))}
      {closed.length > 0 ? (
        closedOpen ? (
          <Column
            phase="failed"
            label="Closed"
            tasks={closed}
            org={org}
            attention={byTask}
            showDepartment={showDepartment}
            onCollapse={() => setClosedOpen(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setClosedOpen(true)}
            className="flex w-11 shrink-0 cursor-pointer flex-col items-center gap-3 rounded-xl py-2 text-muted-foreground hover:bg-fill-subtle hover:text-foreground"
            aria-label={`Show ${plural(closed.length, 'failed or cancelled task')}`}
          >
            <span className="text-meta tabular-nums">{closed.length}</span>
            <span className="text-label [writing-mode:vertical-rl]">Failed and cancelled</span>
          </button>
        )
      ) : null}
      <div aria-hidden className="w-px shrink-0" />
    </div>
  );
}

function Column({
  phase,
  label,
  tasks,
  org,
  attention,
  showDepartment,
  onCollapse,
}: {
  phase: TaskPhase;
  label?: string;
  tasks: Task[];
  org: OrgLookup;
  attention: Map<string, AttentionItem>;
  showDepartment: boolean;
  onCollapse?: () => void;
}) {
  const info = PHASES[phase];
  const name = label ?? info.label;
  return (
    <section
      aria-label={`${name}, ${plural(tasks.length, 'task')}`}
      className="flex w-[85vw] shrink-0 snap-start flex-col sm:w-72"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 px-1">
        <PhaseIcon phase={phase} />
        <h2 className="text-label text-muted-foreground">{name}</h2>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-fill px-1.5 text-meta text-muted-foreground tabular-nums">
          {tasks.length}
        </span>
        {onCollapse ? (
          <Button variant="ghost" size="icon-sm" tooltip="Hide" className="ml-auto" onClick={onCollapse}>
            <ChevronsLeftRight aria-hidden />
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pt-1 pb-6">
        {tasks.length === 0 ? (
          <p className="rounded-card border border-dashed border-border px-4 py-5 text-center text-caption text-placeholder">
            {info.description}
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              department={org.department(task.departmentId)}
              lead={org.agent(task.leadAgentId)}
              attention={attention.get(task.id)}
              showDepartment={showDepartment}
            />
          ))
        )}
      </div>
    </section>
  );
}

export function BoardSkeleton() {
  return (
    <div className="flex gap-4 overflow-hidden px-4 sm:px-6" role="status">
      <span className="sr-only">Loading the board…</span>
      {BOARD_COLUMNS.map((phase) => (
        <div key={phase} className="flex w-72 shrink-0 flex-col gap-2">
          <Skeleton className="mb-1 h-6 w-28 rounded-full" />
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-24 rounded-card opacity-60" />
        </div>
      ))}
    </div>
  );
}
