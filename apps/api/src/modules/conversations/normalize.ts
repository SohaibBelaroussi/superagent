import type {
  ConversationMessage,
  ConversationReport,
  LiveEvent,
  MessagePart,
  ToolCallPart,
  ToolCallStatus,
} from '@superagent/shared';
import { truncate } from '../../util/text';
import { readLeadInput } from '../dispatch/wording';

/**
 * Mastra's messages and stream chunks, turned into the shapes clients get (`@superagent/shared`), so no
 * client depends on Mastra's formats. Typed loosely on purpose: whatever Mastra stores, an unknown
 * shape is skipped rather than trusted.
 */

/** A stored message, as Mastra's memory returns it. */
export interface StoredMessage {
  id: string;
  role: string;
  type?: string;
  createdAt: Date | string;
  content: unknown;
}

/** Whose conversation a message belongs to. */
export interface ThreadContext {
  /** The owner's conversation with the chief, or a lead's thread for a task. */
  kind: 'chief' | 'task';
  /** Who wrote an agent message at that moment: the chief, or the task's lead then. */
  authorAt(at: Date): string | null;
  /** Task ids by number, for reports stored before they carried the id. */
  taskIds: ReadonlyMap<number, string>;
}

/** Arguments and results are cut down to this many characters of JSON; a delegation's answer to more. */
const PREVIEW_CHARS = 4_000;
const ANSWER_CHARS = 20_000;
/** Specialists are tools named after them. */
const DELEGATION_PREFIX = 'agent-';
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const FAILED_REASONS = new Set(['error', 'retry', 'other', 'unknown', 'tripwire']);
/** The chunks that carry the id of the message a run's answer is stored under. */
const MESSAGE_ID_CHUNKS = new Set(['start', 'step-start', 'step-finish', 'finish']);

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown): Rec => (isRecord(value) ? value : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const int = (value: unknown): number | null => (Number.isInteger(value) ? (value as number) : null);

/** A value as clients get it: unchanged when small, else the start of its JSON. */
export function preview(value: unknown, max = PREVIEW_CHARS): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return truncate(value, max);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return truncate(String(value), max);
  }
  if (json === undefined) return undefined;
  return json.length <= max ? value : truncate(json, max);
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return truncate(error, PREVIEW_CHARS);
  if (isRecord(error) && typeof error.message === 'string') return truncate(error.message, PREVIEW_CHARS);
  if (error instanceof Error) return truncate(error.message, PREVIEW_CHARS);
  return 'Something went wrong';
}

/** Mastra adds its own bookkeeping to some tool calls' arguments. */
function argsOf(args: unknown): unknown {
  if (!isRecord(args) || !('__mastraMetadata' in args)) return preview(args ?? {});
  const { __mastraMetadata: _, ...rest } = args;
  return preview(rest);
}

/** A delegation's result is the specialist's answer: its text is what matters. */
function resultOf(delegate: string | null, result: unknown): unknown {
  if (delegate && isRecord(result) && typeof result.text === 'string') {
    return truncate(result.text, ANSWER_CHARS);
  }
  return preview(result);
}

function delegateOf(tool: string): string | null {
  return tool.startsWith(DELEGATION_PREFIX) ? tool.slice(DELEGATION_PREFIX.length) || null : null;
}

/** A stored tool call (Mastra's `toolInvocation`). */
export function toolCall(invocation: unknown): ToolCallPart | null {
  const call = record(invocation);
  const callId = str(call.toolCallId);
  const tool = str(call.toolName);
  if (!callId || !tool) return null;
  const delegate = delegateOf(tool);
  const approval = record(call.approval);
  let status: ToolCallStatus = 'pending';
  let error: string | null = null;
  switch (call.state) {
    case 'result':
      status = call.isError ? 'failed' : 'done';
      if (call.isError) error = errorText(call.errorText ?? call.result);
      break;
    case 'output-error':
      status = 'failed';
      error = errorText(call.errorText ?? 'The tool failed');
      break;
    case 'output-denied':
      status = 'declined';
      error = str(approval.reason);
      break;
    case 'approval-requested':
      status = 'approval';
      break;
    case 'approval-responded':
      if (approval.approved === false) {
        status = 'declined';
        error = str(approval.reason);
      }
      break;
  }
  return {
    type: 'tool',
    callId,
    tool,
    delegate,
    args: argsOf(call.args),
    status,
    ...(status === 'done' ? { result: resultOf(delegate, call.result) } : {}),
    error,
  };
}

