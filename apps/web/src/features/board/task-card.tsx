import { departmentTone } from '@superagent/client';
import type { AgentDefinition, AttentionItem, Department, Task } from '@superagent/shared';
import { CircleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { TONE_TEXT } from '../../lib/tones';
import { Avatar } from '../../ui/avatar';
import { ProgressBar } from '../../ui/layout';
import { focusRingInset } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { Tooltip } from '../../ui/tooltip';
import { attentionLine } from '../tasks/attention';
import {
  DepartmentLabel,
  DueBadge,
  PriorityBadge,
  SourceBadge,
  taskProgress,
  UsageChip,
} from '../tasks/task-bits';

/**
 * A task on the board. The whole card opens the task; the few things on it you can point at (the
 * usage figure, the status detail) sit above that link.
 */
export function TaskCard({
  task,
  department,
  lead,
  attention,
  showDepartment,
}: {
  task: Task;
  department?: Department;
  lead?: AgentDefinition;
  attention?: AttentionItem;
  showDepartment: boolean;
}) {
  const progress = task.closedAt ? null : taskProgress(task);
  const status = attention ? attentionLine(attention, task.title) : null;
  const titleId = `task-${task.id}-title`;
  return (
    <article
      aria-labelledby={titleId}
      className="group relative flex flex-col gap-2.5 rounded-card border border-surface-rim bg-fill-subtle p-3 transition-colors duration-150 hover:bg-fill-hover"
    >
      <Link
        to={`/tasks/${task.id}`}
        aria-labelledby={titleId}
        className={cn('absolute inset-0 rounded-card outline-hidden', focusRingInset)}
      />
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-placeholder">
        <span className="tabular-nums">#{task.number}</span>
        {showDepartment && department ? (
          <>
            <span aria-hidden>·</span>
            <DepartmentLabel department={department} className="min-w-0" />
          </>
        ) : null}
        <RelativeTime iso={task.updatedAt} className="ml-auto shrink-0" />
      </div>

      <h3 id={titleId} className="line-clamp-2 text-card-title text-foreground">
        {task.title}
      </h3>

      {/* Each chip renders only when it has something to say; with none, the row collapses. */}
      <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
        <PriorityBadge priority={task.priority} />
        <SourceBadge task={task} />
        <DueBadge task={task} />
      </div>

      {progress ? (
        <div className="flex items-center gap-2">
          <ProgressBar value={progress.percent} />
          <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{progress.label}</span>
        </div>
      ) : null}

      {status ? (
        <StatusLine text={status.text} detail={status.detail} toneClass={TONE_TEXT[status.tone]} />
      ) : null}

      <div className="flex min-h-5 items-center justify-between gap-2">
        {lead ? (
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
            <Avatar
              name={lead.name}
              size="xs"
              tone={department ? departmentTone(department.slug) : 'neutral'}
            />
            <span className="truncate">{lead.name}</span>
          </span>
        ) : (
          <span />
        )}
        <UsageChip usage={task.usage} className="relative z-10" />
      </div>
    </article>
  );
}

function StatusLine({ text, detail, toneClass }: { text: string; detail?: string; toneClass: string }) {
  const line = (
    <p
      tabIndex={detail ? 0 : undefined}
      className={cn(
        'relative z-10 flex w-fit max-w-full items-start gap-1.5 text-caption outline-hidden',
        toneClass,
        detail && 'cursor-help',
      )}
    >
      <CircleAlert aria-hidden className="mt-[3px] size-3 shrink-0" />
      <span className="min-w-0">{text}</span>
    </p>
  );
  if (!detail) return line;
  return (
    <Tooltip content={<span className="whitespace-pre-wrap">{detail}</span>} side="bottom" align="start">
      {line}
    </Tooltip>
  );
}
