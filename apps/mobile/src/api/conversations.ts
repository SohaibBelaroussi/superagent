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
import { useEffect, useMemo, useReducer, useState } from 'react';
import { AppState } from 'react-native';
import { watchNetwork } from './live';
import { useSession } from './session';

/*
 * The phone's hooks over the shared conversation code (`@superagent/client`, D47): the history in pages,
 * the turn being taken on the conversation's own stream, and the two reconciled.
 */

/** Out of the background, where the system stops connections anyway. */
function useInForeground(): boolean {
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state !== 'background'),
    );
    return () => subscription.remove();
  }, []);
  return foreground;
}

/** A conversation's history; `messages` are all loaded pages, oldest first. */
export function useConversationHistory(source: ConversationSource) {
  const query = useInfiniteQuery(conversationQuery(source));
  const messages = useMemo(() => conversationMessages(query.data?.pages), [query.data]);
  return { ...query, messages };
}

/**
 * Follows a conversation live while `enabled`, and a turn under way to its end even after that (a task
 * that closes mid-turn), as long as the app is in the foreground. Back from the background, the stream
 * opens again and sends the turn in progress from its start.
 */
export function useLiveConversation(source: ConversationSource, enabled: boolean): LiveState {
  const queryClient = useQueryClient();
  const { state: session } = useSession();
  const token = session.status === 'signed-in' ? session.session.token : null;
  const foreground = useInForeground();
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const id = conversationId(source);
  const follow = (enabled || state.running) && foreground;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` stands for `source`.
  useEffect(() => {
    if (!follow || !token) return;
    const stream = new ConversationStream(
      source,
      token,
      {
        onEvent: (event, at) => dispatch({ type: 'event', event, at }),
        onStatus: (status) => dispatch({ type: 'status', status }),
        onStale: () => void queryClient.invalidateQueries({ queryKey: conversationKey(source) }),
      },
      { watchOnline: watchNetwork },
    );
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

/** Your message to the chief. The screen shows how it went, next to the message: no toast. */
export function useSendToChief() {
  return useMutation({ mutationFn: sendToChief, meta: { silent: true } });
}

export function useStopChief() {
  return useMutation({ mutationFn: stopChief, meta: { failure: 'Couldn’t stop the chief' } });
}
