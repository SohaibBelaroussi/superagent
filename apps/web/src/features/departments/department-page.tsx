import type { Department, Schedule } from '@superagent/shared';
import { Building2, CalendarClock, Plus, Search } from 'lucide-react';
import { type ReactNode, useCallback, useDeferredValue, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { teamOf } from '../../api/org';
import { useAgents } from '../../api/queries';
import { useSchedules } from '../../api/schedules';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { useDocumentTitle } from '../../lib/title';
import { departmentTone, TONE_DOT } from '../../lib/tones';
import { UnsavedChangesDialog, useUnsavedChanges } from '../../lib/unsaved';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { Page, PageHeader, Panel } from '../../ui/layout';
import { TabCount, TabPanel, Tabs } from '../../ui/tabs';
import { BoardColumns } from '../board/board-columns';
import { ScheduleDialog } from '../schedules/schedule-dialog';
import { ScheduleList, sortSchedules } from '../schedules/schedule-list';
import { NewTaskDialog } from '../tasks/new-task-dialog';
import { useOrg } from '../tasks/org';
import { DepartmentSettings } from './department-settings';
import { NotesTab } from './notes';
import { TeamTab } from './team';

const TABS = ['board', 'team', 'schedules', 'notes', 'settings'] as const;
type DepartmentTab = (typeof TABS)[number];
const isTab = (value: string | null): value is DepartmentTab => TABS.includes(value as DepartmentTab);

/** A department: its board, team, schedules, notes and settings. */
export function DepartmentPage() {
  const { slug = '' } = useParams();
  const org = useOrg();
  const department = org.departmentBySlug(slug);
  useDocumentTitle(department?.name ?? 'Department');

  if (!department) {
    return (
      <Page>
        {org.ready ? (
          <EmptyState
            icon={<Building2 />}
            title="No such department"
            description={`There’s no department “${slug}”.`}
            action={
              <Link to="/departments" className="text-label text-foreground underline underline-offset-4">
                See the departments
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-4" role="status">
            <span className="sr-only">Loading the department…</span>
            <Skeleton className="h-10 w-64 rounded-full" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
        )}
      </Page>
    );
  }
  return <DepartmentView key={department.id} department={department} />;
}

function DepartmentView({ department }: { department: Department }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: DepartmentTab = isTab(requested) ? requested : 'board';
  const agents = useAgents();
  const schedules = useSchedules();
  const team = teamOf(department, agents.data ?? []);
  const own = sortSchedules(
    (schedules.data ?? []).filter((schedule) => schedule.departmentId === department.id),
  );
  const archived = Boolean(department.archivedAt);
  const [filter, setFilter] = useState('');
  const query = useDeferredValue(filter.trim());
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [scheduling, setScheduling] = useState<{ open: boolean; schedule?: Schedule }>({ open: false });

  // The notes and settings tabs stay mounted with what you typed; one blocker covers both.
  const [unsaved, setUnsaved] = useState({ notes: false, settings: false });
  const blocker = useUnsavedChanges(unsaved.notes || unsaved.settings);
  const notesUnsaved = useCallback((dirty: boolean) => setUnsaved((now) => ({ ...now, notes: dirty })), []);
  const settingsUnsaved = useCallback(
    (dirty: boolean) => setUnsaved((now) => ({ ...now, settings: dirty })),
    [],
  );

  const tone = departmentTone(department.slug);
  const specialists = team.specialists.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-5 sm:px-6 sm:pt-7">
        <PageHeader
          className="mb-4"
          eyebrow={
            <Link to="/departments" className="hover:text-foreground">
              Departments
            </Link>
          }
          title={
            <span className="flex items-center gap-2">
              <span aria-hidden className={cn('size-2.5 rounded-full', TONE_DOT[tone])} />
              {department.name}
            </span>
          }
          description={
            department.description ||
            (team.lead
              ? `Led by ${team.lead.name}${specialists ? `, with ${specialists} ${specialists === 1 ? 'specialist' : 'specialists'}` : ''}.`
              : undefined)
          }
          actions={
            archived ? undefined : (
              <>
                {tab === 'board' ? (
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
                ) : null}
                <Button variant="primary" onClick={() => setNewTaskOpen(true)}>
                  <Plus aria-hidden />
                  New task
                </Button>
              </>
            )
          }
        />
        {archived ? (
          <Notice
            tone="info"
            title={`Archived ${formatDate(department.archivedAt ?? department.updatedAt)}`}
            className="mb-4"
          >
            It takes no new tasks. Its tasks, notes and history stay for the record.
          </Notice>
        ) : null}
      </div>

      <Tabs
        className="flex min-h-0 flex-1 flex-col"
        listClassName="px-4 sm:px-6"
        value={tab}
        onValueChange={(next) => setParams(next === 'board' ? {} : { tab: next }, { replace: true })}
        items={[
          { value: 'board', label: 'Board' },
          {
            value: 'team',
            label: 'Team',
            meta: <TabCount>{(team.lead ? 1 : 0) + team.specialists.length}</TabCount>,
          },
          {
            value: 'schedules',
            label: 'Schedules',
            meta: own.length > 0 ? <TabCount>{own.length}</TabCount> : undefined,
          },
          { value: 'notes', label: 'Notes' },
          ...(archived ? [] : [{ value: 'settings' as const, label: 'Settings' }]),
        ]}
      >
        <TabPanel value="board" className="flex min-h-0 flex-1 flex-col pt-4">
          <BoardColumns departmentId={department.id} query={query} onNewTask={() => setNewTaskOpen(true)} />
        </TabPanel>
        <TabPanel value="team" className="min-h-0 flex-1 overflow-y-auto">
          <TabBody>
            <TeamTab department={department} team={team} readOnly={archived} />
          </TabBody>
        </TabPanel>
        <TabPanel value="schedules" className="min-h-0 flex-1 overflow-y-auto">
          <TabBody>
            {own.length > 0 ? (
              <div className="flex flex-col gap-3">
                {archived ? null : (
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => setScheduling({ open: true })}>
                      <Plus aria-hidden />
                      New schedule
                    </Button>
                  </div>
                )}
                <ScheduleList
                  schedules={own}
                  showDepartment={false}
                  readOnly={archived}
                  onEdit={(schedule) => setScheduling({ open: true, schedule })}
                />
              </div>
            ) : (
              <Panel>
                <EmptyState
                  compact
                  icon={<CalendarClock />}
                  title="No schedules"
                  description={`Work that repeats, like a weekly digest, can come to ${team.lead?.name ?? 'the lead'} on a schedule. ${team.lead?.name ?? 'The lead'} can set them up too.`}
                  action={
                    archived ? undefined : (
                      <Button onClick={() => setScheduling({ open: true })}>
                        <Plus aria-hidden />
                        New schedule
                      </Button>
                    )
                  }
                />
              </Panel>
            )}
          </TabBody>
        </TabPanel>
        <TabPanel value="notes" keepMounted className="min-h-0 flex-1 overflow-y-auto data-hidden:hidden">
          <TabBody>
            <NotesTab department={department} readOnly={archived} onUnsavedChange={notesUnsaved} />
          </TabBody>
        </TabPanel>
        {archived ? null : (
          <TabPanel
            value="settings"
            keepMounted
            className="min-h-0 flex-1 overflow-y-auto data-hidden:hidden"
          >
            <TabBody>
              <DepartmentSettings
                department={department}
                agents={[...(team.lead ? [team.lead] : []), ...team.specialists]}
                onUnsavedChange={settingsUnsaved}
              />
            </TabBody>
          </TabPanel>
        )}
      </Tabs>

      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} departmentId={department.id} />
      <ScheduleDialog
        open={scheduling.open}
        onOpenChange={(open) => setScheduling((current) => ({ ...current, open }))}
        schedule={scheduling.schedule}
        departmentId={department.id}
      />
      <UnsavedChangesDialog blocker={blocker} what={department.name} />
    </div>
  );
}

/** A tab's content, lined up with the header and as wide as a document. */
function TabBody({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pt-6 pb-12 sm:px-6">
      <div className="max-w-4xl">{children}</div>
    </div>
  );
}
