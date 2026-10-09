import { errorMessage } from '@superagent/client';
import type { ReactNode } from 'react';
import { Button } from '../ui/button';
import { Notice, Skeleton } from '../ui/feedback';

/**
 * A query's data handed to `children`, with a skeleton while it loads and a notice with a retry if it
 * fails. For parts of a page that wait on their own request.
 */
export function Loaded<T>({
  query,
  children,
  failure = 'Couldn’t load this',
  skeleton = <Skeleton className="h-32 rounded-xl" />,
}: {
  query: { data: T | undefined; isError: boolean; error: unknown; refetch: () => unknown };
  children: (data: T) => ReactNode;
  /** The notice's title when the request fails. */
  failure?: string;
  skeleton?: ReactNode;
}) {
  if (query.data !== undefined) return children(query.data);
  if (query.isError) {
    return (
      <Notice
        tone="destructive"
        title={failure}
        action={
          <Button size="sm" onClick={() => query.refetch()}>
            Retry
          </Button>
        }
      >
        {errorMessage(query.error)}
      </Notice>
    );
  }
  return skeleton;
}
