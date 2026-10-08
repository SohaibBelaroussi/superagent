import type { ModelRole, Provider, ProviderModel, ProviderTestResult } from '@superagent/shared';
import { CircleAlert, CircleCheck, Cpu, Ellipsis, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useModelChoices, useSettings } from '../../api/org';
import {
  useAddModel,
  useDeleteProvider,
  useDiscoverModels,
  useProviderModels,
  useProviders,
  useRefreshModels,
  useRemoveModel,
  useTestProvider,
  useUpdateSettings,
} from '../../api/settings';
import { Loaded } from '../../layout/loaded';
import { cn } from '../../lib/cn';
import { formatCost, plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton, Spinner } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { Page, PageHeader, Panel, Section } from '../../ui/layout';
import { Menu, MenuItem, MenuSeparator } from '../../ui/menu';
import { Select } from '../../ui/select';
import { SettingRow, SettingsList } from '../../ui/settings';
import { Segmented } from '../../ui/tabs';
import { toast } from '../../ui/toast';
import { parseRef, refValue } from '../agents/model-select';
import { PriceDialog } from './price-dialog';
import { ProviderDialog } from './provider-dialog';

const ROLES: { role: ModelRole; label: string; description: string; kind: 'chat' | 'embedding' }[] = [
  {
    role: 'default',
    label: 'Default model',
    description: 'What agents use unless their definition picks one.',
    kind: 'chat',
  },
  {
    role: 'fast',
    label: 'Fast model',
    description: 'Quick, cheap work: task titles, memory compression, judging results.',
    kind: 'chat',
  },
  {
    role: 'embedding',
    label: 'Embedding model',
    description: 'Semantic recall and knowledge search. Without one, knowledge search matches words.',
    kind: 'embedding',
  },
];

const NOT_SET = '-';

/** Where agents' models come from: the providers, their models and prices, and the model roles. */
export function ModelsPage() {
  useDocumentTitle('Models');
  const providers = useProviders();
  const discover = useDiscoverModels();
  const [adding, setAdding] = useState(false);
  // A new provider's models are asked for once it exists; by hand when it can't list them.
  const listModels = (provider: Provider) =>
    discover.mutate(provider.id, {
      onSuccess: (list) =>
        toast.success(`${provider.name} added`, `${plural(list.items.length, 'model')} found.`),
      onError: (error) =>
        toast.info(
          `${provider.name} added`,
          `Its models couldn’t be listed (${errorMessage(error)}): add them by hand.`,
        ),
    });
  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Models"
          description="Agents reach models through providers: any server that speaks the OpenAI API. Prices turn the tokens they use into cost."
          actions={
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              Add a provider
            </Button>
          }
        />
      }
    >
      <div className="flex flex-col gap-8">
        <Section title="Roles">
          <ModelRoles />
        </Section>
        <Section title="Providers">
          <Loaded query={providers} failure="Couldn’t load the providers">
            {(items) =>
              items.length === 0 ? (
                <Panel>
                  <EmptyState
                    compact
                    icon={<Cpu />}
                    title="No providers yet"
                    description="Add the server your models run on. Its models are listed for you when it has a /models endpoint."
                    action={
                      <Button variant="primary" onClick={() => setAdding(true)}>
                        <Plus aria-hidden />
                        Add a provider
                      </Button>
                    }
                  />
                </Panel>
              ) : (
                <ul className="flex flex-col gap-3" aria-label="Providers">
                  {items.map((provider) => (
                    <li key={provider.id}>
                      <ProviderPanel provider={provider} />
                    </li>
                  ))}
                </ul>
              )
            }
          </Loaded>
        </Section>
      </div>
      <ProviderDialog open={adding} onOpenChange={setAdding} onCreated={listModels} />
    </Page>
  );
}

