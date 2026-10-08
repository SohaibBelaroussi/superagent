import { Tabs as Base } from '@base-ui/react/tabs';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { colorTransition, focusRingInset } from './recipes';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** A count or badge after the label. */
  meta?: ReactNode;
}

/** Page-level tabs: quiet labels over a rule, the active one underlined. Panels are the caller's. */
export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  children,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  items: readonly TabItem<T>[];
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Base.Root value={value} onValueChange={(next) => onValueChange(next as T)} className={className}>
      <Base.List className="relative flex gap-5 border-b border-border">
        {items.map((item) => (
          <Base.Tab
            key={item.value}
            value={item.value}
            className={cn(
              'flex h-10 cursor-pointer items-center gap-1.5 text-label text-muted-foreground outline-hidden hover:text-foreground data-active:text-foreground',
              colorTransition,
              focusRingInset,
            )}
          >
            {item.label}
            {item.meta}
          </Base.Tab>
        ))}
        <Base.Indicator className="absolute bottom-[-1px] left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-foreground transition-[translate,width] duration-200 ease-out-custom" />
      </Base.List>
      {children}
    </Base.Root>
  );
}

export const TabPanel = ({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) => (
  <Base.Panel value={value} className={cn('outline-hidden', className)}>
    {children}
  </Base.Panel>
);

/** A row of mutually exclusive options in a pill track: filters, modes. */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  size = 'md',
  'aria-label': ariaLabel,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  size?: 'sm' | 'md';
  'aria-label': string;
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      value={[value]}
      onValueChange={(next) => {
        const chosen = next[0];
        if (chosen) onValueChange(chosen as T);
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full bg-fill-subtle p-0.5 shadow-rim',
        size === 'sm' ? 'h-control-sm' : 'h-control-md',
        className,
      )}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          title={option.title}
          className={cn(
            'flex h-full cursor-pointer items-center gap-1.5 rounded-full px-3 text-label text-muted-foreground outline-hidden hover:text-foreground [&_svg]:size-icon-sm',
            'data-pressed:bg-card data-pressed:text-foreground data-pressed:shadow-raised',
            colorTransition,
            focusRingInset,
          )}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
