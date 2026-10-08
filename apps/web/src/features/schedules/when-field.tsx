import { Toggle } from '@base-ui/react/toggle';
import { CalendarClock, CircleAlert } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../../lib/cn';
import {
  type CronCheck,
  type CronDraft,
  describeCron,
  type Frequency,
  formatFire,
  HOUR_STEPS,
} from '../../lib/cron';
import { timezones } from '../../lib/timezones';
import { Input } from '../../ui/field';
import { colorTransition, focusRingInset } from '../../ui/recipes';
import { Select } from '../../ui/select';

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'hourly', label: 'Every few hours' },
  { value: 'custom', label: 'Custom (cron)' },
];

/** Monday first, as calendars show them; values are cron weekdays (Sunday is 0). */
const DAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 0, short: 'Sun', long: 'Sunday' },
];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

/**
 * When a schedule runs: a frequency and a time (or a cron as written), in a timezone, with what that
 * means in words and its next runs. `check` is the caller's `checkCron` of the cron this builds.
 */
export function WhenField({
  draft,
  onDraftChange,
  timezone,
  onTimezoneChange,
  cron,
  check,
  error,
  incomplete = false,
}: {
  draft: CronDraft;
  onDraftChange: (draft: CronDraft) => void;
  timezone: string;
  onTimezoneChange: (timezone: string) => void;
  cron: string | null;
  check: CronCheck | null;
  /** What the server said, when it refused the schedule. */
  error?: string;
  /** Saving was tried before the schedule was complete. */
  incomplete?: boolean;
}) {
  const id = useId();
  const patch = (next: Partial<CronDraft>) => onDraftChange({ ...draft, ...next });
  const timed = draft.frequency !== 'hourly' && draft.frequency !== 'custom';
  const described = cron ? describeCron(cron) : null;
  const missing =
    draft.frequency === 'weekly'
      ? 'Pick at least one day.'
      : draft.frequency === 'custom'
        ? 'Write the cron.'
        : 'Pick a time.';
  const problem =
    error ?? (check && !check.ok ? check.error : undefined) ?? (incomplete && !cron ? missing : undefined);

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1.5 text-label text-foreground">When</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="How often"
          aria-describedby={`${id}-preview`}
          value={draft.frequency}
          onValueChange={(frequency) =>
            // Custom starts from the cron the form makes now, to edit from there.
            patch(frequency === 'custom' ? { frequency, custom: cron ?? draft.custom } : { frequency })
          }
          options={FREQUENCIES}
          className="min-w-44"
        />
        {draft.frequency === 'monthly' ? (
          <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
            on day
            <Select
              aria-label="Day of the month"
              aria-describedby={`${id}-preview`}
              value={String(draft.dayOfMonth)}
              onValueChange={(day) => patch({ dayOfMonth: Number(day) })}
              options={DAYS_OF_MONTH}
              className="min-w-20"
            />
          </span>
        ) : null}
        {draft.frequency === 'hourly' ? (
          <span className="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
            every
            <Select
              aria-label="Every how many hours"
              aria-describedby={`${id}-preview`}
              value={String(draft.everyHours)}
              onValueChange={(hours) => patch({ everyHours: Number(hours) })}
              options={HOUR_STEPS.map((hours) => ({
                value: String(hours),
                label: hours === 1 ? '1 hour' : `${hours} hours`,
              }))}
              className="min-w-28"
            />
            at minute
            <Input
              aria-label="Minutes past the hour"
              aria-describedby={`${id}-preview`}
              type="number"
              inputMode="numeric"
              min={0}
              max={59}
              value={draft.minute}
              onChange={(event) =>
                patch({ minute: Math.max(0, Math.min(59, Number(event.target.value) || 0)) })
              }
              className="w-20"
            />
          </span>
        ) : null}
        {timed ? (
          <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
            at
            <Input
              aria-label="Time"
              aria-describedby={`${id}-preview`}
              type="time"
              required
              value={draft.time}
              onChange={(event) => patch({ time: event.target.value })}
              className="w-32"
            />
          </span>
        ) : null}
      </div>

      {draft.frequency === 'weekly' ? (
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">Days of the week</legend>
          {DAYS.map((day) => {
            const on = draft.days.includes(day.value);
            return (
              <Toggle
                key={day.value}
                pressed={on}
                aria-label={day.long}
                onPressedChange={(pressed) =>
                  patch({
                    days: pressed
                      ? [...draft.days.filter((value) => value !== day.value), day.value]
                      : draft.days.filter((value) => value !== day.value),
                  })
                }
                className={cn(
                  'h-control-sm min-w-12 cursor-pointer rounded-full px-2.5 text-label text-muted-foreground shadow-input outline-hidden hover:text-foreground',
                  'data-pressed:bg-fill-inverse data-pressed:text-background data-pressed:shadow-none',
                  colorTransition,
                  focusRingInset,
                )}
              >
                {day.short}
              </Toggle>
            );
          })}
        </fieldset>
      ) : null}

      {draft.frequency === 'custom' ? (
        <div className="flex flex-col gap-1.5">
          <Input
            aria-label="Cron"
            aria-describedby={`${id}-cron ${id}-preview`}
            value={draft.custom}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="0 9 * * 1-5"
            className="font-mono"
            onChange={(event) => patch({ custom: event.target.value })}
          />
          <p id={`${id}-cron`} className="text-caption text-muted-foreground">
            Five fields: minute, hour, day of the month, month, day of the week. A sixth in front counts
            seconds.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-tz`} className="text-caption text-muted-foreground">
          Timezone
        </label>
        <Input
          id={`${id}-tz`}
          aria-describedby={`${id}-preview`}
          list={`${id}-zones`}
          value={timezone}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => onTimezoneChange(event.target.value.trim())}
          className="sm:w-72"
        />
        <datalist id={`${id}-zones`}>
          {timezones(timezone).map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </div>

      <div
        id={`${id}-preview`}
        role="note"
        className={cn(
          'flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-body-sm',
          problem
            ? 'bg-destructive-subtle shadow-[inset_0_0_0_1px_var(--destructive-edge)]'
            : 'bg-fill-subtle shadow-rim',
        )}
      >
        {problem ? (
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive-indicator" />
        ) : (
          <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          {problem ? (
            <p className="text-foreground">{problem}</p>
          ) : !cron ? (
            <p className="text-muted-foreground">{missing}</p>
          ) : (
            <>
              <p className="text-foreground">
                {described ?? cron}
                {timezone ? <span className="text-muted-foreground"> ({timezone})</span> : null}
              </p>
              {check?.ok ? (
                <p className="text-caption text-muted-foreground">
                  Next: {check.next.map((date) => formatFire(date, timezone)).join(' · ')}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </fieldset>
  );
}
