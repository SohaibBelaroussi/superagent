import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';
import { Spinner } from './feedback';
import { overlaySurface, raisedSurface } from './recipes';

/*
 * Settings as Factory lays them out: rows in one raised panel, ruled apart, each with its label and
 * description on the left and its control on the right (below it on a phone).
 */

/** A panel of setting rows. */
export function SettingsList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y divide-border rounded-xl', raisedSurface, className)}>{children}</div>;
}

/**
 * One setting: a label (for `htmlFor`'s control when given), a description, the control, and below
 * them what opens when it's on (`children`). The label's id is `${htmlFor}-label` and the description's
 * `${htmlFor}-description`, for controls that take their name from them (`settingLabels`).
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  control,
  wide = false,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control?: ReactNode;
  /** The control takes a field's width (16rem) rather than its own (a switch, a button). */
  wide?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label
            id={htmlFor ? `${htmlFor}-label` : undefined}
            htmlFor={htmlFor}
            className="text-label text-foreground"
          >
            {label}
          </Label>
          {description ? (
            <div
              id={htmlFor ? `${htmlFor}-description` : undefined}
              className="text-caption text-muted-foreground"
            >
              {description}
            </div>
          ) : null}
        </div>
        {control ? (
          <div className={cn('flex min-w-0 items-center', wide ? 'sm:w-64 sm:shrink-0' : 'shrink-0')}>
            {control}
          </div>
        ) : null}
      </div>
      {children ? <div className="flex flex-col gap-3 px-4 pb-3.5">{children}</div> : null}
    </div>
  );
}

/** The ARIA props that name a row's switch (or other Base UI control) after its label and description. */
export function settingLabels(id: string, described = true) {
  return {
    'aria-labelledby': `${id}-label`,
    'aria-describedby': described ? `${id}-description` : undefined,
  };
}

/** The heading over a group of rows inside a panel ("Web", "Browser"). */
export function SettingsGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pt-3 pb-1.5 text-eyebrow text-placeholder uppercase first:rounded-t-xl">
      {children}
    </div>
  );
}

/**
 * Floats at the bottom of the page while a form has unsaved changes: what saving does, discard, save.
 */
export function SaveBar({
  open,
  message,
  saveLabel = 'Save',
  saving = false,
  onDiscard,
  onSave,
}: {
  open: boolean;
  message: ReactNode;
  saveLabel?: string;
  saving?: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  if (!open) return null;
  return (
    <section
      aria-label="Unsaved changes"
      className={cn(
        'sticky bottom-4 z-10 mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-2.5',
        overlaySurface,
        'animate-in fade-in slide-in-from-bottom-2 duration-200',
      )}
    >
      <p className="min-w-0 flex-1 text-body-sm text-foreground">{message}</p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>
          {saving ? <Spinner /> : null}
          {saveLabel}
        </Button>
      </div>
    </section>
  );
}
