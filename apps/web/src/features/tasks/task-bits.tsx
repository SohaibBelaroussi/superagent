import {
  departmentTone,
  formatCost,
  formatDate,
  formatRelative,
  formatTokens,
  PHASES,
  PRIORITIES,
} from '@superagent/client';
import type { Department, Task, TaskPhase, TaskPriority, UsageTotals } from '@superagent/shared';
import { CalendarClock, Repeat, Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';
import { TONE_DOT } from '../../lib/tones';
import { Badge } from '../../ui/badge';
import { focusRing } from '../../ui/recipes';
import { Tooltip } from '../../ui/tooltip';

export function PhaseBadge({ phase, size = 'sm' }: { phase: TaskPhase; size?: 'xs' | 'sm' | 'md' }) {
  const info = PHASES[phase];
  return (
    <Badge tone={info.tone} size={size} dot={info.live ? 'pulse' : true} title={info.description}>
      {info.label}
    </Badge>
  );
}

/** Only priorities that ask for attention get a badge; normal and low stay quiet. */
export function PriorityBadge({ priority, always = false }: { priority: TaskPriority; always?: boolean }) {
  if (!always && (priority === 'normal' || priority === 'low')) return null;
  const info = PRIORITIES[priority];
  return (
    <Badge tone={info.tone} size="xs" emphasis={priority === 'urgent' ? 'strong' : 'subtle'}>
      {info.label}
    </Badge>
  );
}

export function DepartmentLabel({ department, className }: { department?: Department; className?: string }) {
  if (!department) return <span className={cn('text-muted-foreground', className)}>Unknown department</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[departmentTone(department.slug)])}
      />
      <span className="truncate">{department.name}</span>
    </span>
  );
}

/** Where a task came from, when it wasn't the owner. */
export function SourceBadge({ task }: { task: Task }) {
  if (task.source === 'schedule') {
    return (
      <Badge size="xs" icon={<Repeat aria-hidden />} title="Created by a schedule">
        Scheduled
      </Badge>
    );
  }
  if (task.source === 'chief') {
    return (
      <Badge size="xs" icon={<Sparkles aria-hidden />} title="Assigned by your chief of staff">
        Chief
      </Badge>
    );
  }
  return null;
}

export function DueBadge({ task }: { task: Task }) {
  if (!task.dueAt) return null;
  const open = !task.closedAt;
  const overdue = open && Date.parse(task.dueAt) < Date.now();
  return (
    <Badge
      size="xs"
      tone={overdue ? 'red' : 'neutral'}
      icon={<CalendarClock aria-hidden />}
      title={overdue ? `Overdue since ${formatRelative(task.dueAt)}` : `Due ${formatRelative(task.dueAt)}`}
    >
      {overdue ? 'Overdue' : `Due ${formatDate(task.dueAt)}`}
    </Badge>
  );
}

/** "12.3k tokens · $0.04", with the breakdown on hover. Nothing before the first model call. */
export function UsageChip({ usage, className }: { usage: UsageTotals; className?: string }) {
  if (usage.calls === 0) return null;
  const detail = [
    `${formatTokens(usage.inputTokens)} in (${formatTokens(usage.cachedInputTokens)} cached)`,
    `${formatTokens(usage.outputTokens)} out`,
    `${usage.calls} model ${usage.calls === 1 ? 'call' : 'calls'}`,
    usage.unpricedCalls > 0 ? `${usage.unpricedCalls} without a price` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const cost = usage.costUsd > 0 || usage.unpricedCalls === 0 ? ` · ${formatCost(usage.costUsd)}` : '';
  // A button so keyboard users can reach the breakdown too; it does nothing when pressed.
  return (
    <Tooltip content={detail}>
      <button
        type="button"
        aria-label={`${formatTokens(usage.totalTokens)} tokens${cost}. ${detail}`}
        className={cn(
          'cursor-default rounded-sm text-meta text-muted-foreground tabular-nums outline-hidden',
          focusRing,
          className,
        )}
      >
        {formatTokens(usage.totalTokens)} tok{cost}
      </button>
    </Tooltip>
  );
}

/** How far along: the lead's percentage, else the share of its checklist that's done. */
export function taskProgress(task: Task): { percent: number; label: string } | null {
  const total = task.checklist.length;
  const done = task.checklist.filter((item) => item.done).length;
  if (task.progress !== null)
    return { percent: task.progress, label: total ? `${done}/${total}` : `${task.progress}%` };
  if (total > 0) return { percent: Math.round((done / total) * 100), label: `${done}/${total}` };
  return null;
}
