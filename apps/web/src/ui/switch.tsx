import { Switch as Base } from '@base-ui/react/switch';
import { useId } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './recipes';

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
      <Base.Root
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={cn(
          'relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-fill-strong p-0.5 transition-colors duration-150',
          'data-checked:bg-fill-inverse data-disabled:cursor-not-allowed data-disabled:opacity-50',
          focusRing,
        )}
      >
        <Base.Thumb className="size-3.5 rounded-full bg-background shadow-raised transition-transform duration-150 ease-out-custom data-checked:translate-x-3.5" />
      </Base.Root>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className={cn('text-label text-foreground', disabled && 'text-muted-foreground')}>
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
