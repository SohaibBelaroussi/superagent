import { Switch as Base } from '@base-ui/react/switch';
import { useId } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './recipes';

/**
 * The switch alone, for a row that labels it elsewhere: a settings row's label (`aria-labelledby`), or
 * `aria-label`. Base UI gives `id` to its hidden input, so a `<label htmlFor>` toggles the switch but
 * doesn't name it: the visible switch takes its name from `aria-labelledby`.
 */
export function SwitchControl({
  id,
  checked,
  onCheckedChange,
  disabled,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <Base.Root
      id={id}
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-fill-strong p-0.5 transition-colors duration-150',
        'data-checked:bg-fill-inverse data-disabled:cursor-not-allowed data-disabled:opacity-50',
        focusRing,
        className,
      )}
    >
      <Base.Thumb className="size-3.5 rounded-full bg-background shadow-raised transition-transform duration-150 ease-out-custom data-checked:translate-x-3.5" />
    </Base.Root>
  );
}

/** An on/off setting with its label (and an optional hint) beside it. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <SwitchControl
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-0.5">
        <label
          id={`${id}-label`}
          htmlFor={id}
          className={cn('text-label text-foreground', disabled && 'text-muted-foreground')}
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
