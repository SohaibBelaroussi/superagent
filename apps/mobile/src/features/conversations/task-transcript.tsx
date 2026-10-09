import { errorMessage, type OrgLookup } from '@superagent/client';
import type { Task } from '@superagent/shared';
import { TERMINAL_PHASES } from '@superagent/shared/phases';
import { ChevronsUp } from 'lucide-react-native';
import { View } from 'react-native';
import { useConversation } from '../../api/conversations';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { radius, space } from '../../ui/theme';
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
      <View accessibilityLabel="Loading the transcript" style={{ gap: space.md }}>
        <Skeleton style={{ height: 64, borderRadius: radius.card }} />
        <Skeleton style={{ height: 16, width: '50%' }} />
        <Skeleton style={{ height: 16, width: '66%' }} />
      </View>
    );
  }
  if (history.isError) {
    return (
      <Notice tone="destructive" title="Couldn’t load the transcript">
        {errorMessage(history.error)}
      </Notice>
    );
  }
  if (messages.length === 0 && arrived.length === 0 && turns.length === 0) {
    return (
      <EmptyState
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
    <View style={{ gap: space.xl }}>
      {history.hasNextPage ? (
        <Button
          title="Earlier messages"
          variant="ghost"
          size="sm"
          icon={ChevronsUp}
          busy={history.isFetchingNextPage}
          onPress={() => void history.fetchNextPage()}
          style={{ alignSelf: 'flex-start' }}
        />
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
    </View>
  );
}
