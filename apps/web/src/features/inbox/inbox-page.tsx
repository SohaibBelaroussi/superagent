import type { Task } from '@superagent/shared';
import { Bell, CircleCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { useAttention, useBoard } from '../../api/queries';
import { notificationsSupported, useNotificationsOn } from '../../lib/notifications';
import { useDocumentTitle } from '../../lib/title';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Page, PageHeader, Panel } from '../../ui/layout';
import { Segmented } from '../../ui/tabs';
import { useOrg } from '../tasks/org';
import { InboxItem } from './inbox-items';
import { type AttentionKind, KIND_ORDER, KINDS } from './kinds';
import { toggleNotifications } from './notify';

type Filter = 'all' | AttentionKind;

const isKind = (value: string | null): value is AttentionKind =>
  value !== null && (KIND_ORDER as readonly string[]).includes(value);

/** Everything that waits for you, each with the action that settles it. */
export function InboxPage() {
  useDocumentTitle('Inbox');
  const attention = useAttention();
  const board = useBoard();
  const org = useOrg();
  const [params, setParams] = useSearchParams();
  const requested = params.get('kind');
  const filter: Filter = isKind(requested) ? requested : 'all';
  // Settled here (approved, answered, accepted): gone at once, before the list catches up.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const notifying = useNotificationsOn();

  const tasks = useMemo(() => {
    const byId = new Map<string, Task>();
    for (const column of board.data?.columns ?? []) for (const task of column.tasks) byId.set(task.id, task);
    return byId;
  }, [board.data]);
  // What blocks an agent first (calls to approve, questions), newest first within each kind.
  const items = (attention.data ?? [])
    .filter((item) => !settled.has(item.id))
    .sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.since.localeCompare(a.since),
    );
  const shown = filter === 'all' ? items : items.filter((item) => item.kind === filter);
  const counts = new Map<AttentionKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);

  // Every kind with something in it, and the one chosen even when it has emptied.
  const options = [
    { value: 'all' as Filter, label: <FilterLabel label="All" count={items.length} /> },
    ...KIND_ORDER.filter((kind) => counts.has(kind) || kind === filter).map((kind) => ({
      value: kind as Filter,
      label: <FilterLabel label={KINDS[kind].plural} count={counts.get(kind) ?? 0} />,
    })),
  ];

  return (
    <Page>
      <PageHeader
        title="Inbox"
        description="Everything that waits for you. Calls to approve and questions from leads come first: an agent is stopped until you answer."
        actions={
          <>
            {items.length > 0 ? (
              <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1">
                <Segmented
                  aria-label="Show"
                  size="sm"
                  value={filter}
                  onValueChange={(next) => setParams(next === 'all' ? {} : { kind: next }, { replace: true })}
                  options={options}
                />
              </div>
            ) : null}
            {notificationsSupported() && !notifying ? (
              <Button variant="ghost" size="sm" onClick={() => void toggleNotifications(false)}>
                <Bell aria-hidden />
                Notify me
              </Button>
            ) : null}
          </>
        }
      />
      {attention.isPending ? (
        <InboxSkeleton />
      ) : attention.isError ? (
        <Notice
          tone="destructive"
          title="Couldn’t load the inbox"
          action={
            <Button size="sm" onClick={() => attention.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(attention.error)}
        </Notice>
      ) : shown.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<CircleCheck />}
            title={
              filter === 'all' ? 'You’re all caught up' : `No ${KINDS[filter].plural.toLowerCase()} left`
            }
            description="Calls to approve, questions from leads and results to review show up here as they come."
          />
        </Panel>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Waiting for you">
          {shown.map((item) => (
            <li key={item.id}>
              <InboxItem
                item={item}
                task={item.taskId ? tasks.get(item.taskId) : undefined}
                org={org}
                onDone={() => setSettled((ids) => new Set(ids).add(item.id))}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function FilterLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="text-meta text-placeholder tabular-nums">{count}</span>
    </>
  );
}

function InboxSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">Loading the inbox…</span>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-28 rounded-xl" />
      ))}
    </div>
  );
}
