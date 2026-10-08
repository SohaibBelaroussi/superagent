import {
  ChiefMessageResultSchema,
  ChiefStopResultSchema,
  type ConversationMessage,
  ConversationPageSchema,
  type LiveEvent,
  LiveEventSchema,
  type ToolCallPart,
} from '@superagent/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer } from 'react';
import { api } from './client';
import { useSession } from './session';
import { type LiveStatus, SseConnection, safeJson } from './sse';

/** Whose conversation: yours with the chief of staff, or a task's lead's (its transcript). */
export type ConversationSource = { kind: 'chief' } | { kind: 'task'; taskId: string };

const PAGE_SIZE = 40;

const sourceKey = (source: ConversationSource) =>
  source.kind === 'chief' ? 'chief' : `task:${source.taskId}`;

/** Outside the task's own key: task events don't make a transcript stale, its stream does. */
export const conversationKey = (source: ConversationSource) =>
  source.kind === 'chief' ? (['chief', 'messages'] as const) : (['transcript', source.taskId] as const);

const basePath = (source: ConversationSource) =>
  source.kind === 'chief' ? '/v1/chief' : `/v1/tasks/${encodeURIComponent(source.taskId)}`;

const historyPath = (source: ConversationSource) =>
  `${basePath(source)}/${source.kind === 'chief' ? 'messages' : 'transcript'}`;

/**
 * A conversation's history, newest page first; `messages` are all loaded pages, oldest first. Pages
 * can overlap while the conversation grows, so messages are kept once each.
 */
