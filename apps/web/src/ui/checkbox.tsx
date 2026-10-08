import { Checkbox as Base } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './recipes';

/** One of several choices that can all be on: a box, its label and an optional hint. */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <Base.Root
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        disabled={disabled}
        // Base UI gives `id` to its hidden input: the visible box takes its name from the label.
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={cn(
          'mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[5px] bg-field shadow-input transition-colors duration-150',
          'data-checked:bg-fill-inverse data-checked:text-background data-checked:shadow-none',
          'data-disabled:cursor-not-allowed data-disabled:opacity-50',
          focusRing,
        )}
      >
        <Base.Indicator className="flex data-unchecked:hidden">
          <Check aria-hidden className="size-3" strokeWidth={3} />
        </Base.Indicator>
      </Base.Root>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label
          id={`${id}-label`}
          htmlFor={id}
          className={cn(
            'text-body-sm text-foreground',
            disabled ? 'text-muted-foreground' : 'cursor-pointer',
          )}
        >
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-caption text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
