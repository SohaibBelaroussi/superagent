import {
  type LivePart,
  type OrgLookup,
  PENDING_NOTES,
  type PendingMessage,
  prettyArgs,
  type ReportIcon,
  reportKind,
  type ShownTurn,
  type Speaker,
  speakerFor,
  splitReport,
  summarizeTool,
  TOOL_STATUS,
  type ToolIcon,
  TURN_ENDINGS,
  textOf,
} from '@superagent/client';
import type { ConversationMessage, MessagePart, ToolCallPart } from '@superagent/shared';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import {
  Ban,
  Bell,
  BookOpen,
  CalendarClock,
  ChevronRight,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleX,
  Clock,
  FileText,
  Globe,
  Hand,
  Link2,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquare,
  MonitorSmartphone,
  NotebookPen,
  Paperclip,
  PlusCircle,
  Search,
  SquareKanban,
  SquareTerminal,
  TriangleAlert,
  UserRound,
  Wrench,
  XCircle,
} from 'lucide-react-native';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Avatar } from '../../ui/avatar';
import { Badge } from '../../ui/badge';
import { CodeBlock } from '../../ui/code-block';
import { Notice } from '../../ui/feedback';
import { Markdown, safeUrl } from '../../ui/markdown';
import { Text } from '../../ui/text';
import { makeStyles, radius, space, toneColors, useTheme } from '../../ui/theme';
import { RelativeTime } from '../tasks/bits';

/** The phone's icon for each kind of tool call (`summarizeTool`, in `@superagent/client`, names them). */
const TOOL_ICONS: Record<ToolIcon, LucideIcon> = {
  BookOpen,
  CalendarClock,
  CircleCheckBig,
  Clock,
  FileText,
  Globe,
  MessageSquare,
  MonitorSmartphone,
  NotebookPen,
  Paperclip,
  PlusCircle,
  Search,
  SquareKanban,
  SquareTerminal,
  UserRound,
  Wrench,
  XCircle,
};
const STATUS_ICONS = { Ban, CircleX, Hand } as const;
const REPORT_ICONS: Record<ReportIcon, LucideIcon> = {
  Bell,
  CircleCheck,
  CircleX,
  Hand,
  MessageCircleQuestion,
  TriangleAlert,
};

/** Agents by key: the chief, or a department's agent in its department's colour. */
export function useSpeakers(org: OrgLookup): (key: string | null) => Speaker {
  return useMemo(() => (key) => speakerFor(org, key), [org]);
}

/** The tool calls running right now: a call without a result elsewhere has none. */
export const RunningCalls = createContext<ReadonlySet<string>>(new Set());

export function OwnerBubble({ text, children }: { text: string; children?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.owner}>
      <View style={styles.bubble}>
        <Text selectable>{text}</Text>
      </View>
      {children}
    </View>
  );
}

/** One of your messages on its way: sending, waiting for the chief's turn to end, or not sent. */
export function PendingBubble({ message, onRetry }: { message: PendingMessage; onRetry?: () => void }) {
  const failed = message.state === 'failed';
  return (
    <View style={failed ? undefined : { opacity: 0.7 }}>
      <OwnerBubble text={message.text}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text variant="caption" color={failed ? 'destructiveForeground' : 'mutedForeground'}>
            {failed ? (message.error ?? PENDING_NOTES.failed) : PENDING_NOTES[message.state]}
          </Text>
          {failed && onRetry ? (
            <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
              <Text variant="caption" style={{ textDecorationLine: 'underline' }}>
                Retry
              </Text>
            </Pressable>
          ) : null}
        </View>
      </OwnerBubble>
    </View>
  );
}

/** An agent's name and the time, above what it said. */
function SpeakerLine({ speaker, at }: { speaker: Speaker; at?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <Avatar name={speaker.name} tone={speaker.tone} />
      <Text variant="label">{speaker.name}</Text>
      {at ? <RelativeTime iso={at} variant="caption" /> : null}
    </View>
  );
}

