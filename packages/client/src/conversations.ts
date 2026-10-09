import {
  ChiefMessageResultSchema,
  ChiefStopResultSchema,
  type ConversationMessage,
  type ConversationPage,
  ConversationPageSchema,
  type ConversationReport,
  type LiveEvent,
  LiveEventSchema,
  type MessagePart,
  type ToolCallPart,
} from '@superagent/shared';
import type { QueryFunctionContext } from '@tanstack/query-core';
import { api, apiUrl } from './http';
import { type LiveStatus, SseConnection, type SseConnectionOptions, safeJson } from './sse';
import type { OrgLookup } from './tasks';
import { departmentTone, type Tone } from './tones';

/** Whose conversation: yours with the chief of staff, or a task's lead's (its transcript). */
export type ConversationSource = { kind: 'chief' } | { kind: 'task'; taskId: string };

const PAGE_SIZE = 40;

/** One string per conversation, for hooks' dependencies. */
export const conversationId = (source: ConversationSource) =>
  source.kind === 'chief' ? 'chief' : `task:${source.taskId}`;

/** Outside the task's own key: task events don't make a transcript stale, its stream does. */
export const conversationKey = (source: ConversationSource) =>
  source.kind === 'chief' ? (['chief', 'messages'] as const) : (['transcript', source.taskId] as const);

const basePath = (source: ConversationSource) =>
  source.kind === 'chief' ? '/v1/chief' : `/v1/tasks/${encodeURIComponent(source.taskId)}`;

const historyPath = (source: ConversationSource) =>
  `${basePath(source)}/${source.kind === 'chief' ? 'messages' : 'transcript'}`;

