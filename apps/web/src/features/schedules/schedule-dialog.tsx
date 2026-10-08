import type { Schedule, TaskPriority, UpdateScheduleInput } from '@superagent/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage, ProblemError } from '../../api/client';
import { useSettings } from '../../api/org';
import { useCreateSchedule, useUpdateSchedule } from '../../api/schedules';
import { cn } from '../../lib/cn';
import { type CronDraft, checkCron, DEFAULT_CRON_DRAFT, formatFire, fromCron, toCron } from '../../lib/cron';
import { departmentTone, PRIORITIES, TONE_DOT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Notice, Spinner } from '../../ui/feedback';
import { Field, Input, Textarea } from '../../ui/field';
import { Select } from '../../ui/select';
import { Segmented } from '../../ui/tabs';
import { toast } from '../../ui/toast';
import { useOrg } from '../tasks/org';
import { WhenField } from './when-field';

const PRIORITY_OPTIONS = (['low', 'normal', 'high', 'urgent'] as const).map((value) => ({
  value,
  label: PRIORITIES[value].label,
}));

/** Codes the server answers a refused schedule with, which belong to the "When" field. */
const WHEN_CODES = new Set(['invalid_cron', 'invalid_timezone', 'schedule_too_frequent']);

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Sets up recurring work, or edits it (`schedule`): each time it comes due, a task with this brief goes
 * to the department's lead.
 */
export function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  departmentId: initialDepartment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: Schedule;
  departmentId?: string;
}) {
  const org = useOrg();
  const settings = useSettings();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [draft, setDraft] = useState<CronDraft>(DEFAULT_CRON_DRAFT);
  const [timezone, setTimezone] = useState('');
  const [errors, setErrors] = useState<{ department?: string; title?: string; brief?: string }>({});
  /** Why the server refused the schedule's timing; gone once you change it. */
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** The one the caller names, else one with a lead (its tasks start right away). */
  const defaultDepartment = () =>
    initialDepartment ??
    (org.departments.find((department) => department.lead) ?? org.departments[0])?.id ??
    null;

  // Each opening starts from the schedule (or fresh), not from what the last opening left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the dialog opens
  useEffect(() => {
    if (!open) return;
    setDepartmentId(schedule?.departmentId ?? defaultDepartment());
    setTitle(schedule?.title ?? '');
    setBrief(schedule?.brief ?? '');
    setPriority(schedule?.priority ?? 'normal');
    setDraft(schedule ? fromCron(schedule.cron) : DEFAULT_CRON_DRAFT);
    setTimezone(schedule?.timezone ?? settings.data?.timezone ?? browserTimezone());
    setErrors({});
    setRefused(undefined);
    setAttempted(false);
    setFailure(null);
  }, [open]);

  // The departments arrive after the dialog opened (from a link, on a fresh page): choose one then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the departments load
  useEffect(() => {
    if (open && !schedule && departmentId === null) setDepartmentId(defaultDepartment());
  }, [org.ready]);

  // Settings arrive after the dialog opened: a new schedule takes their timezone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when settings load
  useEffect(() => {
    if (open && !schedule && settings.data && timezone === browserTimezone())
      setTimezone(settings.data.timezone);
  }, [settings.data?.timezone]);

  const cron = toCron(draft);
  const check = cron && timezone ? checkCron(cron, timezone) : null;
  const department = departmentId ? org.department(departmentId) : undefined;
  const pending = create.isPending || update.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      department: department ? undefined : 'Choose a department.',
      title: title.trim() ? undefined : 'Give it a title: its tasks are named after it.',
      brief: brief.trim() ? undefined : 'Say what each run should do.',
    };
    setErrors(next);
    setAttempted(true);
    if (next.department || next.title || next.brief || !cron || !check?.ok || !department) return;
    setFailure(null);
    try {
      if (schedule) {
        const changes: UpdateScheduleInput = {};
        if (title.trim() !== schedule.title) changes.title = title.trim();
        if (brief.trim() !== schedule.brief) changes.brief = brief.trim();
        if (cron !== schedule.cron) changes.cron = cron;
        if (timezone !== schedule.timezone) changes.timezone = timezone;
        if (priority !== schedule.priority) changes.priority = priority;
        if (Object.keys(changes).length > 0) await update.mutateAsync({ id: schedule.id, ...changes });
        toast.success('Schedule saved');
      } else {
        await create.mutateAsync({
          departmentId: department.id,
          title: title.trim(),
          brief: brief.trim(),
          cron,
          timezone,
          priority,
        });
        toast.success(
          'Schedule set up',
          check?.ok && check.next[0]
            ? `It first runs ${formatFire(check.next[0], timezone)} (${timezone}).`
            : undefined,
        );
      }
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ProblemError && error.code && WHEN_CODES.has(error.code)) {
        setRefused(error.message);
      } else {
        setFailure(errorMessage(error));
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={schedule ? 'Edit schedule' : 'New schedule'}
      description="Each time it comes due, a task with this brief goes to the department’s lead."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="schedule" variant="primary" disabled={pending}>
            {pending ? <Spinner /> : null}
            {schedule ? 'Save schedule' : 'Set up schedule'}
          </Button>
        </>
      }
    >
      <form id="schedule" onSubmit={submit} className="flex flex-col gap-5 pb-1" noValidate>
        {failure ? <Notice tone="destructive">{failure}</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="Department" error={errors.department}>
            {(control) =>
              schedule ? (
                <p className="flex h-control-md items-center gap-2 text-body-sm text-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 rounded-full',
                      TONE_DOT[departmentTone(schedule.department?.slug ?? '')],
                    )}
                  />
                  {schedule.department?.name ?? 'Archived department'}
                </p>
              ) : (
                <Select
                  {...control}
                  value={departmentId}
                  onValueChange={setDepartmentId}
                  placeholder="Choose a department"
                  options={org.departments.map((item) => ({
                    value: item.id,
                    label: item.lead ? item.name : `${item.name} (no lead)`,
                    icon: (
                      <span
                        aria-hidden
                        className={cn('size-2 rounded-full', TONE_DOT[departmentTone(item.slug)])}
                      />
                    ),
                  }))}
                />
              )
            }
          </Field>
          <Field label="Priority">
            {() => (
              <Segmented
                aria-label="Priority"
                value={priority}
                onValueChange={setPriority}
                options={PRIORITY_OPTIONS}
              />
            )}
          </Field>
        </div>
        {department && !department.lead ? (
          <Notice tone="warning">
            {department.name} has no lead yet: its scheduled tasks wait in the inbox until it has one.
          </Notice>
        ) : null}

        <Field label="Title" error={errors.title} hint="Each run’s task is named after it.">
          {(control) => (
            <Input
              {...control}
              value={title}
              maxLength={200}
              placeholder="Weekly AI news digest"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <Field label="Brief" error={errors.brief} hint="What each run should do. Markdown works.">
          {(control) => (
            <Textarea
              {...control}
              value={brief}
              maxLength={20_000}
              rows={4}
              placeholder="Find the five most important AI releases of the past week, each with a source."
              onChange={(event) => setBrief(event.target.value)}
            />
          )}
        </Field>

        <WhenField
          draft={draft}
          onDraftChange={(next) => {
            setDraft(next);
            setRefused(undefined);
          }}
          timezone={timezone}
          onTimezoneChange={(next) => {
            setTimezone(next);
            setRefused(undefined);
          }}
          cron={cron}
          check={check}
          error={refused}
          incomplete={attempted && !cron}
        />
      </form>
    </Dialog>
  );
}