/** A tool call: what it did in words, its details a tap away. A delegation shows the exchange. */
export function ToolCallRow({ part, name }: { part: ToolCallPart; name: (key: string) => string }) {
  const theme = useTheme();
  const styles = useStyles();
  const runningCalls = useContext(RunningCalls);
  const [open, setOpen] = useState(false);
  const summary = summarizeTool(part, name);
  const status = TOOL_STATUS[part.status];
  const running = part.status === 'pending' && runningCalls.has(part.callId);
  const Icon = status.icon ? STATUS_ICONS[status.icon] : TOOL_ICONS[summary.icon];
  const ink = toneColors(theme, status.tone).foreground;
  const prompt =
    part.delegate && typeof (part.args as { prompt?: unknown })?.prompt === 'string'
      ? (part.args as { prompt: string }).prompt
      : null;
  const args = prompt === null ? prettyArgs(part.args) : null;
  const result = prompt === null && part.result !== undefined ? prettyArgs(part.result) : null;
  const note = status.label ?? (part.status === 'pending' && !running ? 'No result' : null);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${summary.title}${note ? `. ${note}` : ''}`}
        onPress={() => setOpen((shown) => !shown)}
        style={({ pressed }) => [styles.toolRow, pressed && { backgroundColor: theme.colors.fillSubtle }]}
      >
        {running ? (
          <ActivityIndicator size="small" color={theme.colors.mutedForeground} style={styles.toolIcon} />
        ) : part.status === 'pending' ? (
          <CircleDashed size={14} color={theme.colors.placeholder} style={styles.toolIcon} />
        ) : (
          <Icon
            size={14}
            color={status.tone === 'neutral' ? theme.colors.mutedForeground : ink}
            style={styles.toolIcon}
          />
        )}
        <Text
          variant="bodySmall"
          color="mutedForeground"
          numberOfLines={open ? undefined : 1}
          style={{ flex: 1 }}
        >
          {summary.title}
          {running ? '…' : ''}
        </Text>
        {note ? (
          <Text
            variant="caption"
            color={status.label ? undefined : 'placeholder'}
            tone={status.label ? status.tone : undefined}
          >
            {note}
          </Text>
        ) : null}
        <ChevronRight
          size={14}
          color={theme.colors.placeholder}
          style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
        />
      </Pressable>
      {open ? (
        <View style={styles.toolDetails}>
          {prompt !== null ? (
            <>
              <View style={styles.quote}>
                <Text variant="bodySmall" color="mutedForeground" selectable>
                  {prompt}
                </Text>
              </View>
              {typeof part.result === 'string' ? (
                <Markdown variant="bodySmall">{part.result}</Markdown>
              ) : null}
            </>
          ) : (
            <>
              {args ? <CodeBlock value={args} /> : null}
              {result ? <CodeBlock value={result} /> : null}
            </>
          )}
          {part.error ? (
            <Text variant="bodySmall" color="destructiveForeground" selectable>
              {part.error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Reasoning({ text }: { text: string }) {
  const theme = useTheme();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((shown) => !shown)}
        hitSlop={8}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start' }}
      >
        <ChevronRight
          size={12}
          color={theme.colors.mutedForeground}
          style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
        />
        <Text variant="caption" color="mutedForeground">
          Thought it through
        </Text>
      </Pressable>
      {open ? (
        <View style={[styles.quote, { marginTop: space.xs }]}>
          <Text variant="bodySmall" color="mutedForeground" selectable>
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One part of what an agent said. */
function PartView({ part, name }: { part: MessagePart; name: (key: string) => string }) {
  const theme = useTheme();
  switch (part.type) {
    case 'text':
      return <Markdown>{part.text}</Markdown>;
    case 'reasoning':
      return <Reasoning text={part.text} />;
    case 'tool':
      return <ToolCallRow part={part} name={name} />;
    case 'source': {
      const url = safeUrl(part.url);
      return (
        <Pressable
          accessibilityRole={url ? 'link' : undefined}
          disabled={!url}
          onPress={() => url && void WebBrowser.openBrowserAsync(url)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}
        >
          <Link2 size={14} color={theme.colors.mutedForeground} />
          <Text
            variant="caption"
            color="mutedForeground"
            numberOfLines={1}
            style={url ? { textDecorationLine: 'underline', flexShrink: 1 } : { flexShrink: 1 }}
          >
            {part.title ?? part.url}
          </Text>
        </Pressable>
      );
    }
    case 'file':
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
          <FileText size={14} color={theme.colors.mutedForeground} />
          <Text variant="caption" color="mutedForeground">
            {part.name ?? 'A file'} ({part.mediaType})
          </Text>
        </View>
      );
    case 'error':
      return <Notice tone="destructive" title={part.message} />;
  }
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
  const styles = useStyles();
  return (
    <View style={{ gap: space.xs + 2 }}>
      {showSpeaker ? <SpeakerLine speaker={speaker} at={at} /> : null}
      <View style={styles.indented}>
        {parts.map((part, index) =>
          // A text block can start empty (a step that only called a tool): it takes no room.
          (part.type === 'text' || part.type === 'reasoning') && !part.text.trim() ? null : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts never move within a message.
            <PartView key={index} part={part} name={name} />
          ),
        )}
        {children}
      </View>
    </View>
  );
}

/** A department's report to the chief, linked to its task. */
export function ReportCard({ message, org }: { message: ConversationMessage; org: OrgLookup }) {
  const theme = useTheme();
  const styles = useStyles();
  const report = message.report;
  const kind = reportKind(report);
  const Icon = REPORT_ICONS[kind.icon];
  const slug = report?.source.startsWith('dept:') ? report.source.slice(5) : null;
  const department = slug ? org.departmentBySlug(slug) : undefined;
  const text = textOf(message.parts);
  const split = splitReport(text, report);
  const taskId = report?.taskId ?? null;
  return (
    <View
      accessibilityLabel={`Report${report?.taskNumber ? ` on #${report.taskNumber}` : ''}`}
      style={styles.report}
    >
      <View style={styles.reportHead}>
        <Icon size={14} color={toneColors(theme, kind.tone).indicator} />
        <Badge tone={kind.tone} label={kind.label} />
        <Text variant="caption" color="mutedForeground" numberOfLines={1} style={{ flexShrink: 1 }}>
          {department?.name ?? slug ?? 'A department'}
        </Text>
        <RelativeTime iso={message.createdAt} variant="caption" style={{ marginLeft: 'auto' }} />
      </View>
      {split ? (
        <Text variant="bodySmall" selectable>
          {taskId ? (
            <Text
              variant="cardTitle"
              accessibilityRole="link"
              onPress={() => router.push(`/tasks/${taskId}`)}
              style={{ textDecorationLine: 'underline' }}
            >
              #{split.number} {split.title}
            </Text>
          ) : (
            <Text variant="cardTitle">
              #{split.number} {split.title}
            </Text>
          )}
          <Text variant="bodySmall" color="mutedForeground">
            {': '}
          </Text>
          {split.summary}
        </Text>
      ) : (
        <Text variant="bodySmall" selectable>
          {text}
        </Text>
      )}
    </View>
  );
}

/** A task's brief, as its lead got it. */
export function BriefCard({ message, lead }: { message: ConversationMessage; lead: string }) {
  const styles = useStyles();
  return (
    <View accessibilityLabel={`Brief for ${lead}`} style={styles.brief}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text variant="caption" color="mutedForeground">
          Brief for {lead}
        </Text>
        <RelativeTime iso={message.createdAt} variant="caption" />
      </View>
      <Markdown variant="bodySmall">{textOf(message.parts)}</Markdown>
    </View>
  );
}

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
  const styles = useStyles();
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
    <View style={{ gap: space.lg }} accessibilityState={{ busy: live }}>
      {blocks.length === 0 && live && turn.stored === 0 ? (
        <View style={{ gap: space.xs + 2 }}>
          {showSpeaker ? <SpeakerLine speaker={speaker} /> : null}
          <Text variant="bodySmall" color="mutedForeground" style={styles.indented}>
            Thinking…
          </Text>
        </View>
      ) : (
        blocks
      )}
      {turn.end?.outcome === 'failed' ? (
        <View style={styles.indented}>
          <Notice tone="destructive" title={`${speaker.name} couldn’t finish`}>
            {turn.end.error ?? 'The model call failed.'}
          </Notice>
        </View>
      ) : turn.end && turn.end.outcome !== 'finished' ? (
        <Text variant="caption" color="mutedForeground" style={styles.indented}>
          {TURN_ENDINGS[turn.end.outcome]}
        </Text>
      ) : null}
    </View>
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
      return (
        <Text variant="caption" color="mutedForeground" center>
          {textOf(message.parts)}
        </Text>
      );
  }
}

const useStyles = makeStyles((theme) => ({
  owner: { alignItems: 'flex-end', gap: space.xs },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm / 2,
    backgroundColor: theme.colors.fill,
  },
  indented: { paddingLeft: space.xxl + space.xs, gap: space.xs + 2 },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 32,
    paddingHorizontal: space.xs,
    borderRadius: radius.sm,
  },
  toolIcon: { width: 16, alignItems: 'center' },
  toolDetails: { gap: space.sm, paddingLeft: space.xxl, paddingTop: space.xs, paddingBottom: space.sm },
  quote: { borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: space.md },
  report: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: theme.colors.card,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  reportHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  brief: {
    gap: space.xs + 2,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border,
  },
}));
