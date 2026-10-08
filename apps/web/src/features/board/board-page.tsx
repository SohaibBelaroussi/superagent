import { Plus, Search, SquareKanban } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useBoard } from '../../api/queries';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/title';
import { departmentTone, TONE_DOT } from '../../lib/tones';
import { Button, buttonVariants } from '../../ui/button';
import { EmptyState, Notice } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { PageHeader } from '../../ui/layout';
import { Select } from '../../ui/select';
import { NewTaskDialog } from '../tasks/new-task-dialog';
import { useOrg } from '../tasks/org';
import { BoardColumns, BoardSkeleton, matchesTask } from './board-columns';

const ALL = 'all';

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const org = useOrg();
  const slug = params.get('department');
  const department = slug ? org.departmentBySlug(slug) : undefined;
  useDocumentTitle(department ? department.name : 'Board');
  const waitingForDepartment = Boolean(slug) && !department && !org.ready;
  const board = useBoard(department?.id);
  const [filter, setFilter] = useState('');
  const query = useDeferredValue(filter.trim());
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const open = (board.data?.columns ?? [])
    .flatMap((column) => column.tasks)
    .filter((task) => !task.closedAt).length;
  const unknownDepartment = Boolean(slug) && org.ready && !department;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-5 sm:px-6 sm:pt-7">
        <PageHeader
          className="mb-5"
          eyebrow={department ? 'Board' : undefined}
          title={
            department ? (
              <Link
                to={`/departments/${encodeURIComponent(department.slug)}`}
                className="flex items-center gap-2 hover:underline hover:underline-offset-4"
              >
                <span
                  aria-hidden
                  className={cn('size-2.5 rounded-full', TONE_DOT[departmentTone(department.slug)])}
                />
                {department.name}
              </Link>
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
      ) : waitingForDepartment ? (
        <BoardSkeleton />
      ) : org.ready && org.departments.length === 0 ? (
        <EmptyState
          icon={<SquareKanban />}
          title="No departments yet"
          description="Tasks go to departments, each with a lead who plans the work. Set up your first one."
          action={
            <Link to="/departments" className={buttonVariants({ variant: 'primary' })}>
              Set up a department
            </Link>
          }
        />
      ) : (
        <BoardColumns departmentId={department?.id} query={query} onNewTask={() => setNewTaskOpen(true)} />
      )}

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        departmentId={department?.id}
        onCreated={(task) => {
          // A filter that hides the new card would look like nothing happened.
          if (query && !matchesTask(task, query)) setFilter('');
        }}
      />
    </div>
  );
}
