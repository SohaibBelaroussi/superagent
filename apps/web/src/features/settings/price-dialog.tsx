import { errorMessage } from '@superagent/client';
import type { ProviderModel } from '@superagent/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useRemovePrice, useSetPrice } from '../../api/settings';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { FormFailure, Spinner } from '../../ui/feedback';
import { Field, Input } from '../../ui/field';

const usd = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

/**
 * What one model costs, in USD per million tokens. Calls are priced as they happen: a new price counts
 * from now on, earlier calls keep theirs.
 */
export function PriceDialog({
  providerId,
  model,
  onOpenChange,
}: {
  providerId: string;
  /** The model priced; the dialog is open while there is one. */
  model: ProviderModel | null;
  onOpenChange: (open: boolean) => void;
}) {
  const setPrice = useSetPrice(providerId);
  const removePrice = useRemovePrice(providerId);
  const [input, setInput] = useState('');
  const [cached, setCached] = useState('');
  const [output, setOutput] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from the model's price
  useEffect(() => {
    if (!model) return;
    setInput(model.price ? String(model.price.inputUsd) : '');
    setCached(model.price?.cachedInputUsd != null ? String(model.price.cachedInputUsd) : '');
    setOutput(model.price ? String(model.price.outputUsd) : '');
    setFailure(null);
  }, [model?.modelId]);

  const invalid = (value: number) => Number.isNaN(value) || value < 0 || value > 100_000;
  const inputUsd = usd(input);
  const outputUsd = usd(output);
  const cachedUsd = cached.trim() ? usd(cached) : undefined;
  const ready = !invalid(inputUsd) && !invalid(outputUsd) && (cachedUsd === undefined || !invalid(cachedUsd));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!model || !ready) return;
    setFailure(null);
    try {
      await setPrice.mutateAsync({
        modelId: model.modelId,
        inputUsd,
        outputUsd,
        ...(cachedUsd === undefined ? {} : { cachedInputUsd: cachedUsd }),
      });
      onOpenChange(false);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }

  return (
    <Dialog
      open={model !== null}
      onOpenChange={onOpenChange}
      size="sm"
      title={model ? `Price of ${model.modelId}` : ''}
      description="USD per million tokens. It counts from now on: earlier calls keep the price they had."
      footer={
        <>
          {model?.price ? (
            <Button
              variant="destructive-ghost"
              className="mr-auto"
              disabled={removePrice.isPending}
              onClick={() =>
                model && removePrice.mutate(model.modelId, { onSuccess: () => onOpenChange(false) })
              }
            >
              Remove price
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="price" variant="primary" disabled={!ready || setPrice.isPending}>
            {setPrice.isPending ? <Spinner /> : null}
            Save price
          </Button>
        </>
      }
    >
      <form id="price" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        <div className="grid gap-4 sm:grid-cols-3">
          {(
            [
              ['Input', input, setInput, true],
              ['Cached input', cached, setCached, false],
              ['Output', output, setOutput, true],
            ] as const
          ).map(([label, value, set, required]) => (
            <Field key={label} label={label} hint={required ? undefined : 'Optional.'}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  required={required}
                  value={value}
                  placeholder="0.00"
                  onChange={(event) => set(event.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
      </form>
    </Dialog>
  );
}
