import { errorMessage, ProblemError } from '@superagent/client';
import { type BrowserIdentity, BrowserIdentityNameSchema, type BrowserSession } from '@superagent/shared';
import { Globe, LogIn, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  useCloseSignIn,
  useCloseTaskBrowser,
  useCreateIdentity,
  useDeleteIdentity,
  useOpenBrowsers,
  useOpenSignIn,
} from '../../api/browsers';
import { useBrowserIdentities } from '../../api/org';
import { Loaded } from '../../layout/loaded';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog, Dialog } from '../../ui/dialog';
import { EmptyState, FormFailure, Spinner } from '../../ui/feedback';
import { Field, Input } from '../../ui/field';
import { Page, PageHeader, Panel, Section } from '../../ui/layout';
import { raisedSurface } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';

/** Who has an identity now: a task's browser, your sign-in session, or nobody. */
function holderText(identity: BrowserIdentity): string | null {
  if (!identity.holder) return null;
  if (identity.holder.kind === 'owner') return 'You’re signing in';
  return identity.holder.taskNumber ? `In use by task #${identity.holder.taskNumber}` : 'In use by a task';
}

/**
 * The browsers agents use: identities (profiles you sign in to sites with, which agents granted them
 * browse as) and the browsers open now.
 */
export function BrowsersPage() {
  useDocumentTitle('Browsers');
  const identities = useBrowserIdentities();
  const open = useOpenBrowsers();
  const openSignIn = useOpenSignIn();
  const remove = useDeleteIdentity();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BrowserIdentity | null>(null);

  const signIn = (identity: BrowserIdentity) => {
    const page = `/settings/browsers/${identity.id}/sign-in`;
    // Already signing in: go back to it.
    if (identity.holder?.kind === 'owner') return navigate(page);
    openSignIn.mutate(identity.id, { onSuccess: () => navigate(page) });
  };

  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Browsers"
          description="Agents with the browser use Chromium, one per task, through superagent’s network checks. An identity is a browser profile you sign in to sites with: an agent granted it browses signed in."
          actions={
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              New identity
            </Button>
          }
        />
      }
    >
      <div className="flex flex-col gap-8">
        <Section title="Identities">
          <Loaded query={identities} failure="Couldn’t load the identities">
            {(items) =>
              items.length === 0 ? (
                <Panel>
                  <EmptyState
                    compact
                    icon={<LogIn />}
                    title="No identities yet"
                    description="Make one, sign in to the sites an agent needs, then give the agent the browser with it."
                  />
                </Panel>
              ) : (
                <ul
                  className={cn('divide-y divide-border rounded-xl', raisedSurface)}
                  aria-label="Identities"
                >
                  {items.map((identity) => {
                    const held = holderText(identity);
                    return (
                      <li key={identity.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-label text-foreground">{identity.name}</span>
                            {held ? (
                              <Badge tone={identity.holder?.kind === 'owner' ? 'blue' : 'amber'} dot>
                                {held}
                              </Badge>
                            ) : null}
                          </p>
                          <p className="text-caption text-muted-foreground">
                            {identity.description ? `${identity.description} · ` : ''}
                            {identity.lastUsedAt ? (
                              <>
                                used <RelativeTime iso={identity.lastUsedAt} />
                              </>
                            ) : (
                              'never used'
                            )}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          aria-label={`Sign in as ${identity.name}`}
                          disabled={identity.holder?.kind === 'task' || openSignIn.isPending}
                          onClick={() => signIn(identity)}
                        >
                          {openSignIn.isPending && openSignIn.variables === identity.id ? (
                            <Spinner />
                          ) : (
                            <LogIn aria-hidden />
                          )}
                          Sign in
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          tooltip={`Delete ${identity.name}`}
                          onClick={() => setDeleting(identity)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )
            }
          </Loaded>
        </Section>

        <Section title="Open now">
          <Loaded query={open} failure="Couldn’t load the open browsers">
            {(items) =>
              items.length === 0 ? (
                <Panel>
                  <EmptyState compact icon={<Globe />} title="No browser is open" />
                </Panel>
              ) : (
                <ul
                  className={cn('divide-y divide-border rounded-xl', raisedSurface)}
                  aria-label="Open browsers"
                >
                  {items.map((browser) => (
                    <OpenBrowserRow
                      key={`${browser.kind}:${browser.taskId ?? browser.identity ?? ''}`}
                      browser={browser}
                      identities={identities.data ?? []}
                    />
                  ))}
                </ul>
              )
            }
          </Loaded>
        </Section>
      </div>

      <NewIdentityDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? ''}?`}
        description="Its profile goes, with its cookies and sign-ins. An identity a browser uses, or an agent is given, can’t be deleted."
        confirmLabel="Delete identity"
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
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

/** A browser open now, with a way to close it (the page reader closes by itself). */
function OpenBrowserRow({
  browser,
  identities,
}: {
  browser: BrowserSession;
  identities: readonly BrowserIdentity[];
}) {
  const closeTask = useCloseTaskBrowser(browser.taskId ?? '');
  const closeSignIn = useCloseSignIn();
  const identity = identities.find((item) => item.name === browser.identity);
  const pending = closeTask.isPending || closeSignIn.isPending;

  const title =
    browser.kind === 'task' && browser.taskId ? (
      <Link to={`/tasks/${browser.taskId}?view=browser`} className="hover:underline hover:underline-offset-2">
        {browser.taskNumber ? `Task #${browser.taskNumber}` : 'A task'}
      </Link>
    ) : browser.kind === 'sign-in' ? (
      identity ? (
        <Link
          to={`/settings/browsers/${identity.id}/sign-in`}
          className="hover:underline hover:underline-offset-2"
        >
          Signing in as {browser.identity}
        </Link>
      ) : (
        `Signing in as ${browser.identity ?? 'an identity'}`
      )
    ) : (
      'The page reader'
    );
  const close = () => {
    if (browser.kind === 'task')
      closeTask.mutate(undefined, { onSuccess: () => toast.success('Browser closed') });
    else if (identity) closeSignIn.mutate(identity.id, { onSuccess: () => toast.success('Sign-ins saved') });
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2 text-label text-foreground">
          {title}
          {browser.identity && browser.kind === 'task' ? <Badge>as {browser.identity}</Badge> : null}
          {browser.takenOver ? <Badge tone="amber">You have it</Badge> : null}
          {browser.viewers > 0 ? <Badge>{browser.viewers} watching</Badge> : null}
        </p>
        <p className="truncate text-caption text-muted-foreground">
          {browser.title || browser.url || 'No page'} · opened <RelativeTime iso={browser.openedAt} />
        </p>
      </div>
      {browser.kind === 'reader' ? null : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={
            browser.kind === 'task'
              ? `Close task #${browser.taskNumber ?? ''}’s browser`
              : `Close ${browser.identity ?? ''}’s sign-in`
          }
          disabled={pending || (browser.kind === 'sign-in' && !identity)}
          onClick={close}
        >
          {pending ? <Spinner /> : <X aria-hidden />}
          Close
        </Button>
      )}
    </li>
  );
}

/** Makes an empty identity: you sign it in next. */
function NewIdentityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateIdentity();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setError(null);
    setFailure(null);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!BrowserIdentityNameSchema.safeParse(name.trim()).success) {
      setError('Lowercase letters, digits and dashes, up to 40.');
      return;
    }
    setError(null);
    setFailure(null);
    try {
      const created = await create.mutateAsync({ name: name.trim(), description: description.trim() });
      toast.success(`${created.name} made`, 'Sign it in to the sites its agents need.');
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ProblemError && caught.status === 409)
        setError('There’s an identity with this name.');
      else setFailure(errorMessage(caught));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New identity"
      description="A browser profile of its own. Name it after who it signs in as, like “work-google”."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-identity" variant="primary" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : null}
            Make identity
          </Button>
        </>
      }
    >
      <form id="new-identity" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        <Field label="Name" error={error ?? undefined} hint="Lowercase letters, digits and dashes.">
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={40}
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setName(event.target.value.toLowerCase())}
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
