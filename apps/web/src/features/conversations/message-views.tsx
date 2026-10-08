import type { ConversationMessage, ConversationReport, MessagePart, ToolCallPart } from '@superagent/shared';
import {
  Ban,
  Bell,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  FileText,
  Hand,
  Link2,
  type LucideIcon,
  MessageCircleQuestion,
  TriangleAlert,
} from 'lucide-react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Link } from 'react-router';
import type { LivePart, ShownTurn } from '../../api/conversations';
import { cn } from '../../lib/cn';
import { departmentTone, TONE_TEXT, type Tone } from '../../lib/tones';
import { Avatar } from '../../ui/avatar';
import { Badge } from '../../ui/badge';
import { CodeBlock } from '../../ui/code-block';
import { Notice, Spinner } from '../../ui/feedback';
import { Markdown, webUrl } from '../../ui/markdown';
import { RelativeTime } from '../../ui/time';
import type { OrgLookup } from '../tasks/org';
import { summarizeTool } from './tool-summary';

/** Who wrote something, as the conversation shows them. */
export interface Speaker {
  name: string;
  tone: Tone;
}

/** Agents by key: the chief, or a department's agent in its department's colour. */
export function useSpeakers(org: OrgLookup): (key: string | null) => Speaker {
  return useMemo(
    () => (key) => {
      if (!key) return { name: 'Agent', tone: 'neutral' };
      if (key === 'chief') return { name: 'Chief of staff', tone: 'neutral' };
      const agent = org.agentByKey(key);
      const department = agent?.departmentId ? org.department(agent.departmentId) : undefined;
      return {
        name: agent?.name ?? key,
        tone: department ? departmentTone(department.slug) : 'neutral',
      };
    },
    [org],
  );
}

/** A pending message of yours: on its way, waiting for the chief's turn to end, or not sent. */
export interface PendingMessage {
  key: string;
  text: string;
  state: 'sending' | 'started' | 'queued' | 'failed';
  error?: string;
}

/** A message's text, its paragraphs joined. */
export const textOf = (parts: MessagePart[]) =>
  parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');

export function OwnerBubble({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-[1.25rem] rounded-br-md bg-fill px-4 py-2.5 text-body break-words whitespace-pre-wrap text-foreground">
        {text}
      </div>
      {children}
    </div>
  );
}

/** An agent's name and the time, above what it said. */
function SpeakerLine({ speaker, at }: { speaker: Speaker; at?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar name={speaker.name} tone={speaker.tone} size="sm" />
      <span className="text-label text-foreground">{speaker.name}</span>
      {at ? <RelativeTime iso={at} className="text-caption text-placeholder" /> : null}
    </div>
  );
}

const STATUS: Record<ToolCallPart['status'], { label: string | null; icon: LucideIcon | null; tone: Tone }> =
  {
    pending: { label: null, icon: null, tone: 'neutral' },
    approval: { label: 'Waiting for your approval', icon: Hand, tone: 'amber' },
    done: { label: null, icon: null, tone: 'neutral' },
    failed: { label: 'Failed', icon: CircleX, tone: 'red' },
    declined: { label: 'Declined', icon: Ban, tone: 'neutral' },
  };

/** The tool calls running right now: a call without a result elsewhere has none. */
export const RunningCalls = createContext<ReadonlySet<string>>(new Set());

/** A tool call: what it did in words, its details one click away. A delegation shows the exchange. */
export function ToolCallRow({ part, name }: { part: ToolCallPart; name: (key: string) => string }) {
  const runningCalls = useContext(RunningCalls);
  const summary = summarizeTool(part, name);
  const status = STATUS[part.status];
  const running = part.status === 'pending' && runningCalls.has(part.callId);
  const Icon = status.icon ?? summary.icon;
  const prompt =
    part.delegate && typeof (part.args as { prompt?: unknown })?.prompt === 'string'
      ? (part.args as { prompt: string }).prompt
      : null;
  return (
    <details className="group/tool">
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-2 rounded-lg py-1 pr-2 pl-1.5 text-body-sm text-muted-foreground outline-hidden select-none hover:bg-fill-subtle hover:text-foreground [&::-webkit-details-marker]:hidden',
          'focus-visible:outline-1 focus-visible:outline-border-focus',
        )}
      >
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <Spinner className="size-3.5" />
          ) : part.status === 'pending' ? (
            <CircleDashed className="size-3.5 text-placeholder" />
          ) : (
            <Icon className={cn('size-3.5', TONE_TEXT[status.tone])} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {summary.title}
          {running ? '…' : ''}
        </span>
        {status.label ? (
          <span className={cn('shrink-0 text-caption', TONE_TEXT[status.tone])}>{status.label}</span>
        ) : part.status === 'pending' && !running ? (
          <span className="shrink-0 text-caption text-placeholder">No result</span>
        ) : null}
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-placeholder transition-transform duration-150 group-open/tool:rotate-90"
        />
      </summary>
      <div className="mt-1 mb-2 ml-7 flex flex-col gap-2">
        {prompt !== null ? (
          <>
            <blockquote className="border-l-2 border-border pl-3 text-body-sm whitespace-pre-wrap text-muted-foreground">
              {prompt}
            </blockquote>
            {typeof part.result === 'string' ? (
              <Markdown className="text-body-sm">{part.result}</Markdown>
            ) : null}
          </>
        ) : (
          <>
            <CodeBlock value={part.args} />
            {part.result !== undefined ? <CodeBlock value={part.result} /> : null}
          </>
        )}
        {part.error ? <p className="text-body-sm text-destructive-foreground">{part.error}</p> : null}
      </div>
    </details>
  );
}

