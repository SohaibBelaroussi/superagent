import {
  type ConversationSource,
  ConversationStream,
  conversationId,
  conversationKey,
  conversationMessages,
  conversationQuery,
  initialLiveState,
  type LiveState,
  liveReducer,
  reconcile,
  sendToChief,
  stopChief,
} from '@superagent/client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer } from 'react';
import { useSession } from './session';

export type { ConversationSource, LivePart, ShownTurn } from '@superagent/client';

/** A conversation's history; `messages` are all loaded pages, oldest first. */
export function useConversationHistory(source: ConversationSource) {
  const query = useInfiniteQuery(conversationQuery(source));
  const messages = useMemo(() => conversationMessages(query.data?.pages), [query.data]);
  return { ...query, messages };
}

/**
 * Follows a conversation live while `enabled`, and a turn under way to its end even after that (a task
 * that closes mid-turn): the turn being taken, as it is written. Turns, and whatever reaches the agent,
 * refresh the history, where they end up.
 */
export function useLiveConversation(source: ConversationSource, enabled: boolean): LiveState {
  const queryClient = useQueryClient();
  const { state: session } = useSession();
  const token = session.status === 'signed-in' ? session.token : null;
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const id = conversationId(source);
  const follow = enabled || state.running;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` stands for `source`.
  useEffect(() => {
    if (!follow || !token) return;
    const stream = new ConversationStream(source, token, {
      onEvent: (event, at) => dispatch({ type: 'event', event, at }),
      onStatus: (status) => dispatch({ type: 'status', status }),
      onStale: () => void queryClient.invalidateQueries({ queryKey: conversationKey(source) }),
    });
    stream.start();
    return () => {
      stream.stop();
      dispatch({ type: 'status', status: 'connecting' });
    };
  }, [follow, token, id, queryClient]);

  return state;
}

/** A conversation: its history and the turn being taken, reconciled (see `reconcile`). */
export function useConversation(source: ConversationSource, options: { live: boolean }) {
  const history = useConversationHistory(source);
  const live = useLiveConversation(source, options.live);
  const reconciled = useMemo(
    () => reconcile(history.messages, live, history.dataUpdatedAt),
    [history.messages, live, history.dataUpdatedAt],
  );
  return { history, ...reconciled, active: live.running, status: live.status };
}

export function useSendToChief() {
  return useMutation({ mutationFn: sendToChief, meta: { silent: true } });
}

export function useStopChief() {
  return useMutation({ mutationFn: stopChief, meta: { failure: 'Couldn’t stop the chief' } });
}