/** The default, fast and embedding models: saved as you pick them. */
function ModelRoles() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const chat = useModelChoices('chat');
  const embedding = useModelChoices('embedding');
  const ids = { default: useId(), fast: useId(), embedding: useId() };
  return (
    <Loaded query={settings} failure="Couldn’t load the settings">
      {(data) => (
        <SettingsList>
          {ROLES.map(({ role, label, description, kind }) => {
            const current = data.models[role];
            const { choices, pending } = kind === 'chat' ? chat : embedding;
            const value = current ? refValue(current) : NOT_SET;
            const listed = choices.some((choice) => refValue(choice.ref) === value);
            return (
              <SettingRow
                key={role}
                label={label}
                htmlFor={ids[role]}
                description={description}
                wide
                control={
                  <Select
                    id={ids[role]}
                    aria-describedby={`${ids[role]}-description`}
                    className="w-full"
                    value={value}
                    disabled={update.isPending}
                    onValueChange={(next) => {
                      const ref = next === NOT_SET ? null : parseRef(next);
                      update.mutate(
                        { models: { [role]: ref } },
                        {
                          onSuccess: () => toast.success(ref ? `${label}: ${ref.model}` : `${label} cleared`),
                          onError: (error) =>
                            toast.error(`Couldn’t set the ${label.toLowerCase()}`, errorMessage(error)),
                        },
                      );
                    }}
                    options={[
                      { value: NOT_SET, label: 'Not set' },
                      ...choices.map((choice) => ({ value: refValue(choice.ref), label: choice.label })),
                      // Not listed while the models load; once they have, it isn't one of them.
                      ...(current && !listed
                        ? [{ value, label: pending ? value : `${value} (not available)` }]
                        : []),
                    ]}
                  />
                }
              />
            );
          })}
        </SettingsList>
      )}
    </Loaded>
  );
}