/** The parts worth showing: text, reasoning, tool calls, sources, files and errors. */
export function partsOf(content: unknown): MessagePart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const body = record(content);
  const raw = Array.isArray(body.parts) ? body.parts : [];
  const parts: MessagePart[] = [];
  for (const item of raw) {
    const part = record(item);
    switch (part.type) {
      case 'text': {
        const text = str(part.text);
        if (text) parts.push({ type: 'text', text });
        break;
      }
      case 'reasoning': {
        const details = Array.isArray(part.details)
          ? part.details.map((detail) => str(record(detail).text) ?? '').join('')
          : '';
        const text = str(part.reasoning) ?? str(part.text) ?? str(details);
        if (text) parts.push({ type: 'reasoning', text });
        break;
      }
      case 'tool-invocation': {
        const call = toolCall(part.toolInvocation);
        if (call) parts.push(call);
        break;
      }
      case 'source': {
        const source = record(part.source);
        const url = str(source.url);
        if (url) parts.push({ type: 'source', url, title: str(source.title) });
        break;
      }
      case 'source-url': {
        const url = str(part.url);
        if (url) parts.push({ type: 'source', url, title: str(part.title) });
        break;
      }
      case 'file':
        parts.push({
          type: 'file',
          name: str(part.filename),
          mediaType: str(part.mimeType) ?? str(part.mediaType) ?? 'application/octet-stream',
        });
        break;
      case 'error':
        parts.push({ type: 'error', message: errorText(part.error) });
        break;
    }
  }
  if (parts.length === 0) {
    const text = str(body.content);
    if (text) parts.push({ type: 'text', text });
  }
  return parts;
}

const textOf = (parts: MessagePart[]) =>
  parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');

const signalOf = (message: StoredMessage) => record(record(record(message.content).metadata).signal);
const isReport = (message: StoredMessage, signal: Rec) =>
  message.role === 'signal' && (str(signal.tagName) ?? message.type) === 'notification';

/** The task numbers of reports stored without their task's id (from before they carried it). */
export function reportNumbers(messages: StoredMessage[]): number[] {
  return messages.flatMap((message) => {
    const signal = signalOf(message);
    if (!isReport(message, signal) || str(record(signal.metadata).taskId)) return [];
    const number = /^#(\d+)\b/.exec(textOf(partsOf(message.content)))?.[1];
    return number ? [Number(number)] : [];
  });
}

