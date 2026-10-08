import type { TaskPhase } from '@superagent/shared';
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Hand,
  Inbox,
  LoaderCircle,
  type LucideIcon,
  ScanEye,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { PHASES, TONE_TEXT } from '../lib/tones';

const PHASE_ICONS: Record<TaskPhase, LucideIcon> = {
  inbox: Inbox,
  queued: CircleDashed,
  working: LoaderCircle,
  waiting: Hand,
  review: ScanEye,
  done: CircleCheck,
  failed: CircleX,
  cancelled: CircleSlash,
};

/** A phase's icon in its colour; the working one turns slowly. */
export function PhaseIcon({ phase, className }: { phase: TaskPhase; className?: string }) {
  const Icon = PHASE_ICONS[phase];
  return (
    <Icon
      aria-hidden
      className={cn(
        'size-icon-md shrink-0',
        TONE_TEXT[PHASES[phase].tone],
        phase === 'working' && 'motion-safe:animate-[spin_2.4s_linear_infinite]',
        className,
      )}
    />
  );
}

/** The superagent mark: the chief above two departments. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-5', className)}>
      <path
        d="M12 7.5 7.25 15.25M12 7.5l4.75 7.75"
        fill="none"
        stroke="var(--brand)"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="12" cy="6.25" r="3" fill="var(--brand)" />
      <circle cx="6.75" cy="16.75" r="2.75" fill="currentColor" />
      <circle cx="17.25" cy="16.75" r="2.75" fill="currentColor" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
      <LogoMark />
      <span className="text-[0.9375rem] font-[560] tracking-[-0.01em]">superagent</span>
    </span>
  );
}
