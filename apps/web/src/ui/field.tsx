import { type ComponentPropsWithRef, type ReactNode, useId, useState } from 'react';
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

/**
 * A field for a credential (a token, a key, a secret's value). A text field masked with CSS, not
 * type="password": browsers and password managers offer to save what's typed in a password field, and
 * credentials stay out of the browser (D45). "Show" unmasks it. `className` places the field;
 * `inputClassName` styles the text.
 */
export function SecretInput({
  className,
  inputClassName,
  revealLabel = 'Show what’s typed',
  ...props
}: Omit<ComponentPropsWithRef<'input'>, 'type'> & { inputClassName?: string; revealLabel?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={cn('relative w-full min-w-0', className)}>
      <Input
        type="text"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        {...props}
        className={cn('pr-16', !revealed && '[-webkit-text-security:disc]', inputClassName)}
      />
      <button
        type="button"
        onClick={() => setRevealed((shown) => !shown)}
        aria-pressed={revealed}
        aria-label={revealLabel}
        disabled={props.disabled}
        className="absolute top-1/2 right-1.5 h-6 -translate-y-1/2 cursor-pointer rounded-full px-2.5 text-caption text-muted-foreground enabled:hover:bg-fill enabled:hover:text-foreground disabled:cursor-not-allowed"
      >
        {revealed ? 'Hide' : 'Show'}
      </button>
    </div>
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
  // Only text that is on screen: an error replaces the hint.
  const describedBy = error ? errorId : hint ? hintId : undefined;
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
