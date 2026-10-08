import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../lib/cn';

/** A placeholder block while something loads. */
export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-fill', className)} {...props} />;
}

/** A turning arc, for work in progress on a control or a row. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('size-4 shrink-0 motion-safe:animate-spin', className)}
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** What an empty page, list or column says: what it's for, and the way to fill it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-16',
        className,
      )}
    >
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-full bg-fill-subtle text-muted-foreground shadow-rim [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-subheading text-foreground">{title}</p>
        {description ? <p className="text-body-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

const NOTICE = {
  info: {
    box: 'bg-info-subtle shadow-[inset_0_0_0_1px_var(--info-edge)]',
    icon: <Info className="text-info-indicator" />,
  },
  success: {
    box: 'bg-success-subtle shadow-[inset_0_0_0_1px_var(--success-edge)]',
    icon: <CircleCheck className="text-success-indicator" />,
  },
  warning: {
    box: 'bg-warning-subtle shadow-[inset_0_0_0_1px_var(--warning-edge)]',
    icon: <TriangleAlert className="text-warning-indicator" />,
  },
  destructive: {
    box: 'bg-destructive-subtle shadow-[inset_0_0_0_1px_var(--destructive-edge)]',
    icon: <CircleAlert className="text-destructive-indicator" />,
  },
} as const;

/** A message in the flow of a page: something went wrong, or something to know. */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof NOTICE;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'destructive' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-xl px-3.5 py-3', NOTICE[tone].box, className)}
    >
      <span aria-hidden className="mt-0.5 flex shrink-0 [&_svg]:size-4">
        {NOTICE[tone].icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <p className="text-label text-foreground">{title}</p> : null}
        {children ? <div className="text-body-sm break-words text-foreground/80">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A key on the keyboard. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-fill px-1 font-sans text-meta text-muted-foreground shadow-inset',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