/** One part of what an agent said. */
function PartView({ part, name }: { part: MessagePart; name: (key: string) => string }) {
  switch (part.type) {
    case 'text':
      return <Markdown>{part.text}</Markdown>;
    case 'reasoning':
      return <Reasoning text={part.text} />;
    case 'tool':
      return <ToolCallRow part={part} name={name} />;
    case 'source': {
      const url = webUrl(part.url);
      return (
        <span className="inline-flex max-w-full items-center gap-1.5 text-caption text-muted-foreground">
          <Link2 aria-hidden className="size-3.5 shrink-0" />
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate underline underline-offset-2"
            >
              {part.title ?? url}
            </a>
          ) : (
            <span className="truncate">{part.title ?? part.url}</span>
          )}
        </span>
      );
    }
    case 'file':
      return (
        <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground">
          <FileText aria-hidden className="size-3.5" />
          {part.name ?? 'A file'} ({part.mediaType})
        </span>
      );
    case 'error':
      return (
        <Notice tone="destructive" className="py-2">
          {part.message}
        </Notice>
      );
  }
}

function Reasoning({ text }: { text: string }) {
  return (
    <details className="group/reasoning">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-caption text-muted-foreground outline-hidden select-none hover:text-foreground focus-visible:underline [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3 transition-transform duration-150 group-open/reasoning:rotate-90"
        />
        Thought it through
      </summary>
      <p className="mt-1.5 border-l-2 border-border pl-3 text-body-sm whitespace-pre-wrap text-muted-foreground">
        {text}
      </p>
    </details>
  );
}

/** An agent's message: its text, thinking and tool calls in order. */
export function AgentMessage({
  speaker,
  parts,
  at,
  showSpeaker,
  name,
  children,
}: {
  speaker: Speaker;
  parts: MessagePart[];
  at?: string;
  /** False when it follows another message by the same agent. */
  showSpeaker: boolean;
  name: (key: string) => string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {showSpeaker ? <SpeakerLine speaker={speaker} at={at} /> : null}
      <div className="flex min-w-0 flex-col gap-1.5 pl-7">
        {parts.map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never move within a message.
          <PartView key={index} part={part} name={name} />
        ))}
        {children}
      </div>
    </div>
  );
}

const REPORT_KINDS: Record<string, { label: string; tone: Tone; icon: LucideIcon }> = {
  'task-done': { label: 'Done', tone: 'green', icon: CircleCheck },
  'task-blocked': { label: 'Has a question', tone: 'orange', icon: MessageCircleQuestion },
  'task-failed': { label: 'Failed', tone: 'red', icon: CircleX },
  'approval-needed': { label: 'Needs your approval', tone: 'amber', icon: Hand },
  'task-stalled': { label: 'Stalled', tone: 'red', icon: TriangleAlert },
  'task-interrupted': { label: 'Interrupted', tone: 'orange', icon: TriangleAlert },
};

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

/** A department's report to the chief, linked to its task. */
export function ReportCard({ message, org }: { message: ConversationMessage; org: OrgLookup }) {
  const report = message.report;
  const kind = (report && REPORT_KINDS[report.kind]) ?? {
    label: 'Update',
    tone: 'neutral' as Tone,
    icon: Bell,
  };
  const slug = report?.source.startsWith('dept:') ? report.source.slice(5) : null;
  const department = slug ? org.departmentBySlug(slug) : undefined;
  const text = textOf(message.parts);
  const split = splitReport(text, report);
  const Icon = kind.icon;
  const label = `Report${report?.taskNumber ? ` on #${report.taskNumber}` : ''}`;
  return (
    <article aria-label={label} className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3 shadow-raised">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={kind.tone} icon={<Icon aria-hidden />}>
          {kind.label}
        </Badge>
        <span className="text-caption text-muted-foreground">
          {department?.name ?? slug ?? 'A department'}
        </span>
        <RelativeTime iso={message.createdAt} className="ml-auto text-caption text-placeholder" />
      </header>
      <p className="text-body-sm break-words text-foreground">
        {split ? (
          <>
            {report?.taskId ? (
              <Link to={`/tasks/${report.taskId}`} className="font-medium underline-offset-4 hover:underline">
                #{split.number} {split.title}
              </Link>
            ) : (
              <span className="font-medium">
                #{split.number} {split.title}
              </span>
            )}
            <span className="text-muted-foreground">: </span>
            {split.summary}
          </>
        ) : (
          text
        )}
      </p>
    </article>
  );
}

