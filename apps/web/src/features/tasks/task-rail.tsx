import {
  departmentTone,
  formatCost,
  formatDateTime,
  formatTokens,
  type OrgLookup,
  PRIORITIES,
  taskProgress,
} from '@superagent/client';
import type { Artifact, Task } from '@superagent/shared';
import { Check, ExternalLink, FileText } from 'lucide-react';
import { Link } from 'react-router';
import { useTaskArtifacts } from '../../api/queries';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { Skeleton } from '../../ui/feedback';
import { DetailRow, Panel, ProgressBar } from '../../ui/layout';
import { Markdown, webUrl } from '../../ui/markdown';
import { RelativeTime } from '../../ui/time';

import { DepartmentLabel, PhaseBadge } from './task-bits';

function RailPanel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Panel className={cn('flex flex-col gap-2 px-4 py-3.5', className)}>
      <h2 className="text-column text-muted-foreground">{title}</h2>
      {children}
    </Panel>
  );
}

const SOURCE: Record<Task['source'], string> = {
  owner: 'You',
  chief: 'Your chief of staff',
  schedule: 'A schedule',
};

export function TaskDetails({ task, org }: { task: Task; org: OrgLookup }) {
  const department = org.department(task.departmentId);
  const lead = org.agent(task.leadAgentId);
  return (
    <RailPanel title="Details">
      <dl className="-my-1 flex flex-col">
        <DetailRow label="Phase">
          <PhaseBadge phase={task.phase} />
        </DetailRow>
        <DetailRow label="Priority">{PRIORITIES[task.priority].label}</DetailRow>
        <DetailRow label="Department">
          {department ? (
            <Link
              to={`/board?department=${encodeURIComponent(department.slug)}`}
              className="hover:underline hover:decoration-border-hover hover:underline-offset-4"
            >
              <DepartmentLabel department={department} />
            </Link>
          ) : (
            <DepartmentLabel department={undefined} />
          )}
        </DetailRow>
        <DetailRow label="Lead">
          {lead ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <Avatar
                name={lead.name}
                size="xs"
                tone={department ? departmentTone(department.slug) : 'neutral'}
              />
              <span className="truncate">{lead.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Not assigned yet</span>
          )}
        </DetailRow>
        <DetailRow label="Asked by">{SOURCE[task.source]}</DetailRow>
        {task.dueAt ? <DetailRow label="Due">{formatDateTime(task.dueAt)}</DetailRow> : null}
        <DetailRow label="Created">
          <RelativeTime iso={task.createdAt} />
        </DetailRow>
        <DetailRow label="Updated">
          <RelativeTime iso={task.updatedAt} />
        </DetailRow>
        {task.closedAt ? (
          <DetailRow label="Closed">
            <RelativeTime iso={task.closedAt} />
          </DetailRow>
        ) : null}
      </dl>
    </RailPanel>
  );
}

export function TaskChecklist({ task }: { task: Task }) {
  const progress = taskProgress(task);
  if (!progress && task.checklist.length === 0) return null;
  return (
    <RailPanel title="Progress">
      {progress ? (
        <div className="flex items-center gap-2">
          <ProgressBar value={progress.percent} />
          <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{progress.percent}%</span>
        </div>
      ) : null}
      {task.checklist.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1.5" aria-label="Checklist">
          {task.checklist.map((item, index) => (
            // The lead rewrites the whole list each time; position is its identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={index} className="flex items-start gap-2 text-body-sm">
              <span
                aria-hidden
                className={cn(
                  'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] shadow-[inset_0_0_0_1px_var(--border-strong)]',
                  item.done && 'bg-fill-inverse text-background shadow-none',
                )}
              >
                {item.done ? <Check className="size-2.5" strokeWidth={3} /> : null}
              </span>
              <span
                className={cn(
                  'min-w-0',
                  item.done
                    ? 'text-muted-foreground line-through decoration-border-hover'
                    : 'text-foreground',
                )}
              >
                <span className="sr-only">{item.done ? 'Done: ' : 'To do: '}</span>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </RailPanel>
  );
}

function ArtifactRow({ artifact }: { artifact: Artifact }) {
  // Only a web address is clickable: an agent could write anything in a URL field.
  const href = webUrl(artifact.url);
  if (artifact.kind === 'link' && href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-body-sm text-foreground hover:bg-fill-subtle"
      >
        <ExternalLink aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
      </a>
    );
  }
  return (
    <details className="group rounded-lg [&[open]]:bg-fill-subtle">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-body-sm text-foreground hover:bg-fill-subtle [&::-webkit-details-marker]:hidden">
        <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
      </summary>
      <div className="max-h-96 overflow-y-auto px-2 pt-1 pb-2.5">
        {artifact.content ? (
          <Markdown className="text-body-sm">{artifact.content}</Markdown>
        ) : (
          <p className="text-caption text-muted-foreground">{artifact.url ?? 'Empty.'}</p>
        )}
      </div>
    </details>
  );
}

export function TaskArtifacts({ taskId }: { taskId: string }) {
  const artifacts = useTaskArtifacts(taskId);
  if (artifacts.isPending) {
    return (
      <RailPanel title="Deliverables">
        <Skeleton className="h-6" />
      </RailPanel>
    );
  }
  if (!artifacts.data?.length) return null;
  return (
    <RailPanel title="Deliverables" className="px-2.5">
      <div className="-mt-0.5 flex flex-col gap-0.5">
        {artifacts.data.map((artifact) => (
          <ArtifactRow key={artifact.id} artifact={artifact} />
        ))}
      </div>
    </RailPanel>
  );
}

export function TaskUsage({ task }: { task: Task }) {
  const usage = task.usage;
  return (
    <RailPanel title="Usage">
      {usage.calls === 0 ? (
        <p className="text-body-sm text-muted-foreground">No model calls yet.</p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-title text-foreground tabular-nums">{formatCost(usage.costUsd)}</span>
            <span className="text-caption text-muted-foreground tabular-nums">
              {formatTokens(usage.totalTokens)} tokens · {usage.calls} {usage.calls === 1 ? 'call' : 'calls'}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-caption">
            <dt className="text-muted-foreground">Input</dt>
            <dd className="text-right text-foreground tabular-nums">{formatTokens(usage.inputTokens)}</dd>
            <dt className="text-muted-foreground">Cached input</dt>
            <dd className="text-right text-foreground tabular-nums">
              {formatTokens(usage.cachedInputTokens)}
            </dd>
            <dt className="text-muted-foreground">Output</dt>
            <dd className="text-right text-foreground tabular-nums">{formatTokens(usage.outputTokens)}</dd>
            <dt className="text-muted-foreground">Reasoning</dt>
            <dd className="text-right text-foreground tabular-nums">{formatTokens(usage.reasoningTokens)}</dd>
          </dl>
          {usage.unpricedCalls > 0 ? (
            <p className="text-caption text-muted-foreground">
              {usage.unpricedCalls} {usage.unpricedCalls === 1 ? 'call' : 'calls'} to a model without a price
              aren’t in the cost.
            </p>
          ) : null}
        </>
      )}
    </RailPanel>
  );
}
