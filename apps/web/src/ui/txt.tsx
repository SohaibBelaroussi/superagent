import type { ComponentPropsWithoutRef, ElementType } from 'react';
import type { TEXT_ROLES } from '../lib/cn';
import { cn } from '../lib/cn';

export type TextRole = (typeof TEXT_ROLES)[number];

const ROLES: Record<TextRole, string> = {
  hero: 'text-hero',
  display: 'text-display',
  title: 'text-title',
  heading: 'text-heading',
  subheading: 'text-subheading',
  body: 'text-body',
  label: 'text-label',
  'card-title': 'text-card-title',
  'body-sm': 'text-body-sm',
  column: 'text-column',
  caption: 'text-caption',
  eyebrow: 'text-eyebrow uppercase',
  meta: 'text-meta',
};

const TONES = {
  ink: 'text-foreground',
  muted: 'text-muted-foreground',
  faint: 'text-placeholder',
} as const;

export function textStyle(variant: TextRole = 'body', tone?: keyof typeof TONES): string {
  return cn(ROLES[variant], tone && TONES[tone]);
}

type TxtProps<T extends ElementType> = {
  as?: T;
  variant?: TextRole;
  tone?: keyof typeof TONES;
  mono?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, 'as'>;

/** Text in one of the type roles; layout and controls own their markup. */
export function Txt<T extends ElementType = 'p'>({
  as,
  variant,
  tone,
  mono,
  className,
  ...props
}: TxtProps<T>) {
  const Tag: ElementType = as ?? 'p';
  return <Tag className={cn(textStyle(variant, tone), mono && 'font-mono', className)} {...props} />;
}
