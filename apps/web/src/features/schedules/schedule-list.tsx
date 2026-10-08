import type { Schedule } from '@superagent/shared';
import { Ellipsis, Pause, Pencil, Play, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { useSettings } from '../../api/org';
import { useBoard } from '../../api/queries';
import { useDeleteSchedule, useRunSchedule, useUpdateSchedule } from '../../api/schedules';
import { cn } from '../../lib/cn';
import { describeCron, formatFire } from '../../lib/cron';
import { departmentTone, TONE_DOT } from '../../lib/tones';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { Menu, MenuItem, MenuSeparator } from '../../ui/menu';
import { raisedSurface } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';
import { useOrg } from '../tasks/org';

/** Active schedules first, soonest next; paused ones after, by title. */
export function sortSchedules(schedules: readonly Schedule[]): Schedule[] {
  return [...schedules].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    if (a.nextFireAt && b.nextFireAt) return Date.parse(a.nextFireAt) - Date.parse(b.nextFireAt);
    return a.title.localeCompare(b.title);
  });
}

/** Schedules as rows: when each runs, when next, what it last made, and its actions. */
export function ScheduleList({
  schedules,
  showDepartment,
  readOnly = false,
  onEdit,
}: {
  schedules: readonly Schedule[];
  showDepartment: boolean;
  readOnly?: boolean;
  onEdit: (schedule: Schedule) => void;
}) {
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const remove = useDeleteSchedule();
  return (
    <>
      <ul className={cn('divide-y divide-border rounded-xl', raisedSurface)} aria-label="Schedules">
        {schedules.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            showDepartment={showDepartment}
            readOnly={readOnly}
            onEdit={() => onEdit(schedule)}
            onDelete={() => setDeleting(schedule)}
          />
        ))}
      </ul>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete “${deleting?.title ?? ''}”?`}
        description="It stops running. The tasks it made stay. This can’t be undone."
        confirmLabel="Delete schedule"
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Schedule deleted');
              setDeleting(null);
            },
            onError: () => setDeleting(null),
          });
        }}
      />
    </>
  );
}

function ScheduleRow({
  schedule,
  showDepartment,
  readOnly,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  showDepartment: boolean;
  readOnly: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const org = useOrg();
  const settings = useSettings();
  const update = useUpdateSchedule();
  const run = useRunSchedule();
  const board = useBoard();
  // The board has the last task when it's open or closed this week: name it by its number.
  const lastTask = board.data?.columns
    .flatMap((column) => column.tasks)
    .find((task) => task.id === schedule.lastTaskId);
  const paused = schedule.status === 'paused';
  const ownTimezone = settings.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const author = schedule.createdBy.startsWith('agent:')
    ? (org.agentByKey(schedule.createdBy.slice('agent:'.length))?.name ??
      schedule.createdBy.slice('agent:'.length))
    : 'you';
  const titleId = `schedule-${schedule.id}`;

  const setStatus = (status: 'active' | 'paused') =>
    update.mutate(
      { id: schedule.id, status },
      {
        onSuccess: () =>
          toast.success(
            status === 'paused' ? `Paused “${schedule.title}”` : `“${schedule.title}” runs again`,
          ),
        onError: (error) => toast.error('Couldn’t change the schedule', errorMessage(error)),
      },
    );

  return (
    <li aria-labelledby={titleId} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 id={titleId} className={cn('text-label', paused ? 'text-muted-foreground' : 'text-foreground')}>
            {schedule.title}
          </h3>
          {paused ? <Badge>Paused</Badge> : null}
          {showDepartment && schedule.department ? (
            <Link
              to={`/departments/${encodeURIComponent(schedule.department.slug)}?tab=schedules`}
              className="relative flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
            >
              <span
                aria-hidden
                className={cn('size-1.5 rounded-full', TONE_DOT[departmentTone(schedule.department.slug)])}
              />
              {schedule.department.name}
            </Link>
          ) : null}
        </div>
        <p className="text-body-sm text-foreground/90">
          {describeCron(schedule.cron) ?? <span className="font-mono">{schedule.cron}</span>}
          {schedule.timezone !== ownTimezone ? (
            <span className="text-muted-foreground"> ({schedule.timezone})</span>
          ) : null}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground">
          {schedule.nextFireAt && !paused ? (
            <span>
              Next <RelativeTime iso={schedule.nextFireAt} /> (
              {formatFire(new Date(schedule.nextFireAt), schedule.timezone)})
            </span>
          ) : (
            <span>Not running while paused</span>
          )}
          {schedule.lastFireAt ? (
            <>
              <span aria-hidden>·</span>
              <span>
                Last ran <RelativeTime iso={schedule.lastFireAt} />
                {schedule.lastTaskId ? (
                  <>
                    {', '}
                    <Link
                      to={`/tasks/${schedule.lastTaskId}`}
                      className="text-foreground/80 underline underline-offset-2 hover:text-foreground"
                    >
                      {lastTask ? `#${lastTask.number}` : 'its task'}
                    </Link>
                  </>
                ) : null}
              </span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>Set up by {author}</span>
        </p>
      </div>
      {readOnly ? null : (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            disabled={run.isPending}
            onClick={() =>
              run.mutate(schedule.id, {
                onSuccess: (task) =>
                  toast.success(
                    `Task #${task.number} created`,
                    schedule.department ? `Sent to ${schedule.department.name}.` : undefined,
                  ),
              })
            }
          >
            <Zap aria-hidden />
            Run now
          </Button>
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" tooltip={`More for “${schedule.title}”`}>
                <Ellipsis aria-hidden />
              </Button>
            }
          >
            <MenuItem icon={<Pencil aria-hidden />} onClick={onEdit}>
              Edit
            </MenuItem>
            {paused ? (
              <MenuItem icon={<Play aria-hidden />} onClick={() => setStatus('active')}>
                Resume
              </MenuItem>
            ) : (
              <MenuItem icon={<Pause aria-hidden />} onClick={() => setStatus('paused')}>
                Pause
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Trash2 aria-hidden />} destructive onClick={onDelete}>
              Delete…
            </MenuItem>
          </Menu>
        </div>
      )}
    </li>
  );
}
