import type { ModelRef } from '@superagent/shared';
import { useModelChoices, useSettings } from '../../api/org';
import { Select } from '../../ui/select';

const DEFAULT = 'default';

/** "provider/model": provider slugs have no slash, model ids may. */
const refValue = (ref: ModelRef) => `${ref.provider}/${ref.model}`;
function parseRef(value: string): ModelRef | null {
  const slash = value.indexOf('/');
  return slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : null;
}

/** An agent's model: the default one (from settings), or any enabled chat model of a provider. */
export function ModelSelect({
  value,
  onChange,
  disabled,
  id,
  'aria-describedby': describedBy,
}: {
  value: ModelRef | null;
  onChange: (model: ModelRef | null) => void;
  disabled?: boolean;
  id?: string;
  'aria-describedby'?: string;
}) {
  const settings = useSettings();
  const models = useModelChoices();
  const fallback = settings.data?.models.default;
  const current = value ? refValue(value) : DEFAULT;
  const listed = models.choices.some((choice) => refValue(choice.ref) === current);
  return (
    <Select
      id={id}
      aria-describedby={describedBy}
      disabled={disabled}
      className="w-full"
      value={current}
      onValueChange={(next) => onChange(next === DEFAULT ? null : parseRef(next))}
      options={[
        {
          value: DEFAULT,
          label: fallback ? `Default · ${fallback.provider}/${fallback.model}` : 'Default · none set yet',
        },
        ...models.choices.map((choice) => ({ value: refValue(choice.ref), label: choice.label })),
        // Its model may be off now (or still loading): keep it shown rather than blank.
        ...(value && !listed
          ? [{ value: current, label: models.pending ? current : `${current} (not available)` }]
          : []),
      ]}
    />
  );
}

/** How an agent's model reads on its card: the model id, or "Default model". */
export function modelLabel(model: ModelRef | null): string {
  return model ? model.model : 'Default model';
}
