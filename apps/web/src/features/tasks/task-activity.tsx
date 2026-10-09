import { errorMessage } from '@superagent/client';
import { ChevronsUp } from 'lucide-react';
import { useState } from 'react';
import { useTaskEvents } from '../../api/queries';
import { cn } from '../../lib/cn';
import { TONE_TEXT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { Notice, Skeleton } from '../../ui/feedback';
import { RelativeTime } from '../../ui/time';
import { condenseEvents, describeEvent } from './events';
import type { OrgLookup } from './org';

/** How much history shows at first; the rest is one click away. */
const SHOWN = 200;

/** The task's history, oldest first: who did what, with the notes and messages that came with it. */
export function TaskActivity({ taskId, org }: { taskId: string; org: OrgLookup }) {
  const events = useTaskEvents(taskId);
  const [showAll, setShowAll] = useState(false);

  if (events.isPending) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <span className="sr-only">Loading the history…</span>
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
    );
  }
  if (events.isError) return <Notice tone="destructive">{errorMessage(events.error)}</Notice>;

  const condensed = condenseEvents(events.data);
  const hidden = showAll ? 0 : Math.max(0, condensed.length - SHOWN);
  const items = hidden ? condensed.slice(hidden) : condensed;
  return (
    <div className="flex flex-col gap-3">
      {hidden ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAll(true)}>
          <ChevronsUp aria-hidden />
          Show {hidden} earlier {hidden === 1 ? 'entry' : 'entries'}
        </Button>
      ) : null}
      <ol className="flex flex-col" aria-label="History">
        {items.map((event, index) => {
          const described = describeEvent(event, org);
          const Icon = described.icon;
          const last = index === items.length - 1;
          return (
            <li key={event.seq} className={cn('relative flex gap-3', !last && 'pb-4')}>
              {last ? null : <span aria-hidden className="absolute top-7 bottom-1 left-3 w-px bg-border" />}
              <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-card shadow-rim">
                <Icon aria-hidden className={cn('size-3.5', TONE_TEXT[described.tone])} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1 pt-[3px]">
                <p className="text-body-sm text-foreground">
                  {described.title}
                  <span className="ml-2 text-caption text-placeholder">
                    <RelativeTime iso={event.createdAt} />
                  </span>
                </p>
                {described.detail ? (
                  <p className="line-clamp-6 text-body-sm whitespace-pre-wrap text-muted-foreground">
                    {described.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
