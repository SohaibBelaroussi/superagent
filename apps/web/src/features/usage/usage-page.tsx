import type { UsageGroup, UsageReport } from '@superagent/shared';
import { ChartColumn } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { useSettings } from '../../api/org';
import { useUsage } from '../../api/queries';
import { cn } from '../../lib/cn';
import { formatCost, formatTokens, plural } from '../../lib/format';
import { addDays, dayIn, startOfDayIn } from '../../lib/timezones';
import { useDocumentTitle } from '../../lib/title';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Page, PageHeader, Panel, Section } from '../../ui/layout';
import { raisedSurface } from '../../ui/recipes';
import { Segmented } from '../../ui/tabs';
import { useOrg } from '../tasks/org';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const;
type Range = (typeof RANGES)[number]['value'];
const isRange = (value: string | null): value is Range => RANGES.some((range) => range.value === value);

/**
 * When a period starts: the start of the day `range - 1` days before today in `timezone`, so "7 days" is
 * the last seven days, today included. Stable all day long.
 */
export function rangeStart(range: Range, timezone?: string, now = new Date()): string | undefined {
  if (range === 'all') return undefined;
  return startOfDayIn(addDays(dayIn(now, timezone), -(Number(range) - 1)), timezone).toISOString();
}

/** The most days the chart covers, the newest kept: about ten years. */
const MAX_DAYS = 3_660;
/** The most bars the chart draws: past that, each bar is a run of days. */
const MAX_BARS = 90;

/**
 * Every day ("YYYY-MM-DD") from `start` (or the first of `days`) to `end` (or the last of them), the
 * ones without calls included; at most `MAX_DAYS`, the newest.
 */