export function useConversationHistory(source: ConversationSource) {
  const query = useInfiniteQuery({
    queryKey: conversationKey(source),
    queryFn: ({ pageParam, signal }) =>
      api(ConversationPageSchema, historyPath(source), {
        signal,
        query: { limit: PAGE_SIZE, before: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const all: ConversationMessage[] = [];
    for (const page of [...(query.data?.pages ?? [])].reverse()) {
      for (const message of page.items) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        all.push(message);
      }
    }
    return all;
  }, [query.data]);
  return { ...query, messages };
}

export type LivePart =
  | { kind: 'text' | 'reasoning'; id: string; text: string }
  | { kind: 'tool'; part: ToolCallPart }
  | { kind: 'message'; message: ConversationMessage };

/** A turn as it is being taken: its text, tool calls and the messages that reached it. */
export interface LiveTurn {
  runId: string;
  agent: string | null;
  parts: LivePart[];
  /** The history messages its answer is stored as (Mastra writes them as the turn goes). */
  messageIds: string[];
  end: Extract<LiveEvent, { type: 'run-end' }> | null;
  /** When it ended, by this browser's clock: only a history fetched later has its final answer. */
  endedAt: number | null;
}

export interface LiveState {
  status: LiveStatus;
  /** The agent is taking a turn. */
  running: boolean;
  turns: LiveTurn[];
  /** Messages that reached the agent between turns (a report it only stored). */
  arrived: ConversationMessage[];
}

const INITIAL: LiveState = { status: 'connecting', running: false, turns: [], arrived: [] };

type Action = { type: 'status'; status: LiveStatus } | { type: 'event'; event: LiveEvent; at: number };

function withTurn(state: LiveState, runId: string, update: (turn: LiveTurn) => LiveTurn): LiveState {
  const index = state.turns.findIndex((turn) => turn.runId === runId);
  const turn = index >= 0 ? state.turns[index] : undefined;
  const next = update(turn ?? { runId, agent: null, parts: [], messageIds: [], end: null, endedAt: null });
  const turns = turn ? state.turns.map((t, i) => (i === index ? next : t)) : [...state.turns, next];
  return { ...state, turns, running: turns.some((t) => t.end === null) };
}

/** Applies one live event. Exported for tests. */
export function liveReducer(state: LiveState, action: Action): LiveState {
  if (action.type === 'status') return { ...state, status: action.status };
  const event = action.event;
  switch (event.type) {
    case 'ready':
      // A new connection sends the turn in progress again from its start: begin again.
      return { ...state, running: event.running, turns: [] };
    case 'run-start':
      return withTurn(state, event.runId, (turn) => ({ ...turn, agent: event.agent ?? turn.agent }));
    case 'answer':
      return withTurn(state, event.runId, (turn) =>
        turn.messageIds.includes(event.messageId)
          ? turn
          : { ...turn, messageIds: [...turn.messageIds, event.messageId] },
      );
    case 'run-end':
      return withTurn(state, event.runId, (turn) => ({
        ...turn,
        messageIds: [...new Set([...turn.messageIds, ...event.messageIds])],
        end: event,
        endedAt: action.at,
      }));
    case 'text':
    case 'reasoning':
      return withTurn(state, event.runId, (turn) => {
        const at = turn.parts.findIndex((part) => part.kind === event.type && part.id === event.id);
        if (at < 0)
          return { ...turn, parts: [...turn.parts, { kind: event.type, id: event.id, text: event.delta }] };
        return {
          ...turn,
          parts: turn.parts.map((part, i) =>
            i === at && part.kind === event.type ? { ...part, text: part.text + event.delta } : part,
          ),
        };
      });
    case 'tool':
      return withTurn(state, event.runId, (turn) => {
        const at = turn.parts.findIndex(
          (part) => part.kind === 'tool' && part.part.callId === event.part.callId,
        );
        const part: LivePart = { kind: 'tool', part: event.part };
        return {
          ...turn,
          parts: at < 0 ? [...turn.parts, part] : turn.parts.map((p, i) => (i === at ? part : p)),
        };
      });
    case 'message': {
      const inTurn = state.turns.some((turn) => turn.runId === event.runId && turn.end === null);
      if (!inTurn) {
        if (state.arrived.some((message) => message.id === event.message.id)) return state;
        return { ...state, arrived: [...state.arrived, event.message] };
      }
      return withTurn(state, event.runId, (turn) =>
        turn.parts.some((part) => part.kind === 'message' && part.message.id === event.message.id)
          ? turn
          : { ...turn, parts: [...turn.parts, { kind: 'message', message: event.message }] },
      );
    }
  }
}

function parseEvent(type: string | undefined, data: string | undefined): LiveEvent | null {
  if (!type || !data) return null;
  const parsed = LiveEventSchema.safeParse(safeJson(data));
  return parsed.success && parsed.data.type === type ? parsed.data : null;
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
  const [state, dispatch] = useReducer(liveReducer, INITIAL);
  const key = sourceKey(source);
  const follow = enabled || state.running;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `source`.
  useEffect(() => {
    if (!follow || !token) return;
    const refresh = () => void queryClient.invalidateQueries({ queryKey: conversationKey(source) });
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connection = new SseConnection({
      path: `${basePath(source)}/stream`,
      token,
      onStatus: (status) => dispatch({ type: 'status', status }),
      onFrame: (frame) => {
        const event = parseEvent(frame.event, frame.data);
        if (!event) return;
        if (event.type === 'ready') connection.live();
        dispatch({ type: 'event', event, at: Date.now() });
        if (event.type === 'ready' || event.type === 'run-start' || event.type === 'message') refresh();
        if (event.type === 'run-end') {
          refresh();
          // The turn's last answer can be stored a moment after it ends: look again once, even if the
          // stream closes meanwhile (it does when the turn was all there was left to follow).
          clearTimeout(retry);
          retry = setTimeout(refresh, 1500);
        }
      },
    });
    connection.start();
    return () => {
      connection.stop();
      dispatch({ type: 'status', status: 'connecting' });
    };
  }, [follow, token, key, queryClient]);

  return state;
}

/** A turn as shown next to the history: only what the history doesn't have yet. */
export interface ShownTurn extends LiveTurn {
  /** Parts left out because the history shows them. */
  stored: number;
}

export interface Reconciled {
  messages: ConversationMessage[];
  arrived: ConversationMessage[];
  turns: ShownTurn[];
  /** Tool calls still running, wherever they show. */
  running: ReadonlySet<string>;
}

const sameText = (a: string, b: string) => a.trim() === b.trim();

/**
 * The history and the live turns, each thing shown once. Mastra stores a turn's answer as it goes, and
 * a stream that joins a turn midway (one waiting for an approval, say) sees only its latest step. So the
 * history stays whole, its tool calls take their live status, and a turn shows only what isn't stored
 * yet: tool calls and messages by id, its own text by content. A turn that has ended goes once a
 * history fetched after its end has its answer. Exported for tests.
 */
export function reconcile(stored: ConversationMessage[], live: LiveState, fetchedAt: number): Reconciled {
  const ids = new Set(stored.map((message) => message.id));
  const turns = live.turns.filter(
    (turn) =>
      !(turn.endedAt !== null && fetchedAt > turn.endedAt && turn.messageIds.some((id) => ids.has(id))),
  );
  const liveCalls = new Map<string, ToolCallPart>();
  const running = new Set<string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind !== 'tool') continue;
      liveCalls.set(part.part.callId, part.part);
      if (turn.end === null && part.part.status === 'pending') running.add(part.part.callId);
    }
  }
  const storedCalls = new Set<string>();
  const messages = stored.map((message) => {
    let patched = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool') return part;
      storedCalls.add(part.callId);
      const current = liveCalls.get(part.callId);
      if (!current || current === part) return part;
      patched = true;
      return current;
    });
    return patched ? { ...message, parts } : message;
  });
  return {
    messages,
    arrived: live.arrived.filter((message) => !ids.has(message.id)),
    turns: turns.map((turn) => {
      const own = stored.filter((message) => turn.messageIds.includes(message.id));
      const texts = own.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === 'text' || part.type === 'reasoning' ? [part.text] : [],
        ),
      );
      const parts = turn.parts.filter((part) =>
        part.kind === 'tool'
          ? !storedCalls.has(part.part.callId)
          : part.kind === 'message'
            ? !ids.has(part.message.id)
            : !texts.some((text) => sameText(text, part.text)),
      );
      return { ...turn, parts, stored: turn.parts.length - parts.length };
    }),
    running,
  };
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
  return useMutation({
    mutationFn: (message: string) =>
      api(ChiefMessageResultSchema, '/v1/chief/messages', { method: 'POST', json: { message } }),
    meta: { silent: true },
  });
}

export function useStopChief() {
  return useMutation({
    mutationFn: () => api(ChiefStopResultSchema, '/v1/chief/stop', { method: 'POST' }),
    meta: { failure: 'Couldn’t stop the chief' },
  });
}
