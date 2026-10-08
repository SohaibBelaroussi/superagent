import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Page } from '../../ui/layout';
import type { OrgLookup } from './org';

/**
 * A page for a department or agent the lists don't have. They are fetched once more (it may be new:
 * made on another device, or a moment ago), and the page shows that it loads, that the lists failed,
 * or that there is no such thing.
 */
export function OrgMiss({
  org,
  name,
  icon,
  title,
  description,
}: {
  org: OrgLookup;
  /** The slug or key asked for: a new one is fetched for once more. */
  name: string;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  /** The name the lists were fetched again for: until then, it may still turn up. */
  const [askedFor, setAskedFor] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per name the loaded lists don't have
  useEffect(() => {
    if (!org.ready) return;
    org.refetch();
    setAskedFor(name);
  }, [org.ready, name]);
  const settled = org.ready && askedFor === name && !org.fetching;

  return (
    <Page>
      {org.error ? (
        <Notice
          tone="destructive"
          title="Couldn’t load the organization"
          action={
            <Button size="sm" onClick={() => org.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(org.error)}
        </Notice>
      ) : settled ? (
        <EmptyState
          icon={icon}
          title={title}
          description={description}
          action={
            <Link to="/departments" className="text-label text-foreground underline underline-offset-4">
              See the departments
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-4" role="status">
          <span className="sr-only">Loading…</span>
          <Skeleton className="h-10 w-64 rounded-full" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      )}
    </Page>
  );
}
