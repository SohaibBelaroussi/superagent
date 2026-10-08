import type { AttentionItem, Task, TaskPhase } from '@superagent/shared';
import { ChevronsLeftRight, Plus, Search, SquareKanban } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { useAttention, useBoard } from '../../api/queries';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/title';
import { BOARD_COLUMNS, CLOSED_PHASES, departmentTone, PHASES, PRIORITIES, TONE_DOT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { PhaseIcon } from '../../ui/icons';
import { PageHeader } from '../../ui/layout';
import { Select } from '../../ui/select';
import { attentionByTask } from '../tasks/attention';
import { NewTaskDialog } from '../tasks/new-task-dialog';
import { type OrgLookup, useOrg } from '../tasks/org';
import { TaskCard } from './task-card';

const ALL = 'all';

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

function matches(task: Task, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase().replace(/^#/, '');
  return task.title.toLowerCase().includes(needle) || String(task.number) === needle;
}

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const org = useOrg();
  const slug = params.get('department');
  const department = slug ? org.departmentBySlug(slug) : undefined;
  useDocumentTitle(department ? department.name : 'Board');
  const waitingForDepartment = Boolean(slug) && !department && !org.ready;
  const board = useBoard(department?.id);
  const attention = useAttention();
  const [filter, setFilter] = useState('');
  const query = useDeferredValue(filter.trim());
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);

  const byTask = useMemo(() => attentionByTask(attention.data), [attention.data]);
  const columns = useMemo(() => {
    const map = new Map<TaskPhase, Task[]>();
    for (const column of board.data?.columns ?? []) {
      map.set(
        column.phase,
        sortTasks(
          column.phase,
          column.tasks.filter((task) => matches(task, query)),
        ),
      );
    }
    return map;
  }, [board.data, query]);

  const all = board.data?.columns.flatMap((column) => column.tasks) ?? [];
  const open = all.filter((task) => !task.closedAt).length;
  // Failed and cancelled share one column: newest closed first, whichever way they ended.
  const closed = sortTasks(
    'failed',
    CLOSED_PHASES.flatMap((phase) => columns.get(phase) ?? []),
  );
  const unknownDepartment = Boolean(slug) && org.ready && !department;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-5 sm:px-6 sm:pt-7">
        <PageHeader
          className="mb-5"
          eyebrow={department ? 'Board' : undefined}
          title={
            department ? (
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn('size-2.5 rounded-full', TONE_DOT[departmentTone(department.slug)])}
                />
                {department.name}
              </span>
            ) : (
              'Board'
            )
          }
          description={
            board.data
              ? `${plural(open, 'open task')}${department?.lead ? ` · led by ${department.lead.name}` : ''}`
              : undefined
          }
          actions={
            <>
              <div className="relative w-full sm:w-56">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-placeholder"
                />
                <Input
                  aria-label="Filter tasks"
                  placeholder="Filter by title or #"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="pl-8"
                />
              </div>
              <Select
                aria-label="Department"
                value={department?.slug ?? ALL}
                onValueChange={(value) => {
                  const next = new URLSearchParams(params);
                  if (value === ALL) next.delete('department');
                  else next.set('department', value);
                  setParams(next, { replace: true });
                }}
                className="min-w-44"
                options={[
                  { value: ALL, label: 'All departments' },
                  ...org.departments.map((item) => ({
                    value: item.slug,
                    label: item.name,
                    icon: (
                      <span
                        aria-hidden
                        className={cn('size-2 rounded-full', TONE_DOT[departmentTone(item.slug)])}
                      />
                    ),
                  })),
                ]}
              />
              <Button variant="primary" onClick={() => setNewTaskOpen(true)}>
                <Plus aria-hidden />
                New task
              </Button>
            </>
          }
        />
      </div>

      {unknownDepartment ? (
        <div className="px-4 sm:px-6">
          <Notice tone="warning" title="No such department">
            There’s no department “{slug}”. Showing nothing until you pick another.
          </Notice>
        </div>
      ) : board.isError ? (
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
      ) : board.isPending || waitingForDepartment ? (
        <BoardSkeleton />
      ) : org.ready && org.departments.length === 0 ? (
        <EmptyState
          icon={<SquareKanban />}
          title="No departments yet"
          description="Tasks go to departments. Create your first one through the API (POST /v1/departments); managing them here comes next."
        />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<SquareKanban />}
          title="Nothing on the board"
          description="Give a department something to do, or ask your chief of staff to."
          action={
            <Button variant="primary" onClick={() => setNewTaskOpen(true)}>
              <Plus aria-hidden />
              New task
            </Button>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-1 sm:snap-none sm:px-6">
          {BOARD_COLUMNS.map((phase) => (
            <Column
              key={phase}
              phase={phase}
              tasks={columns.get(phase) ?? []}
              org={org}
              attention={byTask}
              showDepartment={!department}
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
                showDepartment={!department}
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
      )}

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        departmentId={department?.id}
        onCreated={(task) => {
          // A filter that hides the new card would look like nothing happened.
          if (query && !matches(task, query)) setFilter('');
        }}
      />
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
          tasks.map((task) => {
            const department = org.department(task.departmentId);
            return (
              <TaskCard
                key={task.id}
                task={task}
                department={department}
                lead={org.agent(task.leadAgentId)}
                attention={attention.get(task.id)}
                showDepartment={showDepartment}
              />
            );
          })
        )}
      </div>
    </section>
  );
}

function BoardSkeleton() {
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