/** A task's brief, as its lead got it. */
export function BriefCard({ message, lead }: { message: ConversationMessage; lead: string }) {
  return (
    <section
      aria-label={`Brief for ${lead}`}
      className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border px-4 py-3"
    >
      <p className="flex items-center gap-2 text-caption text-muted-foreground">
        Brief for {lead}
        <RelativeTime iso={message.createdAt} className="text-placeholder" />
      </p>
      <Markdown className="text-body-sm text-foreground/90">{textOf(message.parts)}</Markdown>
    </section>
  );
}

const ENDINGS = {
  stopped: 'Stopped.',
  suspended: 'Paused until you decide on the tool call.',
} as const;

/**
 * A turn being taken: its text as it arrives, tool calls as they run. What the history already shows
 * is left out (`stored`), so a turn can have nothing of its own left to show.
 */
export function TurnView({
  turn,
  speaker,
  showSpeaker,
  name,
  org,
}: {
  turn: ShownTurn;
  speaker: Speaker;
  showSpeaker: boolean;
  name: (key: string) => string;
  org: OrgLookup;
}) {
  const live = turn.end === null;
  const blocks: ReactNode[] = [];
  let parts: MessagePart[] = [];
  const flush = (key: string) => {
    if (parts.length === 0) return;
    blocks.push(
      <AgentMessage
        key={key}
        speaker={speaker}
        parts={parts}
        showSpeaker={showSpeaker && blocks.length === 0}
        name={name}
      />,
    );
    parts = [];
  };
  turn.parts.forEach((part: LivePart, index) => {
    if (part.kind === 'message') {
      flush(`parts-${index}`);
      blocks.push(<MessageView key={part.message.id} message={part.message} org={org} name={name} />);
    } else if (part.kind === 'tool') parts.push(part.part);
    else parts.push({ type: part.kind, text: part.text });
  });
  flush('parts-last');
  return (
    // Busy while it streams: screen readers read the answer once it's done, not every word of it.
    <div className="flex flex-col gap-4" aria-busy={live}>
      {blocks.length === 0 && live && turn.stored === 0 ? (
        <div className="flex flex-col gap-1.5">
          {showSpeaker ? <SpeakerLine speaker={speaker} /> : null}
          <p className="flex items-center gap-2 pl-7 text-body-sm text-muted-foreground">
            <span aria-hidden className="flex gap-1">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse"
                  style={{ animationDelay: `${dot * 150}ms` }}
                />
              ))}
            </span>
            Thinking
          </p>
        </div>
      ) : (
        blocks
      )}
      {turn.end?.outcome === 'failed' ? (
        <Notice tone="destructive" title={`${speaker.name} couldn’t finish`} className="ml-7">
          {turn.end.error ?? 'The model call failed.'}
        </Notice>
      ) : turn.end && turn.end.outcome !== 'finished' ? (
        <p className="pl-7 text-caption text-muted-foreground">{ENDINGS[turn.end.outcome]}</p>
      ) : null}
    </div>
  );
}

/** One stored message, whatever its role. */
export function MessageView({
  message,
  org,
  name,
  speaker,
  showSpeaker = true,
  lead = 'the lead',
}: {
  message: ConversationMessage;
  org: OrgLookup;
  name: (key: string) => string;
  /** Who wrote it, for an agent's message. */
  speaker?: Speaker;
  showSpeaker?: boolean;
  /** Who a brief went to. */
  lead?: string;
}) {
  switch (message.role) {
    case 'owner':
      return <OwnerBubble text={textOf(message.parts)} />;
    case 'agent':
      return (
        <AgentMessage
          speaker={speaker ?? { name: name(message.author ?? ''), tone: 'neutral' }}
          parts={message.parts}
          at={message.createdAt}
          showSpeaker={showSpeaker}
          name={name}
        />
      );
    case 'report':
      return <ReportCard message={message} org={org} />;
    case 'brief':
      return <BriefCard message={message} lead={lead} />;
    case 'note':
      return <p className="text-center text-caption text-muted-foreground">{textOf(message.parts)}</p>;
  }
}
