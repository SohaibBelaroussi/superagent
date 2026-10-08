import type { TaskPhase, TaskPriority } from '@superagent/shared';

/** The hues a badge, a dot or a department can wear. Neutral is the interface's own grey. */
export type Tone = 'neutral' | 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'orange' | 'cyan' | 'pink';

export interface PhaseInfo {
  label: string;
  tone: Tone;
  /** What the phase means, for tooltips and empty columns. */
  description: string;
  /** Work is happening right now: its dot pulses. */
  live?: boolean;
}

export const PHASES: Record<TaskPhase, PhaseInfo> = {
  inbox: { label: 'Inbox', tone: 'neutral', description: 'Not sent to a lead yet.' },
  queued: { label: 'Queued', tone: 'blue', description: 'Sent to the lead, which starts on it shortly.' },
  working: { label: 'Working', tone: 'amber', description: 'The lead and its team are on it.', live: true },
  waiting: { label: 'Needs you', tone: 'orange', description: 'Waiting for your answer or approval.' },
  review: { label: 'Review', tone: 'purple', description: 'Reported. Accept it, or send it back.' },
  done: { label: 'Done', tone: 'green', description: 'Closed in the last 7 days.' },
  failed: { label: 'Failed', tone: 'red', description: 'Stopped without a result.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', description: 'Stopped by you.' },
};

/** Board columns, in the order work moves through them. Failed and cancelled share one closed column. */
export const BOARD_COLUMNS: readonly TaskPhase[] = [
  'inbox',
  'queued',
  'working',
  'waiting',
  'review',
  'done',
];
export const CLOSED_PHASES: readonly TaskPhase[] = ['failed', 'cancelled'];

export interface PriorityInfo {
  label: string;
  tone: Tone;
  /** Lower comes first. */
  rank: number;
}

export const PRIORITIES: Record<TaskPriority, PriorityInfo> = {
  urgent: { label: 'Urgent', tone: 'red', rank: 0 },
  high: { label: 'High', tone: 'orange', rank: 1 },
  normal: { label: 'Normal', tone: 'neutral', rank: 2 },
  low: { label: 'Low', tone: 'neutral', rank: 3 },
};

const DEPARTMENT_TONES: readonly Tone[] = [
  'blue',
  'purple',
  'cyan',
  'green',
  'amber',
  'pink',
  'orange',
  'red',
];

/** A department's colour, stable for its slug, so cards scan by department. */
export function departmentTone(slug: string): Tone {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return DEPARTMENT_TONES[hash % DEPARTMENT_TONES.length] ?? 'blue';
}

/** Background class for a tone's dot. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  green: 'bg-badge-green-indicator',
  red: 'bg-badge-red-indicator',
  amber: 'bg-badge-amber-indicator',
  blue: 'bg-badge-blue-indicator',
  purple: 'bg-badge-purple-indicator',
  orange: 'bg-badge-orange-indicator',
  cyan: 'bg-badge-cyan-indicator',
  pink: 'bg-badge-pink-indicator',
};

/** Text class for a tone's ink. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  green: 'text-badge-green-foreground',
  red: 'text-badge-red-foreground',
  amber: 'text-badge-amber-foreground',
  blue: 'text-badge-blue-foreground',
  purple: 'text-badge-purple-foreground',
  orange: 'text-badge-orange-foreground',
  cyan: 'text-badge-cyan-foreground',
  pink: 'text-badge-pink-foreground',
};
