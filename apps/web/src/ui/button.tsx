import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithRef } from 'react';
import { cn } from '../lib/cn';
import { colorTransition } from './recipes';
import { Tooltip } from './tooltip';

/*
 * Buttons are pills. The default one wears the field material (same fill and rim as an input), the
 * primary one is the inverse colour, and the ghost one has no fill until pointed at.
 */
export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-full text-label outline-hidden',
    colorTransition,
    'disabled:cursor-not-allowed aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed',
    '[&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        default: cn(
          'bg-field text-foreground shadow-input',
          '[&:hover:not(:active):not(:disabled)]:[--surface-tint:var(--fill-subtle)] [&:active:not(:disabled)]:[--surface-tint:var(--fill)]',
          'focus-visible:[--surface-rim:var(--border-focus)] data-popup-open:[--surface-tint:var(--fill)]',
          '[&_svg]:text-muted-foreground hover:[&_svg]:text-foreground',
          'disabled:bg-fill-subtle disabled:text-muted-foreground disabled:shadow-none',
        ),
        primary: cn(
          'bg-fill-inverse text-background not-disabled:hover:bg-fill-inverse-hover not-disabled:active:bg-fill-inverse-active',
          'focus-visible:outline-1 focus-visible:outline-border-focus focus-visible:outline-offset-2',
          'disabled:bg-fill-inverse-disabled disabled:text-background/80',
        ),
        ghost: cn(
          'bg-transparent text-muted-foreground not-disabled:hover:bg-fill-subtle not-disabled:hover:text-foreground not-disabled:active:bg-fill',
          'focus-visible:bg-fill-subtle focus-visible:text-foreground data-popup-open:bg-fill data-popup-open:text-foreground',
          'disabled:text-placeholder',
        ),
        destructive: cn(
          'bg-fill-destructive text-fill-destructive-foreground not-disabled:hover:bg-fill-destructive-hover not-disabled:active:bg-fill-destructive-active',
          'focus-visible:outline-1 focus-visible:outline-border-focus focus-visible:outline-offset-2',
          'disabled:opacity-60',
        ),
        'destructive-ghost': cn(
          'bg-transparent text-destructive-foreground not-disabled:hover:bg-destructive-subtle',
          'focus-visible:bg-destructive-subtle disabled:text-placeholder',
        ),
      },
      size: {
        sm: 'h-control-sm gap-1.5 px-3 [&_svg]:size-icon-sm has-[>svg:first-child]:pl-2.5',
        md: 'h-control-md gap-2 px-3.5 [&_svg]:size-icon-md has-[>svg:first-child]:pl-3',
        lg: 'h-control-lg gap-2 px-4 [&_svg]:size-icon-md has-[>svg:first-child]:pl-3.5',
        'icon-sm': 'size-control-sm [&_svg]:size-icon-sm',
        'icon-md': 'size-control-md [&_svg]:size-icon-md',
        'icon-lg': 'size-control-lg [&_svg]:size-icon-lg',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = ComponentPropsWithRef<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Shown on hover; also the accessible name of an icon-only button. */
    tooltip?: string;
  };

export function Button({ className, variant, size, tooltip, type = 'button', ...props }: ButtonProps) {
  const iconOnly = size?.startsWith('icon-');
  const button = (
    <button
      type={type}
      aria-label={iconOnly && tooltip && !props['aria-label'] ? tooltip : props['aria-label']}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
  return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
}