/** The task a report is about: from its metadata, else the "#N" it starts with. */
function reportOf(signal: Rec, text: string, context: ThreadContext): ConversationReport {
  const attributes = record(signal.attributes);
  const metadata = record(signal.metadata);
  const notification = record(metadata.notification);
  const priority = str(attributes.priority) ?? str(notification.priority);
  const taskNumber = int(metadata.taskNumber) ?? Number(/^#(\d+)\b/.exec(text)?.[1] ?? Number.NaN);
  const number = Number.isInteger(taskNumber) ? taskNumber : null;
  return {
    kind: str(attributes.kind) ?? str(notification.kind) ?? 'notice',
    source: str(attributes.source) ?? str(notification.source) ?? 'system',
    priority: priority && PRIORITIES.has(priority) ? (priority as ConversationReport['priority']) : null,
    taskId: str(metadata.taskId) ?? (number === null ? null : (context.taskIds.get(number) ?? null)),
    taskNumber: number,
  };
}

/** Something sent to an agent, read back for the owner. */
function sentMessage(
  base: Pick<ConversationMessage, 'id' | 'createdAt'>,
  parts: MessagePart[],
  context: ThreadContext,
): ConversationMessage | null {
  if (parts.length === 0) return null;
  const plain = { ...base, author: null, report: null };
  if (context.kind === 'chief') return { ...plain, role: 'owner', parts };
  const input = readLeadInput(textOf(parts));
  if (!input) return { ...plain, role: 'note', parts };
  const text: MessagePart[] = [{ type: 'text', text: input.text }];
  if (input.kind === 'brief') return { ...plain, role: 'brief', parts: text };
  return input.from === 'owner'
    ? { ...plain, role: 'owner', parts: text }
    : { ...plain, role: 'agent', author: 'chief', parts: text };
}

/**
 * One stored message as clients see it; null for what isn't shown: system messages, empty ones, and
 * signals meant for the agent alone (reminders, notification summaries: each notification is shown
 * once it is delivered).
 */
export function normalizeMessage(message: StoredMessage, context: ThreadContext): ConversationMessage | null {
  const at = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);
  if (Number.isNaN(at.getTime())) return null;
  const base = { id: message.id, createdAt: at.toISOString() };
  const parts = partsOf(message.content);
  switch (message.role) {
    case 'user':
      return sentMessage(base, parts, context);
    case 'assistant':
      if (parts.length === 0) return null;
      return { ...base, role: 'agent', author: context.authorAt(at), parts, report: null };
    case 'signal': {
      const signal = signalOf(message);
      if (isReport(message, signal)) {
        const text = textOf(parts);
        if (!text) return null;
        return {
          ...base,
          role: 'report',
          author: null,
          parts: [{ type: 'text', text }],
          report: reportOf(signal, text, context),
        };
      }
      if (signal.type === 'user' || (str(signal.tagName) ?? message.type) === 'user') {
        return sentMessage(base, parts, context);
      }
      return null;
    }
    default:
      return null;
  }
}

/** A signal as a stream carries it (a `data-*` part), as a message. */
function signalMessage(data: unknown, context: ThreadContext): ConversationMessage | null {
  const signal = record(data);
  const id = str(signal.id);
  if (!id) return null;
  const contents = signal.contents;
  const parts =
    typeof contents === 'string'
      ? [{ type: 'text', text: contents }]
      : Array.isArray(contents)
        ? contents
        : [];
  return normalizeMessage(
    {
      id,
      role: 'signal',
      type: str(signal.tagName) ?? undefined,
      createdAt: str(signal.createdAt) ?? new Date().toISOString(),
      content: { parts, metadata: { signal } },
    },
    context,
  );
}

/**
 * Turns one thread's stream chunks (from Mastra's thread subscription) into live events. A run is
 * announced by its first chunk and ends once; a signal Mastra only stored (it woke no run) comes as a
 * quiet run, whose message is passed on without a run around it.
 */
export class LiveNormalizer {
  private runId: string | null = null;
  private quiet = false;
  private block: { kind: 'text' | 'reasoning'; id: string } | null = null;
  private blocks = 0;
  private readonly tools = new Map<string, ToolCallPart>();
  private readonly ended = new Set<string>();
  /** The ids the run's answers are stored under (a run that steps on may move to a new one). */
  private messageIds: string[] = [];

  constructor(private readonly context: ThreadContext) {}