/** A conversation's history, newest page first: older pages load as you scroll back. */
export const conversationQuery = (source: ConversationSource) => ({
  queryKey: conversationKey(source),
  queryFn: ({ pageParam, signal }: QueryFunctionContext<readonly unknown[], string | undefined>) =>
    api(ConversationPageSchema, historyPath(source), {
      signal,
      query: { limit: PAGE_SIZE, before: pageParam },
    }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (page: ConversationPage) => page.nextCursor ?? undefined,
});

/** The loaded pages' messages, oldest first. Pages overlap while the conversation grows: each once. */
export function conversationMessages(pages: readonly ConversationPage[] | undefined): ConversationMessage[] {
  const seen = new Set<string>();
  const all: ConversationMessage[] = [];
  for (const page of [...(pages ?? [])].reverse()) {
    for (const message of page.items) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      all.push(message);
    }
  }
  return all;
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
  /** When it ended, by this device's clock: only a history fetched later has its final answer. */
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

export const initialLiveState: LiveState = { status: 'connecting', running: false, turns: [], arrived: [] };

export type LiveAction =
  | { type: 'status'; status: LiveStatus }
  | { type: 'event'; event: LiveEvent; at: number };

function withTurn(state: LiveState, runId: string, update: (turn: LiveTurn) => LiveTurn): LiveState {
  const index = state.turns.findIndex((turn) => turn.runId === runId);
  const turn = index >= 0 ? state.turns[index] : undefined;
  const next = update(turn ?? { runId, agent: null, parts: [], messageIds: [], end: null, endedAt: null });
  const turns = turn ? state.turns.map((t, i) => (i === index ? next : t)) : [...state.turns, next];
  return { ...state, turns, running: turns.some((t) => t.end === null) };
}

/** Applies one live event, or the connection's status. */
export function liveReducer(state: LiveState, action: LiveAction): LiveState {
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

function parseLiveEvent(type: string | undefined, data: string | undefined): LiveEvent | null {
  if (!type || !data) return null;
  const parsed = LiveEventSchema.safeParse(safeJson(data));
  return parsed.success && parsed.data.type === type ? parsed.data : null;
}

export interface ConversationStreamHandlers {
  onEvent(event: LiveEvent, at: number): void;
  onStatus(status: LiveStatus): void;
  /** The history changed (a turn started or ended, a message reached the agent): fetch it again. */
  onStale(): void;
}

export interface ConversationStreamOptions {
  fetchImpl?: typeof fetch;
  watchOnline?: SseConnectionOptions['watchOnline'];
}

/**
 * A conversation's own stream (D47), open while it is on screen: the turn being taken, as it is
 * written. What it ends up as is in the history, which `onStale` says to fetch again.
 */
export class ConversationStream {
  private readonly connection: SseConnection;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    source: ConversationSource,
    token: string,
    private readonly handlers: ConversationStreamHandlers,
    options: ConversationStreamOptions = {},
  ) {
    this.connection = new SseConnection({
      url: apiUrl(`${basePath(source)}/stream`),
      token,
      fetchImpl: options.fetchImpl,
      watchOnline: options.watchOnline,
      onStatus: handlers.onStatus,
      onFrame: (frame) => {
        const event = parseLiveEvent(frame.event, frame.data);
        if (event) this.handle(event);
      },
    });
  }

  start(): void {
    this.connection.start();
  }

  /** Stops listening. A look at the history already planned still happens (see `handle`). */
  stop(): void {
    this.connection.stop();
  }

  private handle(event: LiveEvent): void {
    if (event.type === 'ready') this.connection.live();
    this.handlers.onEvent(event, Date.now());
    if (event.type === 'ready' || event.type === 'run-start' || event.type === 'message') {
      this.handlers.onStale();
    }
    if (event.type === 'run-end') {
      this.handlers.onStale();
      // The turn's last answer can be stored a moment after it ends: look again once, even if the
      // stream closes meanwhile (it does when the turn was all there was left to follow).
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.handlers.onStale(), 1500);
    }
  }
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
 * history fetched after its end has its answer.
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

/** A message's text, its paragraphs joined. */
export const textOf = (parts: MessagePart[]) =>
  parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');

/** Who wrote something, as the conversation shows them. */
export interface Speaker {
  name: string;
  tone: Tone;
}

/** An agent by its key: the chief, or a department's agent in its department's colour. */
export function speakerFor(org: OrgLookup, key: string | null): Speaker {
  if (!key) return { name: 'Agent', tone: 'neutral' };
  if (key === 'chief') return { name: 'Chief of staff', tone: 'neutral' };
  const agent = org.agentByKey(key);
  const department = agent?.departmentId ? org.department(agent.departmentId) : undefined;
  return { name: agent?.name ?? key, tone: department ? departmentTone(department.slug) : 'neutral' };
}

/** A message of yours: on its way, waiting for the chief's turn to end, or not sent. */
export interface PendingMessage {
  key: string;
  text: string;
  state: 'sending' | 'started' | 'queued' | 'failed';
  error?: string;
  /** Your stored messages with the same text when it was sent: none of them is this one. */
  known: ReadonlySet<string>;
}

export const PENDING_NOTES: Record<PendingMessage['state'], string> = {
  sending: 'Sending…',
  started: 'Sent',
  queued: 'Sends once the current answer is done',
  failed: 'Not sent',
};

/** How long a queued message may wait once the chief is idle (it goes out within a second) before it's offered again. */
export const LOST_AFTER_MS = 15_000;

/**
 * The pending messages the history now has, each with the stored message that is it. Each stored message
 * of yours (with its text, and not there when it was sent) stands for one pending message, in order, so
 * sending the same words twice works.
 */
export function storedPending(
  pending: PendingMessage[],
  messages: ConversationMessage[],
): Map<string, string> {
  const stored = new Map<string, string>();
  const used = new Set<string>();
  for (const item of pending) {
    const match = messages.find(
      (m) => m.role === 'owner' && !used.has(m.id) && !item.known.has(m.id) && textOf(m.parts) === item.text,
    );
    if (match) {
      used.add(match.id);
      stored.set(item.key, match.id);
    }
  }
  return stored;
}

/** A new pending message: `known` notes your stored messages with the same words, which aren't it. */
export function pendingMessage(key: string, text: string, messages: ConversationMessage[]): PendingMessage {
  const known = new Set(
    messages.filter((m) => m.role === 'owner' && textOf(m.parts) === text).map((m) => m.id),
  );
  return { key, text, state: 'sending', known };
}

/** Lucide's names for the icons reports show; each app maps them to its own icon set. */
export type ReportIcon =
  | 'Bell'
  | 'CircleCheck'
  | 'CircleX'
  | 'Hand'
  | 'MessageCircleQuestion'
  | 'TriangleAlert';

export interface ReportKind {
  label: string;
  tone: Tone;
  icon: ReportIcon;
}

const REPORT_KINDS: Record<string, ReportKind> = {
  'task-done': { label: 'Done', tone: 'green', icon: 'CircleCheck' },
  'task-blocked': { label: 'Has a question', tone: 'orange', icon: 'MessageCircleQuestion' },
  'task-failed': { label: 'Failed', tone: 'red', icon: 'CircleX' },
  'approval-needed': { label: 'Needs your approval', tone: 'amber', icon: 'Hand' },
  'task-stalled': { label: 'Stalled', tone: 'red', icon: 'TriangleAlert' },
  'task-interrupted': { label: 'Interrupted', tone: 'orange', icon: 'TriangleAlert' },
};

/** How a department's report shows: its kind, else an update. */
export const reportKind = (report: ConversationReport | null): ReportKind =>
  (report && REPORT_KINDS[report.kind]) ?? { label: 'Update', tone: 'neutral', icon: 'Bell' };

/**
 * "#12 Title: what happened" → its parts, so the task can be a link. The report's task title says where
 * the summary starts (a title can hold ": " too); without it, the first ": " does.
 */
export function splitReport(
  text: string,
  report: ConversationReport | null = null,
): { number: number; title: string; summary: string } | null {
  if (report?.taskNumber != null && report.taskTitle) {
    const prefix = `#${report.taskNumber} ${report.taskTitle}: `;
    if (text.startsWith(prefix)) {
      return { number: report.taskNumber, title: report.taskTitle, summary: text.slice(prefix.length) };
    }
  }
  const match = /^#(\d+) ([^\n]*?): ([\s\S]+)$/.exec(text);
  return match ? { number: Number(match[1]), title: match[2] ?? '', summary: match[3] ?? '' } : null;
}

/** What a turn that didn't finish says about it (a failed one shows its error). */
export const TURN_ENDINGS = {
  stopped: 'Stopped.',
  suspended: 'Paused until you decide on the tool call.',
} as const;

/** A message to the chief: it starts a turn, or waits for the one under way to end (D47). */
export const sendToChief = (message: string) =>
  api(ChiefMessageResultSchema, '/v1/chief/messages', { method: 'POST', json: { message } });

export const stopChief = () => api(ChiefStopResultSchema, '/v1/chief/stop', { method: 'POST' });