function ProviderPanel({ provider }: { provider: Provider }) {
  const models = useProviderModels(provider.id);
  const test = useTestProvider(provider.id);
  const refresh = useRefreshModels(provider.id);
  const remove = useDeleteProvider(provider.id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pricing, setPricing] = useState<ProviderModel | null>(null);
  const titleId = useId();
  const embeddingModel = models.data?.find((model) => model.kind === 'embedding' && model.enabled);

  return (
    <Panel className="flex flex-col" aria-labelledby={titleId} role="group">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 id={titleId} className="text-card-title text-foreground">
            {provider.name} <span className="ml-1 font-mono text-meta text-placeholder">{provider.slug}</span>
          </h3>
          <p className="truncate font-mono text-caption text-muted-foreground">{provider.baseUrl}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {provider.enabled ? (
              <Badge tone="green" dot>
                Enabled
              </Badge>
            ) : (
              <Badge>Off</Badge>
            )}
            <Badge>{provider.hasApiKey ? 'Key set' : 'No key'}</Badge>
            {provider.headerNames.length > 0 ? (
              <Badge>{plural(provider.headerNames.length, 'header')}</Badge>
            ) : null}
            {provider.strictJson ? <Badge>Strict JSON</Badge> : null}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate(embeddingModel ? { embeddingModel: embeddingModel.modelId } : {})}
          >
            {test.isPending ? <Spinner /> : null}
            Test
          </Button>
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" tooltip={`More for ${provider.name}`}>
                <Ellipsis aria-hidden />
              </Button>
            }
          >
            <MenuItem icon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>
              Edit
            </MenuItem>
            <MenuItem
              icon={<RefreshCw aria-hidden />}
              onClick={() =>
                refresh.mutate(undefined, {
                  onSuccess: (list) => toast.success(`${plural(list.items.length, 'model')} listed`),
                })
              }
            >
              Look for new models
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 aria-hidden />} destructive onClick={() => setDeleting(true)}>
              Delete…
            </MenuItem>
          </Menu>
        </div>
      </div>
      {!provider.secretsReadable ? (
        <Notice tone="warning" className="mx-4 mb-3" title="Its key can’t be read">
          The encryption key changed since it was stored. Edit the provider and set its key (and headers)
          again.
        </Notice>
      ) : null}
      {test.data ? <TestResult result={test.data} /> : null}
      <Models providerId={provider.id} models={models} onPrice={setPricing} />

      <ProviderDialog open={editing} onOpenChange={setEditing} provider={provider} />
      <PriceDialog
        providerId={provider.id}
        model={pricing}
        onOpenChange={(open) => {
          if (!open) setPricing(null);
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${provider.name}?`}
        description="Agents and roles that use its models stop working until they pick another. Its usage history stays."
        confirmLabel="Delete provider"
        destructive
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setDeleting(false);
              toast.success(`${provider.name} deleted`);
            },
            onError: () => setDeleting(false),
          })
        }
      />
    </Panel>
  );
}

const CHECKS: Record<string, string> = {
  chat: 'Chat',
  stream: 'Streaming',
  tools: 'Tool calls',
  embedding: 'Embeddings',
};

const VERDICT = {
  ok: { title: 'Everything works', box: 'bg-success-subtle shadow-[inset_0_0_0_1px_var(--success-edge)]' },
  partly: {
    title: 'It answers, but not everything works',
    box: 'bg-warning-subtle shadow-[inset_0_0_0_1px_var(--warning-edge)]',
  },
  down: {
    title: 'It doesn’t answer',
    box: 'bg-destructive-subtle shadow-[inset_0_0_0_1px_var(--destructive-edge)]',
  },
};

/** The checks' outcome: all good, answering with some features failing, or not answering at all. */
function TestResult({ result }: { result: ProviderTestResult }) {
  const answers = result.checks.find((check) => check.name === 'chat')?.ok ?? false;
  const verdict = VERDICT[result.ok ? 'ok' : answers ? 'partly' : 'down'];
  return (
    <div role="status" className={cn('mx-4 mb-3 flex flex-col gap-1.5 rounded-xl px-3.5 py-3', verdict.box)}>
      <p className="text-label text-foreground">
        {verdict.title}
        {result.model ? (
          <span className="font-normal text-muted-foreground"> with {result.model}</span>
        ) : null}
      </p>
      <ul className="flex flex-col gap-1">
        {result.checks.map((check) => (
          <li key={check.name} className="flex items-start gap-2 text-body-sm">
            {check.ok ? (
              <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success-indicator" />
            ) : (
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive-indicator" />
            )}
            <span className="min-w-0 flex-1">
              <span className="text-foreground">{CHECKS[check.name] ?? check.name}</span>
              <span className="text-muted-foreground">
                {' '}
                · {check.ok ? 'works' : 'fails'} · {Math.round(check.ms)} ms
              </span>
              {check.error || check.detail ? (
                <span className="block break-words text-caption text-muted-foreground">
                  {check.error ?? check.detail}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function priceText(model: ProviderModel): string {
  if (!model.price) return 'No price';
  const { inputUsd, outputUsd } = model.price;
  return `${formatCost(inputUsd)} in · ${formatCost(outputUsd)} out`;
}

/** A provider's models: found on it or added by hand, each with its price. */
function Models({
  providerId,
  models,
  onPrice,
}: {
  providerId: string;
  models: ReturnType<typeof useProviderModels>;
  onPrice: (model: ProviderModel) => void;
}) {
  const add = useAddModel(providerId);
  const remove = useRemoveModel(providerId);
  const [modelId, setModelId] = useState('');
  const [kind, setKind] = useState<'chat' | 'embedding'>('chat');
  const inputId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!modelId.trim()) return;
    add.mutate({ modelId: modelId.trim(), kind }, { onSuccess: () => setModelId('') });
  };

  if (models.isPending) return <Skeleton className="mx-4 mb-4 h-16 rounded-lg" />;
  if (models.isError) {
    return (
      <Notice tone="destructive" className="mx-4 mb-4" title="Couldn’t load its models">
        {errorMessage(models.error)}
      </Notice>
    );
  }
  const items = models.data;
  return (
    <div className="flex flex-col border-t border-border">
      {items.length > 0 ? (
        <ul className="divide-y divide-border" aria-label="Models">
          {items.map((model) => (
            <li key={model.modelId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-foreground">
                {model.modelId}
              </span>
              <Badge tone={model.kind === 'embedding' ? 'purple' : 'blue'}>{model.kind}</Badge>
              {model.source === 'manual' ? <Badge>Added by hand</Badge> : null}
              <span className={cn('text-caption', model.price ? 'text-foreground/80' : 'text-placeholder')}>
                {priceText(model)}
                {model.price ? <span className="text-muted-foreground"> per M</span> : null}
              </span>
              <Button size="sm" variant="ghost" onClick={() => onPrice(model)}>
                {model.price ? 'Change price' : 'Set price'}
              </Button>
              {model.source === 'manual' ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  tooltip={`Remove ${model.modelId}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(model.modelId)}
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-body-sm text-muted-foreground">
          No models yet: look for them (in the menu), or add one by hand.
        </p>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <label htmlFor={inputId} className="sr-only">
          Model id to add
        </label>
        <Input
          id={inputId}
          value={modelId}
          spellCheck={false}
          placeholder="Add a model by its id"
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => setModelId(event.target.value)}
        />
        <Segmented
          aria-label="Kind"
          size="sm"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'embedding', label: 'Embedding' },
          ]}
        />
        <Button type="submit" size="sm" disabled={!modelId.trim() || add.isPending}>
          {add.isPending ? <Spinner /> : <Plus aria-hidden />}
          Add
        </Button>
      </form>
    </div>
  );
}
