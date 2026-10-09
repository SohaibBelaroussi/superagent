import { PHASES, type Tone } from '@superagent/client';
import type { TaskEvent, TaskPhase } from '@superagent/shared';
import {
  ArrowRightLeft,
  BellRing,
  CircleCheck,
  CircleDot,
  CircleX,
  FilePlus2,
  Flag,
  Hand,
  type LucideIcon,
  MessageSquareText,
  Pencil,
  Send,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type { OrgLookup } from './org';

export interface DescribedEvent {
  icon: LucideIcon;
  tone: Tone;
  /** One line: what happened. */
  title: string;
  /** More, when the event carries it: a note, a summary, a message. */
  detail?: string;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const phaseLabel = (value: unknown) =>
  typeof value === 'string' && value in PHASES ? PHASES[value as TaskPhase].label : String(value);

/** Events name their actor "owner", "chief", "schedule", "system" or "agent:<key>". */
function who(actor: string, org: OrgLookup): string {
  if (actor === 'owner') return 'You';
  if (actor === 'chief') return 'Your chief of staff';
  if (actor === 'schedule') return 'A schedule';
  if (actor === 'system') return 'Superagent';
  const key = actor.startsWith('agent:') ? actor.slice('agent:'.length) : actor;
  return org.agentByKey(key)?.name ?? key;
}

/**
 * Drops phase changes that only restate their neighbour: "moved to Queued" right before "Sent to
 * Ada", "moved to Needs you" before "Waiting for your approval", and "moved back to Working" after
 * "You approved". The events are still there; the timeline just doesn't say it twice.
 */
export function condenseEvents(events: readonly TaskEvent[]): TaskEvent[] {
  return events.filter((event, index) => {
    if (event.type !== 'phase_changed') return true;
    const next = events[index + 1];
    const previous = events[index - 1];
    if (event.data.to === 'queued' && next?.type === 'dispatched') return false;
    if (event.data.to === 'waiting' && next?.type === 'approval_requested') return false;
    if (event.data.from === 'waiting' && previous?.type === 'approval_decided') return false;
    return true;
  });
}

function agentName(key: unknown, org: OrgLookup): string {
  return (
    (typeof key === 'string' && org.agentByKey(key)?.name) || (typeof key === 'string' ? key : 'the lead')
  );
}

const FIELD_LABELS: Record<string, string> = { title: 'title', priority: 'priority', dueAt: 'due date' };

/** A task event in words, for the activity timeline. Unknown types still read sensibly. */
export function describeEvent(event: TaskEvent, org: OrgLookup): DescribedEvent {
  const data = event.data;
  switch (event.type) {
    case 'created':
      return {
        icon: event.actor === 'chief' ? Sparkles : CircleDot,
        tone: 'neutral',
        title: `${who(event.actor, org)} created the task`,
      };
    case 'dispatched':
      return { icon: Send, tone: 'blue', title: `Sent to ${agentName(data.lead, org)}` };
    case 'reassigned':
      return { icon: UserRound, tone: 'blue', title: `Reassigned to ${agentName(data.lead, org)}` };
    case 'progress': {
      const parts: string[] = [];
      if (typeof data.progress === 'number') parts.push(`${data.progress}%`);
      if (Array.isArray(data.checklist)) {
        const done = data.checklist.filter((item) => (item as { done?: boolean }).done).length;
        parts.push(`checklist ${done}/${data.checklist.length}`);
      }
      return {
        icon: Flag,
        tone: 'amber',
        title: `${who(event.actor, org)} reported progress${parts.length ? `: ${parts.join(', ')}` : ''}`,
        detail: str(data.note),
      };
    }
    case 'reported': {
      const outcome = str(data.outcome);
      return {
        icon: outcome === 'failed' ? CircleX : outcome === 'blocked' ? Hand : CircleCheck,
        tone: outcome === 'failed' ? 'red' : outcome === 'blocked' ? 'orange' : 'purple',
        title:
          outcome === 'blocked'
            ? `${who(event.actor, org)} needs you`
            : outcome === 'failed'
              ? `${who(event.actor, org)} reported a failure`
              : `${who(event.actor, org)} reported the result`,
        detail: str(data.summary),
      };
    }
    case 'phase_changed':
      return {
        icon: ArrowRightLeft,
        tone: PHASES[event.phase]?.tone ?? 'neutral',
        title: `${who(event.actor, org)} moved it from ${phaseLabel(data.from)} to ${phaseLabel(data.to)}`,
        detail: str(data.reason),
      };
    case 'updated': {
      const fields = Array.isArray(data.fields)
        ? data.fields.map((field) => FIELD_LABELS[String(field)] ?? String(field))
        : [];
      return {
        icon: Pencil,
        tone: 'neutral',
        title: `${who(event.actor, org)} edited the ${fields.length ? fields.join(' and ') : 'task'}`,
      };
    }
    case 'message':
      return {
        icon: MessageSquareText,
        tone: 'neutral',
        title: `${who(event.actor, org)} sent a message${data.mode === 'queue' ? ' for after this turn' : ''}`,
        detail: str(data.text),
      };
    case 'artifact_added':
      return {
        icon: FilePlus2,
        tone: 'neutral',
        title: `Added ${str(data.title) ? `“${data.title}”` : 'a deliverable'}`,
      };
    case 'approval_requested':
      return {
        icon: ShieldQuestion,
        tone: 'orange',
        title: `Waiting for your approval to use ${str(data.tool) ?? 'a tool'}`,
      };
    case 'approval_decided':
      return {
        icon: data.decision === 'approve' ? ShieldCheck : ShieldX,
        tone: data.decision === 'approve' ? 'green' : 'red',
        title: `${who(event.actor, org)} ${data.decision === 'approve' ? 'approved' : 'declined'} ${str(data.tool) ?? 'a tool call'}`,
      };
    case 'chief_notified':
      return { icon: BellRing, tone: 'neutral', title: 'Your chief of staff was told' };
    default:
      return {
        icon: CircleDot,
        tone: 'neutral',
        title: `${who(event.actor, org)}: ${event.type.replaceAll('_', ' ')}`,
      };
  }
}
