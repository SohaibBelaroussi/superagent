import { errorMessage, ProblemError } from '@superagent/client';
import { type Provider, ProviderSlugSchema, type UpdateProviderInput } from '@superagent/shared';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useCreateProvider, useUpdateProvider } from '../../api/settings';
import { slugify } from '../../lib/slug';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Dialog } from '../../ui/dialog';
import { FormFailure, Spinner } from '../../ui/feedback';
import { Field, Input, SecretInput } from '../../ui/field';
import { Switch } from '../../ui/switch';

interface Header {
  name: string;
  value: string;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Adds an OpenAI-compatible provider, or edits one (`provider`). Its key and header values are stored
 * sealed and never shown again: editing leaves them as they are unless you replace or remove them.
 */
export function ProviderDialog({
  open,
  onOpenChange,
  provider,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider?: Provider;
  /** After adding one: to look for its models. */
  onCreated?: (provider: Provider) => void;
}) {
  const create = useCreateProvider();
  const update = useUpdateProvider(provider?.id ?? '');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [headers, setHeaders] = useState<Header[]>([]);
  const [removeHeaders, setRemoveHeaders] = useState(false);
  const [strictJson, setStrictJson] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; baseUrl?: string; headers?: string }>(
    {},
  );
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from the provider
  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setSlug(provider?.slug ?? '');
    setSlugEdited(Boolean(provider));
    setBaseUrl(provider?.baseUrl ?? '');
    setApiKey('');
    setRemoveKey(false);
    setHeaders([]);
    setRemoveHeaders(false);
    setStrictJson(provider?.strictJson ?? false);
    setEnabled(provider?.enabled ?? true);
    setErrors({});
    setFailure(null);
  }, [open]);

  const shownSlug = slugEdited ? slug : slugify(name, 40);
  const pending = create.isPending || update.isPending;
  const filled = headers.filter((header) => header.name.trim() || header.value);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      name: name.trim() ? undefined : 'Give it a name.',
      slug:
        provider || ProviderSlugSchema.safeParse(shownSlug).success
          ? undefined
          : 'Lowercase letters, digits and dashes.',
      baseUrl: /^https?:\/\/.+/.test(baseUrl.trim())
        ? undefined
        : 'An http(s) address, usually ending in /v1.',
      headers: filled.every((header) => HEADER_NAME.test(header.name.trim()) && header.value)
        ? undefined
        : 'Each header needs a name (letters, digits, dashes) and a value.',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setFailure(null);
    const headerRecord = Object.fromEntries(filled.map((header) => [header.name.trim(), header.value]));
    try {
      if (provider) {
        const changes: UpdateProviderInput = {};
        if (name.trim() !== provider.name) changes.name = name.trim();
        if (baseUrl.trim().replace(/\/+$/, '') !== provider.baseUrl) changes.baseUrl = baseUrl.trim();
        if (removeKey) changes.apiKey = null;
        else if (apiKey.trim()) changes.apiKey = apiKey.trim();
        if (removeHeaders) changes.headers = null;
        else if (filled.length > 0) changes.headers = headerRecord;
        if (strictJson !== provider.strictJson) changes.strictJson = strictJson;
        if (enabled !== provider.enabled) changes.enabled = enabled;
        if (Object.keys(changes).length > 0) await update.mutateAsync(changes);
      } else {
        const created = await create.mutateAsync({
          slug: shownSlug,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          headers: filled.length > 0 ? headerRecord : undefined,
          strictJson,
          enabled,
        });
        onCreated?.(created);
      }
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ProblemError && error.status === 409)
        setErrors({ slug: 'Another provider has this slug.' });
      else setFailure(errorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={provider ? `Edit ${provider.name}` : 'Add a provider'}
      description="Any server that speaks the OpenAI API: a hosted service, or one you run yourself."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="provider" variant="primary" disabled={pending}>
            {pending ? <Spinner /> : null}
            {provider ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form id="provider" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                placeholder="My models"
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Slug"
            error={errors.slug}
            hint={
              provider ? 'Agents name its models by it: it can’t change.' : 'Agents name its models by it.'
            }
          >
            {(control) => (
              <Input
                {...control}
                value={shownSlug}
                disabled={Boolean(provider)}
                maxLength={40}
                className="font-mono"
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
        </div>
        <Field
          label="Base URL"
          error={errors.baseUrl}
          hint="Its OpenAI-compatible address, usually ending in /v1."
        >
          {(control) => (
            <Input
              {...control}
              type="url"
              value={baseUrl}
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              className="font-mono"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          )}
        </Field>
        <Field
          label="API key"
          hint={
            provider?.hasApiKey
              ? 'One is set. Leave this empty to keep it. Stored sealed, never shown again.'
              : 'Stored sealed, never shown again. Leave empty for a server that needs none.'
          }
        >
          {(control) => (
            <SecretInput
              {...control}
              value={apiKey}
              disabled={removeKey}
              placeholder={provider?.hasApiKey ? 'Unchanged' : undefined}
              revealLabel="Show the key"
              onChange={(event) => setApiKey(event.target.value)}
            />
          )}
        </Field>
        {provider?.hasApiKey ? (
          <Checkbox checked={removeKey} onCheckedChange={setRemoveKey} label="Remove its key" />
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-label text-foreground">Headers</legend>
          <p className="-mt-1 text-caption text-muted-foreground">
            {provider && provider.headerNames.length > 0
              ? `It sends ${provider.headerNames.join(', ')}. Headers added here replace them all.`
              : 'Extra headers sent with every request, sealed like the key.'}
          </p>
          {errors.headers ? (
            <p className="text-caption text-destructive-foreground">{errors.headers}</p>
          ) : null}
          {headers.map((header, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; their place is their identity
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={`Header ${index + 1} name`}
                value={header.name}
                placeholder="X-Org-Id"
                spellCheck={false}
                className="font-mono sm:w-56"
                disabled={removeHeaders}
                onChange={(event) =>
                  setHeaders(
                    headers.map((row, at) => (at === index ? { ...row, name: event.target.value } : row)),
                  )
                }
              />
              <SecretInput
                aria-label={`Header ${index + 1} value`}
                className="flex-1"
                value={header.value}
                disabled={removeHeaders}
                revealLabel={`Show header ${index + 1}’s value`}
                onChange={(event) =>
                  setHeaders(
                    headers.map((row, at) => (at === index ? { ...row, value: event.target.value } : row)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                tooltip={`Remove header ${index + 1}`}
                onClick={() => setHeaders(headers.filter((_, at) => at !== index))}
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={removeHeaders}
              onClick={() => setHeaders([...headers, { name: '', value: '' }])}
            >
              <Plus aria-hidden />
              Add a header
            </Button>
            {provider && provider.headerNames.length > 0 ? (
              <Checkbox
                checked={removeHeaders}
                onCheckedChange={setRemoveHeaders}
                label="Remove its headers"
              />
            ) : null}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            label="Enabled"
            hint="Agents and roles can use its models."
          />
          <Switch
            checked={strictJson}
            onCheckedChange={setStrictJson}
            label="Strict JSON schemas"
            hint="For structured output, when the server supports them."
          />
        </div>
      </form>
    </Dialog>
  );
}
