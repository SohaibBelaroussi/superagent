import { Dialog as Base } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';

/**
 * A dialog opens on its first field, not on the close button before it (whose tooltip would also open
 * and take the first Escape). On touch, it keeps the default: a field would raise the keyboard.
 */
function firstField(type: string, popup: HTMLElement | null): HTMLElement | true {
  if (type === 'touch') return true;
  return (
    popup?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, [role="combobox"]') ??
    true
  );
}

import { cn } from '../lib/cn';
import { Button } from './button';
import { dialogSurface } from './recipes';

const backdrop =
  'fixed inset-0 z-50 bg-scrim transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0';

/** A modal dialog with a title, an optional description, a body and a footer of actions. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  size = 'md',
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Base.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Base.Portal>
        <Base.Backdrop className={backdrop} />
        <Base.Popup
          ref={popup}
          initialFocus={(type) => firstField(type, popup.current)}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[min(85dvh,52rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl outline-hidden',
            dialogSurface,
            'transition-[opacity,scale] duration-200 ease-out-custom data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0',
            size === 'sm' ? 'max-w-sm' : size === 'md' ? 'max-w-lg' : 'max-w-2xl',
            className,
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-4.5 pb-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Base.Title className="text-heading text-foreground">{title}</Base.Title>
              {description ? (
                <Base.Description className="text-body-sm text-muted-foreground">
                  {description}
                </Base.Description>
              ) : null}
            </div>
            <Base.Close
              render={<Button variant="ghost" size="icon-sm" tooltip="Close" className="-mt-0.5 -mr-1.5" />}
            >
              <X aria-hidden />
            </Base.Close>
          </div>
          {children ? <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-1">{children}</div> : null}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 px-5 pt-4 pb-5">{footer}</div>
          ) : null}
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}

/** Asks before something that can't be undone. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant={destructive ? 'destructive' : 'primary'} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/** A panel that slides in from an edge: the navigation drawer on phones. */
export function Sheet({
  open,
  onOpenChange,
  side = 'left',
  label,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: 'left' | 'right';
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Base.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Base.Portal>
        <Base.Backdrop className={backdrop} />
        <Base.Popup
          aria-label={label}
          className={cn(
            'fixed top-0 bottom-0 z-50 flex w-[min(20rem,85vw)] flex-col outline-hidden',
            side === 'left' ? 'left-0' : 'right-0',
            'transition-transform duration-300 ease-out-custom',
            side === 'left'
              ? 'data-starting-style:-translate-x-full data-ending-style:-translate-x-full'
              : 'data-starting-style:translate-x-full data-ending-style:translate-x-full',
            className,
          )}
        >
          {children}
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}
