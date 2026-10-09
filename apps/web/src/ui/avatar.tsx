import type { Tone } from '@superagent/client';
import { cn } from '../lib/cn';

const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-fill-active text-foreground',
  green: 'bg-badge-green-strong text-badge-green-foreground',
  red: 'bg-badge-red-strong text-badge-red-foreground',
  amber: 'bg-badge-amber-strong text-badge-amber-foreground',
  blue: 'bg-badge-blue-strong text-badge-blue-foreground',
  purple: 'bg-badge-purple-strong text-badge-purple-foreground',
  orange: 'bg-badge-orange-strong text-badge-orange-foreground',
  cyan: 'bg-badge-cyan-strong text-badge-cyan-foreground',
  pink: 'bg-badge-pink-strong text-badge-pink-foreground',
};

const SIZES = {
  xs: 'size-4 text-[0.5rem]',
  sm: 'size-5 text-[0.5625rem]',
  md: 'size-7 text-[0.6875rem]',
  lg: 'size-9 text-label',
} as const;

/** "Research lead" → "RL". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words.at(-1)] : [name.trim()];
  return letters
    .map((word) => (word ? Array.from(word)[0] : ''))
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Initials in a tinted circle: agents and departments. */
export function Avatar({
  name,
  tone = 'neutral',
  size = 'md',
  className,
}: {
  name: string;
  tone?: Tone;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium shadow-inset',
        TONE_FILL[tone],
        SIZES[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