  push(input: unknown): LiveEvent[] {
    const chunk = record(input);
    const runId = str(chunk.runId);
    const type = str(chunk.type);
    if (!runId || !type || this.ended.has(runId)) return [];
    const payload = record(chunk.payload);
    const events: LiveEvent[] = [];
    if (runId !== this.runId) {
      if (this.runId && !this.quiet) this.end(events, this.runId, 'finished', null);
      this.runId = runId;
      this.block = null;
      this.tools.clear();
      this.messageIds = [];
      this.quiet = type === 'start' && (str(payload.messageId)?.startsWith('persisted-signal:') ?? false);
      // A run's first chunk names its agent; joined midway, it isn't known.
      const agent = type === 'start' ? str(payload.id) : null;
      if (!this.quiet) events.push({ type: 'run-start', runId, agent });
    }
    const messageId = str(payload.messageId);
    if (messageId && !this.quiet && MESSAGE_ID_CHUNKS.has(type) && !this.messageIds.includes(messageId)) {
      this.messageIds.push(messageId);
    }
    switch (type) {
      case 'text-delta':
      case 'reasoning-delta': {
        const delta = str(payload.text);
        const kind = type === 'text-delta' ? 'text' : 'reasoning';
        if (delta) events.push({ type: kind, runId, id: this.blockId(kind), delta });
        break;
      }
      case 'text-start':
      case 'text-end':
      case 'reasoning-start':
      case 'reasoning-end':
        this.block = null;
        break;
      case 'tool-call':
      case 'tool-call-approval':
      case 'tool-result':
      case 'tool-error':
      case 'tool-output-denied': {
        const part = this.toolUpdate(type, payload);
        if (part) events.push({ type: 'tool', runId, part });
        break;
      }
      case 'error':
        this.end(events, runId, 'failed', errorText(payload.error));
        break;
      case 'abort':
        this.end(events, runId, 'stopped', null);
        break;
      case 'finish': {
        const reason = str(record(payload.stepResult).reason) ?? '';
        const outcome =
          reason === 'suspended'
            ? 'suspended'
            : reason === 'aborted'
              ? 'stopped'
              : FAILED_REASONS.has(reason)
                ? 'failed'
                : 'finished';
        this.end(events, runId, outcome, null);
        break;
      }
      default:
        if (type.startsWith('data-')) {
          const message = signalMessage(chunk.data, this.context);
          if (message) events.push({ type: 'message', runId, message });
        }
    }
    return events;
  }

  private blockId(kind: 'text' | 'reasoning'): string {
    if (this.block?.kind !== kind) {
      this.blocks += 1;
      this.block = { kind, id: `${kind}-${this.blocks}` };
    }
    return this.block.id;
  }

  private toolUpdate(type: string, payload: Rec): ToolCallPart | null {
    const callId = str(payload.toolCallId);
    if (!callId) return null;
    this.block = null;
    const known = this.tools.get(callId);
    const tool = str(payload.toolName) ?? known?.tool;
    if (!tool) return null;
    const delegate = delegateOf(tool);
    const base: ToolCallPart = known ?? {
      type: 'tool',
      callId,
      tool,
      delegate,
      args: argsOf(payload.args),
      status: 'pending',
      error: null,
    };
    let part: ToolCallPart;
    switch (type) {
      case 'tool-call-approval':
        part = { ...base, args: argsOf(payload.args ?? base.args), status: 'approval' };
        break;
      case 'tool-result':
        part = payload.isError
          ? { ...base, status: 'failed', error: errorText(payload.result) }
          : { ...base, status: 'done', result: resultOf(delegate, payload.result) };
        break;
      case 'tool-error':
        part = { ...base, status: 'failed', error: errorText(payload.error) };
        break;
      case 'tool-output-denied':
        part = { ...base, status: 'declined', error: str(record(payload.approval).reason) };
        break;
      default:
        part = base;
    }
    this.tools.set(callId, part);
    return part;
  }

  private end(
    events: LiveEvent[],
    runId: string,
    outcome: Extract<LiveEvent, { type: 'run-end' }>['outcome'],
    error: string | null,
  ): void {
    if (this.ended.has(runId)) return;
    this.ended.add(runId);
    // Only the most recent runs can still send chunks.
    if (this.ended.size > 100) this.ended.delete(this.ended.values().next().value as string);
    if (runId === this.runId && this.quiet) return;
    events.push({ type: 'run-end', runId, outcome, error, messageIds: [...this.messageIds] });
  }
}
