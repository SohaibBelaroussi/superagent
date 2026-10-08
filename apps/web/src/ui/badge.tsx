import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../lib/cn';
import type { Tone } from '../lib/tones';
import { TONE_DOT } from '../lib/tones';

const FILLS: Record<Tone, { strong: string; subtle: string }> = {
  neutral: {
    strong: 'bg-fill text-badge-neutral-foreground',
    subtle: 'bg-fill-subtle text-badge-neutral-foreground',
  },
  green: {
    strong: 'bg-badge-green-strong text-badge-green-foreground',
    subtle: 'bg-badge-green-subtle text-badge-green-foreground',
  },
  red: {
    strong: 'bg-badge-red-strong text-badge-red-foreground',
    subtle: 'bg-badge-red-subtle text-badge-red-foreground',
  },
  amber: {
    strong: 'bg-badge-amber-strong text-badge-amber-foreground',
    subtle: 'bg-badge-amber-subtle text-badge-amber-foreground',
  },
  blue: {
    strong: 'bg-badge-blue-strong text-badge-blue-foreground',
    subtle: 'bg-badge-blue-subtle text-badge-blue-foreground',
  },
  purple: {
    strong: 'bg-badge-purple-strong text-badge-purple-foreground',
    subtle: 'bg-badge-purple-subtle text-badge-purple-foreground',
  },
  orange: {
    strong: 'bg-badge-orange-strong text-badge-orange-foreground',
    subtle: 'bg-badge-orange-subtle text-badge-orange-foreground',
  },
  cyan: {
    strong: 'bg-badge-cyan-strong text-badge-cyan-foreground',
    subtle: 'bg-badge-cyan-subtle text-badge-cyan-foreground',
  },
  pink: {
    strong: 'bg-badge-pink-strong text-badge-pink-foreground',
    subtle: 'bg-badge-pink-subtle text-badge-pink-foreground',
  },
};

const SIZES = {
  xs: { box: 'h-[18px] gap-1 px-1.5 text-meta', dot: 'size-1', icon: '[&_svg]:size-2.5' },
  sm: { box: 'h-5 gap-1 px-1.5 text-meta', dot: 'size-1.5', icon: '[&_svg]:size-3' },
  md: { box: 'h-5 gap-1.5 px-2 text-column', dot: 'size-1.5', icon: '[&_svg]:size-3' },
} as const;

export type BadgeProps = ComponentPropsWithoutRef<'span'> & {
  tone?: Tone;
  emphasis?: 'strong' | 'subtle';
  size?: keyof typeof SIZES;
  /** A leading dot; `pulse` for something happening now. */
  dot?: boolean | 'pulse';
  icon?: ReactNode;
};

/** A word in a tinted lozenge: phases, priorities, kinds. A colour first and a word second. */
export function Badge({
  tone = 'neutral',
  emphasis = 'subtle',
  size = 'sm',
  dot,
  icon,
  className,
  children,
  ...props
}: BadgeProps) {
  const sizing = SIZES[size];
  return (
    <span
      className={cn(
        'inline-flex w-fit max-w-full shrink-0 items-center whitespace-nowrap rounded-[7px] shadow-inset',
        FILLS[tone][emphasis],
        sizing.box,
        sizing.icon,
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn(
            'shrink-0 rounded-full',
            TONE_DOT[tone],
            sizing.dot,
            dot === 'pulse' && 'animate-pulse',
          )}
        />
      ) : null}
      {icon}
      {children}
    </span>
  );
}
