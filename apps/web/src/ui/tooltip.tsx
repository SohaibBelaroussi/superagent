import { Tooltip as Base } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn';

export const TooltipProvider = Base.Provider;

/**
 * A short label on hover or focus. The child is the trigger itself (rendered through), so it keeps its
 * own semantics; it must accept a ref and props (a native element or one of our controls).
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delay,
  className,
}: {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  delay?: number;
  className?: string;
}) {
  return (
    <Base.Root>
      <Base.Trigger render={children} delay={delay} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={6} className="z-50">
          <Base.Popup
            className={cn(
              'max-w-72 origin-(--transform-origin) rounded-lg bg-popover px-2.5 py-1.5 text-caption text-foreground shadow-overlay',
              'transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none',
              className,
            )}
          >
            {content}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
