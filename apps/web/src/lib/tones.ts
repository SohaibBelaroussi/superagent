import type { Tone } from '@superagent/client';

/*
 * The tones' Tailwind classes. What each phase, priority and department wears is shared with the phone
 * app (`PHASES`, `PRIORITIES`, `departmentTone` in `@superagent/client`).
 */

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