export function fillDays(days: readonly string[], start?: string, end?: string): string[] {
  const sorted = [...days].sort();
  const final = [end, sorted.at(-1)].filter(Boolean).sort().at(-1);
  let first = [start, sorted[0]].filter(Boolean).sort()[0];
  if (!first || !final) return [];
  const earliest = addDays(final, -(MAX_DAYS - 1));
  if (first < earliest) first = earliest;
  const out: string[] = [];
  const day = new Date(`${first}T00:00:00Z`);
  const last = new Date(`${final}T00:00:00Z`);
  while (day <= last) {
    out.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

/**
 * The days as bars: one each, or in runs of equal length when there are more than `max`. The newest run
 * ends on the last day; the oldest may be shorter.
 */
export function runsOf(days: readonly string[], max = MAX_BARS): string[][] {
  if (days.length <= max) return days.map((day) => [day]);
  const size = Math.ceil(days.length / max);
  const runs: string[][] = [];
  for (let end = days.length; end > 0; end -= size) runs.unshift(days.slice(Math.max(0, end - size), end));
  return runs;
}

/** The built-in agents, which aren't in the organization. */
const BUILT_IN_AGENTS: Record<string, string> = {
  chief: 'Chief of staff',
  scratch: 'Scratch',
  'provider-test': 'Provider test',
  'provider-test-tools': 'Provider test (tools)',
};

/** What model calls cost and used, at the price of the day of each call: by day and by what made them. */
export function UsagePage() {
  useDocumentTitle('Usage');
  const [params, setParams] = useSearchParams();
  const requested = params.get('range');
  const range: Range = isRange(requested) ? requested : '30';
  // The API puts calls in the owner's days (the settings' timezone): periods and bars start with them.
  const settings = useSettings();
  const timezone = settings.data?.timezone;
  const from = rangeStart(range, timezone);
  const days = useUsage('day', from, !settings.isPending);
  // A period without calls: whether there were any before it.
  const ever = useUsage('model', undefined, range !== 'all' && days.data?.total.calls === 0);

  return (
    <Page
      width="medium"
      header={
        <PageHeader
          title="Usage"
          description="Tokens and cost of every model call, priced as it happened. Calls to a model without a price count their tokens but cost nothing."
          actions={
            <Segmented
              aria-label="Period"
              value={range}
              onValueChange={(next) => setParams(next === '30' ? {} : { range: next }, { replace: true })}
              options={RANGES}
            />
          }
        />
      }
    >
      {days.isError ? (
        <Notice
          tone="destructive"
          title="Couldn’t load the usage"
          action={
            <Button size="sm" onClick={() => days.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(days.error)}
        </Notice>
      ) : days.isPending ? (
        <div className="flex flex-col gap-3" role="status">
          <span className="sr-only">Loading the usage…</span>
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : days.data.total.calls === 0 && range !== 'all' && ever.isPending ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : days.data.total.calls === 0 && range !== 'all' && (ever.data?.total.calls ?? 0) > 0 ? (
        <EmptyState
          icon={<ChartColumn />}
          title={`No model calls in the last ${range} days`}
          description="The ones before are under All time."
          action={
            <Button onClick={() => setParams({ range: 'all' }, { replace: true })}>Show all time</Button>
          }
        />
      ) : days.data.total.calls === 0 ? (
        <EmptyState
          icon={<ChartColumn />}
          title="No model calls yet"
          description="Once agents work on tasks, what they use shows here, by day, department, model, agent and task."
        />
      ) : (
        <div className="flex flex-col gap-8">
          <Totals report={days.data} />
          <Section title="By day">
            <DayChart report={days.data} from={from} timezone={timezone} />
          </Section>
          <Breakdown group="department" title="By department" from={from} />
          <Breakdown group="model" title="By model" from={from} />
          <Breakdown group="agent" title="By agent" from={from} />
          <Breakdown group="task" title="By task" from={from} limit={15} />
        </div>
      )}
    </Page>
  );
}

function Totals({ report }: { report: UsageReport }) {
  const { total } = report;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Cost', value: formatCost(total.costUsd) },
          { label: 'Tokens', value: formatTokens(total.totalTokens) },
          {
            label: 'In · out',
            value: `${formatTokens(total.inputTokens)} · ${formatTokens(total.outputTokens)}`,
          },
          { label: 'Model calls', value: total.calls.toLocaleString() },
        ].map((stat) => (
          <div key={stat.label} className={cn('flex flex-col gap-1 rounded-xl px-4 py-3', raisedSurface)}>
            <dt className="text-caption text-muted-foreground">{stat.label}</dt>
            <dd className="text-heading text-foreground tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      {total.unpricedCalls > 0 ? (
        <Notice tone="warning">
          {plural(total.unpricedCalls, 'call')} went to models without a price, so their cost isn’t counted.{' '}
          <Link to="/settings/models" className="text-foreground underline underline-offset-2">
            Set prices
          </Link>
          .
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * A bar for each day of the period, today included (for a long period, each bar a run of days): cost
 * when there is any, else tokens.
 */
function DayChart({
  report,
  from,
  timezone,
}: {
  report: UsageReport;
  from: string | undefined;
  timezone: string | undefined;
}) {
  const priced = report.total.costUsd > 0;
  const [measure, setMeasure] = useState<'cost' | 'tokens'>(priced ? 'cost' : 'tokens');
  const byDay = new Map(report.items.map((item) => [item.key ?? '', item]));
  const days = fillDays(
    report.items.map((item) => item.key ?? '').filter(Boolean),
    from ? dayIn(new Date(from), timezone) : undefined,
    dayIn(new Date(), timezone),
  );
  const runs = runsOf(days);
  // The newest run is a full one.
  const perBar = runs.at(-1)?.length ?? 1;
  const value = (run: readonly string[]) =>
    run.reduce((sum, day) => {
      const item = byDay.get(day);
      return sum + (item ? (measure === 'cost' ? item.costUsd : item.totalTokens) : 0);
    }, 0);
  const max = Math.max(...runs.map(value), 0);
  const label = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const runLabel = (run: readonly string[]) =>
    run.length === 1 ? label(run[0] ?? '') : `${label(run[0] ?? '')} – ${label(run.at(-1) ?? '')}`;
  const shown = measure === 'cost' ? 'Cost' : 'Tokens';

  return (
    <Panel className="flex flex-col gap-3 p-4">
      <Segmented
        aria-label="Show"
        size="sm"
        className="self-end"
        value={measure}
        onValueChange={setMeasure}
        options={[
          { value: 'cost', label: 'Cost' },
          { value: 'tokens', label: 'Tokens' },
        ]}
      />
      {/* No gap between slots: each bar takes most of its slot, so even a long period's stay visible. */}
      <ol
        className="flex h-40 items-end"
        aria-label={runs.length === days.length ? `${shown} by day` : `${shown}, ${perBar} days a bar`}
      >
        {runs.map((run) => {
          const amount = value(run);
          const text = measure === 'cost' ? formatCost(amount) : `${formatTokens(amount)} tokens`;
          return (
            <li
              key={run[0]}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              title={`${runLabel(run)}: ${text}`}
            >
              <span className="sr-only">
                {runLabel(run)}: {text}
              </span>
              <span
                aria-hidden
                className={cn(
                  'block w-[70%] max-w-6 rounded-t-[3px]',
                  amount > 0 ? 'bg-foreground/70' : 'bg-fill',
                )}
                style={{ height: `${max > 0 ? Math.max(2, (amount / max) * 100) : 2}%` }}
              />
            </li>
          );
        })}
      </ol>
      <div className="flex justify-between gap-3 text-caption text-muted-foreground">
        <span>{days[0] ? label(days[0]) : ''}</span>
        {runs.length < days.length ? <span>{perBar} days a bar</span> : null}
        <span>{days.at(-1) ? label(days.at(-1) ?? '') : ''}</span>
      </div>
    </Panel>
  );
}

/** Totals by department, model, agent or task: the biggest first, each a share of the whole. */
function Breakdown({
  group,
  title,
  from,
  limit,
}: {
  group: Exclude<UsageGroup, 'day'>;
  title: string;
  from: string | undefined;
  limit?: number;
}) {
  const org = useOrg();
  const usage = useUsage(group, from);
  const items = usage.data?.items ?? [];
  const shown = limit ? items.slice(0, limit) : items;
  const priced = (usage.data?.total.costUsd ?? 0) > 0;
  const whole = priced ? (usage.data?.total.costUsd ?? 0) : (usage.data?.total.totalTokens ?? 0);

  const name = (key: string | null, label: string) => {
    if (!key) return { text: label };
    if (group === 'department') {
      const department = org.department(key);
      return {
        text: department?.name ?? label,
        to: department ? `/departments/${department.slug}` : undefined,
      };
    }
    if (group === 'agent') {
      const agent = org.agentByKey(key);
      return {
        text: agent?.name ?? BUILT_IN_AGENTS[key] ?? label,
        to: agent ? `/agents/${encodeURIComponent(agent.key)}` : undefined,
      };
    }
    if (group === 'task') return { text: label, to: `/tasks/${key}` };
    return { text: label };
  };

  return (
    <Section title={title}>
      {usage.isPending ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : usage.isError ? (
        <Notice tone="destructive">{errorMessage(usage.error)}</Notice>
      ) : (
        <ul className={cn('divide-y divide-border rounded-xl', raisedSurface)} aria-label={title}>
          {shown.map((item) => {
            const { text, to } = name(item.key, item.label);
            const share = whole > 0 ? ((priced ? item.costUsd : item.totalTokens) / whole) * 100 : 0;
            return (
              <li key={item.key ?? 'none'} className="flex flex-col gap-1.5 px-4 py-2.5">
                <div className="flex items-baseline gap-3">
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-body-sm text-foreground',
                      group === 'model' && 'font-mono',
                    )}
                  >
                    {to ? (
                      <Link to={to} className="hover:underline hover:underline-offset-2">
                        {text}
                      </Link>
                    ) : (
                      text
                    )}
                  </span>
                  <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                    {formatTokens(item.totalTokens)} tokens · {plural(item.calls, 'call')}
                  </span>
                  <span className="w-16 shrink-0 text-right text-label text-foreground tabular-nums">
                    {formatCost(item.costUsd)}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-fill" aria-hidden>
                  <div className="h-full rounded-full bg-foreground/60" style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
          {limit && items.length > limit ? (
            <li className="px-4 py-2 text-caption text-muted-foreground">
              And {plural(items.length - limit, 'more task')}.
            </li>
          ) : null}
        </ul>
      )}
    </Section>
  );
}
