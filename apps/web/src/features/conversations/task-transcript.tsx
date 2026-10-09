import { errorMessage, type OrgLookup } from '@superagent/client';
import type { Task } from '@superagent/shared';
import { TERMINAL_PHASES } from '@superagent/shared/phases';
import { ChevronsUp, MessagesSquare } from 'lucide-react';
import { useConversation } from '../../api/conversations';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton, Spinner } from '../../ui/feedback';

import { ConversationList } from './conversation-list';
import { useSpeakers } from './message-views';

/**
 * The lead's side of a task: the brief it got, what it said and did (its specialists' answers
 * included), and what you or the chief sent it. Live while the task is with the lead.
 */
export function TaskTranscript({ task, org }: { task: Task; org: OrgLookup }) {
  const live = task.phase !== 'inbox' && !TERMINAL_PHASES.has(task.phase);
  const { history, messages, arrived, turns, running } = useConversation(
    { kind: 'task', taskId: task.id },
    { live },
  );
  const speaker = useSpeakers(org);
  const lead = org.agent(task.leadAgentId)?.key ?? org.department(task.departmentId)?.lead?.key ?? null;

  if (history.isPending) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading the transcript…</span>
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (history.isError) {
    return (
      <Notice
        tone="destructive"
        title="Couldn’t load the transcript"
        action={
          <Button size="sm" onClick={() => history.refetch()}>
            Retry
          </Button>
        }
      >
        {errorMessage(history.error)}
      </Notice>
    );
  }
  if (messages.length === 0 && arrived.length === 0 && turns.length === 0) {
    return (
      <EmptyState
        compact
        icon={<MessagesSquare />}
        title="Nothing yet"
        description={
          task.phase === 'inbox'
            ? 'The transcript starts when the task goes to its lead.'
            : 'The lead’s work shows up here as it happens.'
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {history.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={history.isFetchingNextPage}
          onClick={() => history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? <Spinner className="size-3.5" /> : <ChevronsUp aria-hidden />}
          Earlier messages
        </Button>
      ) : null}
      <ConversationList
        messages={messages}
        arrived={arrived}
        turns={turns}
        running={running}
        org={org}
        speaker={speaker}
        defaultAgent={lead}
      />
    </div>
  );
}
