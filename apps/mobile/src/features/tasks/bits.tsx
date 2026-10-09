import {
  departmentTone,
  type EventIcon,
  formatCost,
  formatRelative,
  formatTokens,
  PHASES,
  PRIORITIES,
} from '@superagent/client';
import type { AttentionItem, Department, TaskPhase, TaskPriority, UsageTotals } from '@superagent/shared';
import {
  ArrowRightLeft,
  BellRing,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleSlash,
  CircleX,
  FilePlus2,
  Flag,
  Hand,
  HeartPulse,
  Inbox,
  LoaderCircle,
  type LucideIcon,
  MessageSquareText,
  Pencil,
  ScanEye,
  Send,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Sparkles,
  TriangleAlert,
  UserRound,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Badge, StatusDot } from '../../ui/badge';
import { Text, type TextProps } from '../../ui/text';
import { radius, space, toneColors, useTheme } from '../../ui/theme';

export const PHASE_ICONS: Record<TaskPhase, LucideIcon> = {
  inbox: Inbox,
  queued: CircleDashed,
  working: LoaderCircle,
  waiting: Hand,
  review: ScanEye,
  done: CircleCheck,
  failed: CircleX,
  cancelled: CircleSlash,
};

/** The phone's icon for each kind of event (`describeEvent` names them). */
export const EVENT_ICONS: Record<EventIcon, LucideIcon> = {
  ArrowRightLeft,
  BellRing,
  CircleCheck,
  CircleDot,
  CircleX,
  FilePlus2,
  Flag,
  Hand,
  MessageSquareText,
  Pencil,
  Send,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Sparkles,
  UserRound,
};

/** How each kind of thing that needs you looks, and what it's called (as in the web app's inbox). */
export const KINDS: Record<
  AttentionItem['kind'],
  { icon: LucideIcon; tone: 'orange' | 'purple' | 'red'; label: string }
> = {
  approval: { icon: ShieldQuestion, tone: 'orange', label: 'Approval' },
  question: { icon: CircleHelp, tone: 'orange', label: 'Question' },
  review: { icon: ScanEye, tone: 'purple', label: 'Review' },
  problem: { icon: TriangleAlert, tone: 'red', label: 'Problem' },
  health: { icon: HeartPulse, tone: 'red', label: 'Setup' },
};

export function PhaseIcon({ phase, size = 18 }: { phase: TaskPhase; size?: number }) {
  const theme = useTheme();
  const Icon = PHASE_ICONS[phase];
  return <Icon size={size} color={toneColors(theme, PHASES[phase].tone).foreground} strokeWidth={2} />;
}

export function PhaseBadge({ phase }: { phase: TaskPhase }) {
  const info = PHASES[phase];
  return <Badge tone={info.tone} label={info.label} dot live={info.live} />;
}

/** Only priorities that stand out; "normal" and "low" go unsaid unless asked for. */
export function PriorityBadge({ priority, always = false }: { priority: TaskPriority; always?: boolean }) {
  const info = PRIORITIES[priority];
  if (!always && info.rank >= 2) return null;
  return <Badge tone={info.tone} label={info.label} />;
}

/** A department's name after its colour's dot. */
export function DepartmentLabel({
  department,
  variant = 'caption',
}: {
  department?: Department;
  variant?: TextProps['variant'];
}) {
  if (!department) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, flexShrink: 1 }}>
      <StatusDot tone={departmentTone(department.slug)} size={6} />
      <Text variant={variant} color="mutedForeground" numberOfLines={1} style={{ flexShrink: 1 }}>
        {department.name}
      </Text>
    </View>
  );
}

/** "12.3k tok · $0.042": what a task's model calls took. */
export function usageLine(usage: UsageTotals): string | null {
  if (usage.calls === 0) return null;
  const cost = usage.costUsd > 0 ? ` · ${formatCost(usage.costUsd)}` : '';
  return `${formatTokens(usage.totalTokens)} tok${cost}`;
}

export function ProgressBar({ percent }: { percent: number }) {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      style={{
        flex: 1,
        height: 4,
        borderRadius: radius.pill,
        backgroundColor: theme.colors.fill,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${clamped}%`,
          height: '100%',
          backgroundColor: theme.colors.foreground,
          opacity: 0.7,
        }}
      />
    </View>
  );
}

/** A minute that ticks, so "5m ago" stays true while a screen is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function RelativeTime({ iso, ...props }: { iso: string } & Omit<TextProps, 'children'>) {
  const now = useMinute();
  return (
    <Text variant="meta" color="placeholder" {...props}>
      {formatRelative(iso, now)}
    </Text>
  );
}
