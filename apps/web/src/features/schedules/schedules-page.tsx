import { departmentTone, errorMessage } from '@superagent/client';
import type { Schedule } from '@superagent/shared';
import { CalendarClock, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useSchedules } from '../../api/schedules';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/title';
import { TONE_DOT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Page, PageHeader } from '../../ui/layout';
import { useOrg } from '../tasks/org';
import { ScheduleDialog } from './schedule-dialog';
import { ScheduleList, sortSchedules } from './schedule-list';

/** Every schedule, by department: recurring work, set up by you or by your agents. */
export function SchedulesPage() {
  useDocumentTitle('Schedules');
  const org = useOrg();
  const schedules = useSchedules();
  // The schedule stays while the dialog closes, so its title doesn't change on the way out.
  const [editing, setEditing] = useState<{ open: boolean; schedule?: Schedule }>({ open: false });
  const [params, setParams] = useSearchParams();

  // ?new=1 (the palette's "New schedule") opens the dialog, once.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setEditing({ open: true });
    setParams({}, { replace: true });
  }, [params, setParams]);

  const groups = new Map<string, Schedule[]>();
  for (const schedule of sortSchedules(schedules.data ?? [])) {
    groups.set(schedule.departmentId, [...(groups.get(schedule.departmentId) ?? []), schedule]);
  }

  return (
    <Page
      width="medium"
      header={
        <PageHeader
          title="Schedules"
          description="Recurring work: each time a schedule comes due, its department’s lead gets a new task. Your agents set them up too."
          actions={
            <Button
              variant="primary"
              onClick={() => setEditing({ open: true })}
              disabled={org.ready && org.departments.length === 0}
            >
              <Plus aria-hidden />
              New schedule
            </Button>
          }
        />
      }
    >
      {schedules.isError ? (
        <Notice
          tone="destructive"
          title="Couldn’t load the schedules"
          action={
            <Button size="sm" onClick={() => schedules.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(schedules.error)}
        </Notice>
      ) : schedules.isPending ? (
        <div className="flex flex-col gap-2" role="status">
          <span className="sr-only">Loading the schedules…</span>
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl opacity-60" />
        </div>
      ) : groups.size === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="No schedules yet"
          description="Set one up for work that repeats, like a Monday news digest or a monthly report. Or tell your chief of staff: “every Monday at 9, summarize the AI news”."
          action={
            org.departments.length > 0 ? (
              <Button variant="primary" onClick={() => setEditing({ open: true })}>
                <Plus aria-hidden />
                New schedule
              </Button>
            ) : (
              <Link to="/departments" className="text-label text-foreground underline underline-offset-4">
                Set up a department first
              </Link>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-7">
          {[...groups].map(([departmentId, items]) => {
            const department = org.department(departmentId) ?? null;
            const name = items[0]?.department?.name ?? department?.name ?? 'Archived department';
            const slug = items[0]?.department?.slug ?? department?.slug ?? '';
            return (
              <section key={departmentId} aria-label={name} className="flex flex-col gap-2.5">
                <h2 className="flex items-center gap-2 text-subheading text-foreground">
                  <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[departmentTone(slug)])} />
                  {name}
                </h2>
                <ScheduleList
                  schedules={items}
                  showDepartment={false}
                  readOnly={Boolean(department?.archivedAt)}
                  onEdit={(schedule) => setEditing({ open: true, schedule })}
                />
              </section>
            );
          })}
        </div>
      )}

      <ScheduleDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        schedule={editing.schedule}
      />
    </Page>
  );
}
