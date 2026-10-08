import { Menu as Base } from '@base-ui/react/menu';
import { Check } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { menuItem, menuLabel, menuPopup, menuSeparator } from './recipes';

/** A menu opened by `trigger` (one of our buttons, rendered through so it keeps its look). */
export function Menu({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
  className,
}: {
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  return (
    <Base.Root>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner sideOffset={4} align={align} side={side} className="z-50 outline-hidden">
          <Base.Popup className={cn(menuPopup, className)}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

export function MenuItem({
  onClick,
  icon,
  children,
  destructive = false,
  disabled,
  shortcut,
}: {
  onClick?: () => void;
  icon?: ReactNode;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <Base.Item
      onClick={onClick}
      disabled={disabled}
      className={cn(
        menuItem,
        destructive &&
          'text-destructive-foreground data-highlighted:bg-destructive-subtle data-highlighted:text-destructive-foreground [&_svg]:text-destructive-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="ml-auto text-meta tracking-wider text-muted-foreground">{shortcut}</span>
      ) : null}
    </Base.Item>
  );
}

/** One choice among several, the current one checked (menuitemradio). */
export function MenuRadioGroup<T extends string>({
  value,
  onValueChange,
  options,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode; icon?: ReactNode }[];
}) {
  return (
    <Base.RadioGroup value={value} onValueChange={(next) => onValueChange(next as T)}>
      {options.map((option) => (
        <Base.RadioItem key={option.value} value={option.value} className={cn(menuItem, 'pr-8')}>
          {option.icon}
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          <Base.RadioItemIndicator className="absolute right-2.5 flex">
            <Check aria-hidden className="text-foreground!" />
          </Base.RadioItemIndicator>
        </Base.RadioItem>
      ))}
    </Base.RadioGroup>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Base.GroupLabel className={menuLabel}>{children}</Base.GroupLabel>;
}

export function MenuGroup({ children }: { children: ReactNode }) {
  return <Base.Group>{children}</Base.Group>;
}

export function MenuSeparator() {
  return <Base.Separator className={menuSeparator} />;
}
