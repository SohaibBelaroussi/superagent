import { type ComponentPropsWithRef, type ReactNode, useId } from 'react';
import { cn } from '../lib/cn';

/*
 * A field is the same material as a card: the field fill plus the inset rim. Hover washes the fill,
 * focus repaints the rim; an invalid field's rim turns red.
 */
const fieldMaterial = cn(
  'bg-field text-foreground shadow-input outline-hidden placeholder:text-placeholder',
  '[&:hover:not(:focus-visible):not(:disabled)]:[--surface-tint:var(--fill-subtle)]',
  'focus-visible:[--surface-rim:var(--field-rim-focus)]',
  'aria-invalid:[--field-rim:var(--destructive-indicator)] aria-invalid:[--field-rim-focus:var(--destructive-indicator)]',
  'disabled:cursor-not-allowed disabled:bg-field-disabled disabled:text-muted-foreground',
);

export function Input({ className, ...props }: ComponentPropsWithRef<'input'>) {
  return (
    <input
      className={cn(fieldMaterial, 'h-control-md w-full min-w-0 rounded-full px-3.5 text-body-sm', className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea
      className={cn(
        fieldMaterial,
        'field-sizing-content min-h-24 w-full min-w-0 resize-y rounded-xl px-3.5 py-2.5 text-body-sm leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A labelled control with an optional hint and error. The child gets the id, description and
 * invalid state through the render function, so any control fits.
 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (control: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-label text-foreground">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true as const } : {}) })}
      {error ? (
        <p id={errorId} className="text-caption text-destructive-foreground">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
