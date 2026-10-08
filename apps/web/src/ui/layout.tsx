import { type ComponentPropsWithoutRef, type ReactNode, useId } from 'react';
import { cn } from '../lib/cn';
import { raisedSurface } from './recipes';

/** A raised panel: lists, details, forms. */
export function Panel({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('rounded-xl', raisedSurface, className)} {...props} />;
}

/**
 * A titled block of a page: a small heading, an optional action on its right, then the content. A
 * region named by its heading.
 */
export function Section({
  title,
  action,
  children,
  className,
  id,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const own = useId();
  const headingId = id ?? own;
  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-3', className)}>
      <div className="flex min-h-control-sm items-center justify-between gap-3">
        <h2 id={headingId} className="text-subheading text-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The scrolling body of a page inside the frame: a header, then content. `narrow` reads like a
 * document; `wide` uses the whole frame (the board).
 */
export function Page({
  header,
  children,
  width = 'narrow',
  className,
  contentClassName,
}: {
  header?: ReactNode;
  children: ReactNode;
  width?: 'narrow' | 'medium' | 'wide';
  className?: string;
  contentClassName?: string;
}) {
  const max = width === 'narrow' ? 'max-w-4xl' : width === 'medium' ? 'max-w-6xl' : 'max-w-none';
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', className)}>
      <div
        className={cn(
          'mx-auto flex w-full flex-1 flex-col px-4 pt-5 pb-12 sm:px-8 sm:pt-7',
          max,
          contentClassName,
        )}
      >
        {header}
        {children}
      </div>
    </div>
  );
}

/** A page's title row: an optional eyebrow and description, actions on the right. */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? (
          <div className="flex items-center gap-1.5 text-caption text-muted-foreground">{eyebrow}</div>
        ) : null}
        <h1 className="text-title text-foreground">{title}</h1>
        {description ? <p className="max-w-2xl text-body-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/** A label and its value, in a details list. */
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3 py-1.5">
      <dt className="text-caption leading-[1.375rem] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-body-sm leading-[1.375rem] text-foreground">{children}</dd>
    </div>
  );
}

/** A thin bar for progress, with its percentage for screen readers. */
export function ProgressBar({
  value,
  className,
  label,
}: {
  value: number;
  className?: string;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-label={label ?? 'Progress'}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-fill', className)}
    >
      <div
        className="h-full rounded-full bg-foreground/70 transition-[width] duration-500 ease-out-custom"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
