import type { AgentDefinition, Department } from '@superagent/shared';
import { OPEN_PHASES } from '@superagent/shared/phases';
import { Building2, ChevronDown, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { teamOf } from '../../api/org';
import { useAgents, useBoard, useDepartments } from '../../api/queries';
import { useSchedules } from '../../api/schedules';
import { cn } from '../../lib/cn';
import { formatDate, plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/title';
import { departmentTone, TONE_DOT } from '../../lib/tones';
import { Avatar } from '../../ui/avatar';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Page, PageHeader } from '../../ui/layout';
import { colorTransition, focusRingInset } from '../../ui/recipes';
import { NewDepartmentDialog } from './new-department-dialog';

/** The organization at a glance: each department with its team and its work. */
export function DepartmentsPage() {
  useDocumentTitle('Departments');
  const departments = useDepartments();
  const agents = useAgents();
  const board = useBoard();
  const schedules = useSchedules();
  const [newOpen, setNewOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [params, setParams] = useSearchParams();

  // ?new=1 (the palette's "New department", the rail's +) opens the dialog, once.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setNewOpen(true);
    setParams({}, { replace: true });
  }, [params, setParams]);

  const all = departments.data ?? [];
  const active = all.filter((department) => !department.archivedAt);
  const archived = all.filter((department) => department.archivedAt);
  const openTasks = new Map<string, number>();
  for (const column of board.data?.columns ?? []) {
    if (!OPEN_PHASES.includes(column.phase)) continue;
    for (const task of column.tasks)
      openTasks.set(task.departmentId, (openTasks.get(task.departmentId) ?? 0) + 1);
  }
  const scheduleCount = new Map<string, number>();
  for (const schedule of schedules.data ?? []) {
    if (schedule.status === 'active') {
      scheduleCount.set(schedule.departmentId, (scheduleCount.get(schedule.departmentId) ?? 0) + 1);
    }
  }

  return (
    <Page
      width="medium"
      header={
        <PageHeader
          title="Departments"
          description="Each department takes one area of your work: its lead plans every task and hands parts to its specialists."
          actions={
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <Plus aria-hidden />
              New department
            </Button>
          }
        />
      }
    >
      {departments.isError ? (
        <Notice
          tone="destructive"
          title="Couldn’t load the departments"
          action={
            <Button size="sm" onClick={() => departments.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(departments.error)}
        </Notice>
      ) : departments.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="status">
          <span className="sr-only">Loading the departments…</span>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : active.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title="No departments yet"
          description="Start with one for the work you hand off most: research, writing, operations. You can add more any time."
          action={
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <Plus aria-hidden />
              New department
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Departments">
          {active.map((department) => (
            <li key={department.id} className="flex">
              <DepartmentCard
                department={department}
                agents={agents.data ?? []}
                openTasks={openTasks.get(department.id) ?? 0}
                schedules={scheduleCount.get(department.id) ?? 0}
              />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <section className="mt-10 flex flex-col gap-2" aria-label="Archived departments">
          <button
            type="button"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen((open) => !open)}
            className={cn(
              'flex w-fit cursor-pointer items-center gap-1.5 rounded-md text-label text-muted-foreground outline-hidden hover:text-foreground',
              colorTransition,
              focusRingInset,
            )}
          >
            <ChevronDown
              aria-hidden
              className={cn('size-icon-sm transition-transform', !archivedOpen && '-rotate-90')}
            />
            {plural(archived.length, 'archived department')}
          </button>
          {archivedOpen ? (
            <ul className="flex flex-col">
              {archived.map((department) => (
                <li key={department.id}>
                  <Link
                    to={`/departments/${encodeURIComponent(department.slug)}`}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body-sm text-muted-foreground outline-hidden hover:bg-fill-subtle hover:text-foreground',
                      colorTransition,
                      focusRingInset,
                    )}
                  >
                    <span aria-hidden className="size-2 rounded-full bg-placeholder" />
                    <span className="min-w-0 flex-1 truncate">{department.name}</span>
                    <span className="text-caption">
                      Archived {formatDate(department.archivedAt ?? department.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <NewDepartmentDialog open={newOpen} onOpenChange={setNewOpen} />
    </Page>
  );
}

function DepartmentCard({
  department,
  agents,
  openTasks,
  schedules,
}: {
  department: Department;
  agents: readonly AgentDefinition[];
  openTasks: number;
  schedules: number;
}) {
  const tone = departmentTone(department.slug);
  const { lead, specialists } = teamOf(department, agents);
  const titleId = `department-${department.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className="relative flex w-full flex-col gap-3 rounded-xl bg-card p-4 shadow-raised hover:[--surface-tint:var(--fill-subtle)]"
    >
      <Link
        to={`/departments/${encodeURIComponent(department.slug)}`}
        aria-labelledby={titleId}
        className={cn('absolute inset-0 rounded-xl outline-hidden', focusRingInset)}
      />
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', TONE_DOT[tone])} />
        <h2 id={titleId} className="min-w-0 truncate text-card-title text-foreground">
          {department.name}
        </h2>
      </div>
      <p className="line-clamp-2 min-h-10 text-body-sm text-muted-foreground">
        {department.description || 'No description yet.'}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        {lead ? (
          <>
            <Avatar name={lead.name} tone={tone} size="sm" />
            <span className="min-w-0 truncate text-label text-foreground">{lead.name}</span>
            <span className="text-caption text-muted-foreground">leads</span>
          </>
        ) : (
          <Badge tone="orange" dot>
            No lead yet
          </Badge>
        )}
        {specialists.length > 0 ? (
          <span
            className="ml-auto flex items-center"
            title={specialists.map((agent) => agent.name).join(', ')}
          >
            {specialists.slice(0, 4).map((agent) => (
              <Avatar
                key={agent.id}
                name={agent.name}
                size="sm"
                className="-ml-1.5 ring-2 ring-card first:ml-0"
              />
            ))}
            {specialists.length > 4 ? (
              <span className="ml-1 text-meta text-muted-foreground">+{specialists.length - 4}</span>
            ) : null}
            <span className="sr-only">{plural(specialists.length, 'specialist')}</span>
          </span>
        ) : null}
      </div>
      <p className="mt-auto flex items-center gap-1.5 border-t border-border pt-3 text-caption text-muted-foreground">
        <span>{plural(openTasks, 'open task')}</span>
        <span aria-hidden>·</span>
        <span>{plural(schedules, 'schedule')}</span>
        {department.autoClose ? (
          <>
            <span aria-hidden>·</span>
            <span>Closes tasks itself</span>
          </>
        ) : null}
      </p>
    </article>
  );
}
