import { Select as Base } from '@base-ui/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { buttonVariants } from './button';
import { menuItem, menuPopup } from './recipes';

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown before the label, in the list and in the trigger. */
  icon?: ReactNode;
}

/** A pill that opens a list. Values are strings; the trigger shows the chosen option's label. */
export function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder = 'Choose…',
  size = 'md',
  className,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  value: T | null;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Base.Root
      items={options.map((option) => ({ value: option.value, label: option.label }))}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as T);
      }}
      disabled={disabled}
    >
      <Base.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        className={cn(
          buttonVariants({ variant: 'default', size }),
          'justify-between gap-2 pr-2.5',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.icon}
          <Base.Value placeholder={placeholder} className="truncate data-placeholder:text-placeholder" />
        </span>
        <Base.Icon className="flex">
          <ChevronsUpDown aria-hidden />
        </Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50 outline-hidden">
          <Base.Popup className={cn(menuPopup, 'min-w-(--anchor-width)')}>
            <Base.List>
              {options.map((option) => (
                <Base.Item key={option.value} value={option.value} className={cn(menuItem, 'pr-8')}>
                  {option.icon}
                  <Base.ItemText className="min-w-0 flex-1 truncate">{option.label}</Base.ItemText>
                  <Base.ItemIndicator className="absolute right-2.5 flex">
                    <Check aria-hidden className="text-foreground!" />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
