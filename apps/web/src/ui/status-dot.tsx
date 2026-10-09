import type { Tone } from '@superagent/client';
import { cn } from '../lib/cn';
import { TONE_DOT } from '../lib/tones';

const RING_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  green: 'text-badge-green-indicator',
  red: 'text-badge-red-indicator',
  amber: 'text-badge-amber-indicator',
  blue: 'text-badge-blue-indicator',
  purple: 'text-badge-purple-indicator',
  orange: 'text-badge-orange-indicator',
  cyan: 'text-badge-cyan-indicator',
  pink: 'text-badge-pink-indicator',
};

/**
 * A status in 8 pixels. `live` adds a turning ring, for work happening now; `ring` draws an empty
 * circle, for something idle or not started. Decorative: say the status in text next to it.
 */
export function StatusDot({
  tone = 'neutral',
  live = false,
  ring = false,
  className,
}: {
  tone?: Tone;
  live?: boolean;
  ring?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-block size-2 shrink-0 rounded-full',
        ring ? 'border border-current bg-transparent' : TONE_DOT[tone],
        (live || ring) && RING_TEXT[tone],
        live &&
          "before:absolute before:-inset-1 before:rounded-full before:border before:border-border before:border-t-current before:content-[''] motion-safe:before:animate-spin",
        className,
      )}
    />
  );
}
