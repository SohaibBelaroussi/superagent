import { errorMessage, formatList } from '@superagent/client';
import { type Secret, SecretNameSchema } from '@superagent/shared';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useDeleteSecret, usePutSecret, useSecrets } from '../../api/settings';
import { Loaded } from '../../layout/loaded';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog, Dialog } from '../../ui/dialog';
import { EmptyState, FormFailure, Spinner } from '../../ui/feedback';
import { Field, Input, SecretInput } from '../../ui/field';
import { Page, PageHeader, Panel } from '../../ui/layout';
import { raisedSurface } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';

/**
 * Values MCP servers take from the vault (in their headers or environment). Stored sealed: only their
 * names come back.
 */
export function SecretsPage() {
  useDocumentTitle('Secrets');
  const secrets = useSecrets();
  const remove = useDeleteSecret();
  const [editing, setEditing] = useState<{ open: boolean; secret?: Secret }>({ open: false });
  const [deleting, setDeleting] = useState<Secret | null>(null);

  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Secrets"
          description="Credentials MCP servers use in their headers or environment. Stored sealed: only their names are ever shown."
          actions={
            <Button variant="primary" onClick={() => setEditing({ open: true })}>
              <Plus aria-hidden />
              Add a secret
            </Button>
          }
        />
      }
    >
      <Loaded query={secrets} failure="Couldn’t load the secrets">
        {(items) =>
          items.length === 0 ? (
            <Panel>
              <EmptyState
                compact
                icon={<KeyRound />}
                title="No secrets yet"
                description="Add one for an MCP server that needs a key, then refer to it by name in the server’s headers. Plugins add theirs when you install them."
              />
            </Panel>
          ) : (
            <ul className={cn('divide-y divide-border rounded-xl', raisedSurface)} aria-label="Secrets">
              {items.map((secret) => (
                <li key={secret.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-label text-foreground">{secret.name}</span>
                      {secret.plugin ? <Badge>From {secret.plugin}</Badge> : null}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      {secret.description ? `${secret.description} · ` : ''}
                      {secret.usedBy.length > 0 ? `Used by ${formatList(secret.usedBy)}` : 'Not used yet'} ·
                      changed <RelativeTime iso={secret.updatedAt} />
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Replace ${secret.name}`}
                    onClick={() => setEditing({ open: true, secret })}
                  >
                    Replace
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    tooltip={`Delete ${secret.name}`}
                    onClick={() => setDeleting(secret)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <SecretDialog
        open={editing.open}
        secret={editing.secret}
        taken={secrets.data?.map((secret) => secret.name) ?? []}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? ''}?`}
        description={
          deleting && deleting.usedBy.length > 0
            ? `${formatList(deleting.usedBy)} use it: remove it from them first.`
            : 'Its value is gone for good.'
        }
        confirmLabel="Delete secret"
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.name, {
            onSuccess: () => {
              toast.success(`${deleting.name} deleted`);
              setDeleting(null);
            },
            onError: () => setDeleting(null),
          });
        }}
      />
    </Page>
  );
}

/**
 * Stores a secret's value: a new one, or a replacement (`secret`). A new one can't take a name in use
 * (`taken`): the API would replace that secret's value for good.
 */
function SecretDialog({
  open,
  secret,
  taken,
  onOpenChange,
}: {
  open: boolean;
  secret?: Secret;
  taken: readonly string[];
  onOpenChange: (open: boolean) => void;
}) {
  const put = usePutSecret();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts fresh
  useEffect(() => {
    if (!open) return;
    setName(secret?.name ?? '');
    setValue('');
    setDescription(secret?.description ?? '');
    setErrors({});
    setFailure(null);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      name: !SecretNameSchema.safeParse(name.trim()).success
        ? 'Upper-case letters, digits and underscores, starting with a letter.'
        : !secret && taken.includes(name.trim())
          ? 'There’s a secret with this name: replace it from the list instead.'
          : undefined,
      value: value ? undefined : 'The value to store.',
    };
    setErrors(next);
    if (next.name || next.value) return;
    setFailure(null);
    try {
      // An emptied description clears it.
      await put.mutateAsync({ name: name.trim(), value, description: description.trim() });
      toast.success(secret ? `${name.trim()} replaced` : `${name.trim()} stored`);
      onOpenChange(false);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={secret ? `Replace ${secret.name}` : 'Add a secret'}
      description="Its value is stored sealed and never shown again."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="secret" variant="primary" disabled={put.isPending}>
            {put.isPending ? <Spinner /> : null}
            {secret ? 'Replace' : 'Store secret'}
          </Button>
        </>
      }
    >
      <form id="secret" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        <Field label="Name" error={errors.name} hint="How servers refer to it, like GITHUB_TOKEN.">
          {(control) => (
            <Input
              {...control}
              value={name}
              disabled={Boolean(secret)}
              maxLength={64}
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setName(event.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field label="Value" error={errors.value}>
          {(control) => (
            <SecretInput
              {...control}
              value={value}
              maxLength={16_384}
              revealLabel="Show the value"
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
        <Field label="What it’s for" hint="Optional.">
          {(control) => (
            <Input
              {...control}
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
