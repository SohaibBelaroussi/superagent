import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** The text roles from theme.css: font sizes to tailwind-merge, so `text-label` never collides with a colour. */
export const TEXT_ROLES = [
  'hero',
  'display',
  'title',
  'heading',
  'subheading',
  'body',
  'label',
  'card-title',
  'body-sm',
  'column',
  'caption',
  'eyebrow',
  'meta',
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [...TEXT_ROLES],
      radius: ['card', 'frame'],
      spacing: ['control-sm', 'control-md', 'control-lg', 'icon-xs', 'icon-sm', 'icon-md', 'icon-lg'],
      shadow: ['raised', 'input', 'overlay', 'inset', 'rim'],
    },
  },
});

/** Joins class names; a later utility replaces an earlier one of the same kind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
