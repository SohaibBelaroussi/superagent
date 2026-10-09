import { errorMessage } from '@superagent/client';
import type { TokenRecord } from '@superagent/shared';
import { Copy, MonitorSmartphone, Plus, Smartphone } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useMe } from '../../api/session';
import { useCreateToken, useRevokeToken, useTokens } from '../../api/settings';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog, Dialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton, Spinner } from '../../ui/feedback';
import { Field, Input } from '../../ui/field';
import { Page, PageHeader, Panel } from '../../ui/layout';
import { raisedSurface } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';
import { AdminTokenForm, refusal } from './admin-token-form';
import { PairPhoneDialog } from './pair-phone-dialog';

/**
 * The tokens browsers and apps sign in with. Managing them takes the admin token: asked for here and
 * kept in this page's memory only (D45), so leaving or reloading forgets it.
 */
export function DevicesPage() {
  useDocumentTitle('Devices');
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const giveToken = (token: string | null) => {
    setAdminToken(token);
    setAttempt((count) => count + 1);
  };
  const [pairing, setPairing] = useState(false);
  // While a phone pairs, look for its token every couple of seconds.
  const tokens = useTokens(adminToken, attempt, pairing ? 2_000 : undefined);
  const refused = refusal(tokens.error, 'Managing devices');
  const [creating, setCreating] = useState(false);

  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Devices"
          description="Each browser or app signed in to superagent has its own token. Revoke one to sign it out."
          actions={
            adminToken && !refused ? (
              <>
                <Button variant="ghost" onClick={() => giveToken(null)}>
                  Forget the admin token
                </Button>
                <Button onClick={() => setCreating(true)}>
                  <Plus aria-hidden />
                  New device token
                </Button>
                {/* Not before the list is in: the dialog spots the phone as the token that wasn't there. */}
                <Button variant="primary" disabled={!tokens.data} onClick={() => setPairing(true)}>
                  <Smartphone aria-hidden />
                  Pair a phone
                </Button>
              </>
            ) : undefined
          }
        />
      }
    >
      {!adminToken || refused ? (
        <AdminTokenForm
          refused={refused}
          onToken={giveToken}
          purpose="to manage devices"
          submitLabel="Show devices"
        />
      ) : tokens.isError ? (
        <Notice tone="destructive" title="Couldn’t load the devices">
          {errorMessage(tokens.error)}
        </Notice>
      ) : tokens.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <TokenList tokens={tokens.data} adminToken={adminToken} />
      )}
      <NewTokenDialog open={creating} onOpenChange={setCreating} adminToken={adminToken} />
      <PairPhoneDialog
        open={pairing}
        onOpenChange={setPairing}
        adminToken={adminToken}
        tokens={tokens.data}
      />
    </Page>
  );
}

function TokenList({ tokens, adminToken }: { tokens: TokenRecord[]; adminToken: string }) {
  const me = useMe();
  const revoke = useRevokeToken(adminToken);
  const [revoking, setRevoking] = useState<TokenRecord | null>(null);
  const active = tokens.filter((token) => !token.revokedAt);
  const revoked = tokens.filter((token) => token.revokedAt);

  if (tokens.length === 0) {
    return (
      <Panel>
        <EmptyState compact icon={<MonitorSmartphone />} title="No device tokens yet" />
      </Panel>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <ul className={cn('divide-y divide-border rounded-xl', raisedSurface)} aria-label="Devices">
        {active.map((token) => (
          <li key={token.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="flex items-center gap-2 text-label text-foreground">
                {token.name}
                {token.id === me.token.id ? (
                  <Badge tone="blue" dot>
                    This browser
                  </Badge>
                ) : null}
              </p>
              <p className="flex flex-wrap gap-x-1.5 text-caption text-muted-foreground">
                <span className="font-mono">{token.prefix}…</span>
                <span aria-hidden>·</span>
                <span>
                  Added <RelativeTime iso={token.createdAt} />
                </span>
                <span aria-hidden>·</span>
                <span>
                  {token.lastUsedAt ? (
                    <>
                      Last used <RelativeTime iso={token.lastUsedAt} />
                    </>
                  ) : (
                    'Never used'
                  )}
                </span>
              </p>
            </div>
            <Button
              size="sm"
              variant="destructive-ghost"
              aria-label={`Revoke ${token.name}`}
              onClick={() => setRevoking(token)}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      {revoked.length > 0 ? (
        <section aria-label="Revoked" className="flex flex-col gap-1.5">
          <h2 className="text-label text-muted-foreground">Revoked</h2>
          <ul className="flex flex-col">
            {revoked.map((token) => (
              <li
                key={token.id}
                className="flex items-center gap-2 px-1 py-1 text-body-sm text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{token.name}</span>
                <span className="text-caption">
                  Revoked <RelativeTime iso={token.revokedAt ?? token.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description={
          revoking?.id === me.token.id
            ? 'It’s this browser’s token: this browser signs out.'
            : 'Wherever it’s signed in signs out, and it can’t be used again.'
        }
        confirmLabel="Revoke"
        destructive
        busy={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast.success(`“${revoking.name}” revoked`);
              setRevoking(null);
            },
            onError: () => setRevoking(null),
          });
        }}
      />
    </div>
  );
}

/** Makes a token for another browser or app, shown once to copy there. */
function NewTokenDialog({
  open,
  onOpenChange,
  adminToken,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminToken: string | null;
}) {
  const create = useCreateToken(adminToken);
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const outputId = useId();

  const close = (next: boolean) => {
    // A token being made would be lost: it is shown once, here.
    if (!next && create.isPending) return;
    onOpenChange(next);
    if (!next) {
      setName('');
      setToken(null);
      create.reset();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate(name.trim(), { onSuccess: (created) => setToken(created.token) });
  };
  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast.success('Copied');
    } catch {
      toast.error('Couldn’t copy', 'Select it and copy it by hand.');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={token ? 'Copy it now' : 'New device token'}
      description={
        token
          ? 'Paste it where you sign in on that device. It isn’t shown again.'
          : 'For a browser or app you’ll sign in with. Name it after the device.'
      }
      footer={
        token ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={create.isPending} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="new-token"
              variant="primary"
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? <Spinner /> : null}
              Create token
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="flex flex-col gap-2 pb-2">
          <label htmlFor={outputId} className="text-label text-foreground">
            Its token
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={outputId}
              readOnly
              value={token}
              className="font-mono"
              onFocus={(event) => event.target.select()}
            />
            <Button onClick={() => void copy()}>
              <Copy aria-hidden />
              Copy
            </Button>
          </div>
        </div>
      ) : (
        <form id="new-token" onSubmit={submit} className="pb-1" noValidate>
          <Field label="Device" hint="Like “phone” or “work laptop”.">
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
        </form>
      )}
    </Dialog>
  );
}
