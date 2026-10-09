import { errorMessage, PUSH_KINDS } from '@superagent/client';
import type { PushDevice, PushStatus } from '@superagent/shared';
import { BellRing, FileKey, Smartphone } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { useConfigurePush, usePushStatus, useRemovePush } from '../../api/settings';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Page, PageHeader, Panel } from '../../ui/layout';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';
import { AdminTokenForm, refusal } from './admin-token-form';

/**
 * Push notifications to phones (D54): the Firebase project they go through, and the phones that get
 * them. Each phone picks what it gets in its own settings. Takes the admin token, like Devices.
 */
export function NotificationsPage() {
  useDocumentTitle('Notifications');
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const giveToken = (token: string | null) => {
    setAdminToken(token);
    setAttempt((count) => count + 1);
  };
  const status = usePushStatus(adminToken, attempt);
  const refused = refusal(status.error, 'Setting up notifications');

  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Notifications"
          description="Phones get what needs you as a notification, through your Firebase project. Only ciphertext passes through Google."
          actions={
            adminToken && !refused ? (
              <Button variant="ghost" onClick={() => giveToken(null)}>
                Forget the admin token
              </Button>
            ) : undefined
          }
        />
      }
    >
      {!adminToken || refused ? (
        <AdminTokenForm
          refused={refused}
          onToken={giveToken}
          purpose="to set up notifications"
          submitLabel="Show notifications"
        />
      ) : status.isError ? (
        <Notice tone="destructive" title="Couldn’t load the notifications">
          {errorMessage(status.error)}
        </Notice>
      ) : status.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <>
          <FirebasePanel status={status.data} adminToken={adminToken} />
          <DevicesPanel devices={status.data.devices} configured={status.data.configured} />
        </>
      )}
    </Page>
  );
}

function FirebasePanel({ status, adminToken }: { status: PushStatus; adminToken: string }) {
  const configure = useConfigurePush(adminToken);
  const remove = useRemovePush(adminToken);
  const [confirming, setConfirming] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const read = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    configure.mutate(await picked.text(), {
      onSuccess: (next) => toast.success('Notifications set up', `Project ${next.projectId}`),
    });
  };

  return (
    <Panel role="region" aria-label="Firebase project" className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-muted-foreground shadow-rim [&_svg]:size-4">
          <BellRing aria-hidden />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-subheading text-foreground">
            {status.configured ? `Firebase project ${status.projectId}` : 'Not set up'}
          </h2>
          <p className="text-body-sm break-words text-muted-foreground">
            {status.configured
              ? `Sent as ${status.clientEmail}. The key is sealed on the server and never shown again.`
              : 'Create a Firebase project (it’s free), then a service account key for it, and choose the key file here. The runbook has the steps.'}
          </p>
        </div>
      </div>
      {configure.isError ? (
        <Notice tone="destructive" title="That key file can’t be used">
          {errorMessage(configure.error)}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="Service account key file"
          onChange={(event) => void read(event)}
        />
        <Button
          variant={status.configured ? 'default' : 'primary'}
          disabled={configure.isPending}
          onClick={() => file.current?.click()}
        >
          <FileKey aria-hidden />
          {configure.isPending
            ? 'Checking the key…'
            : status.configured
              ? 'Replace the key file'
              : 'Choose the key file'}
        </Button>
        {status.configured ? (
          <Button variant="destructive-ghost" onClick={() => setConfirming(true)}>
            Stop notifications
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop notifications?"
        description="The key is forgotten and nothing is sent. Phones stay registered for when it’s back."
        confirmLabel="Stop notifications"
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate(undefined, { onSuccess: () => setConfirming(false) })}
      />
    </Panel>
  );
}

function DevicesPanel({ devices, configured }: { devices: PushDevice[]; configured: boolean }) {
  if (devices.length === 0) {
    return (
      <Panel>
        <EmptyState
          compact
          icon={<Smartphone />}
          title="No phone gets notifications yet"
          description={
            configured
              ? 'Turn them on in the app’s settings, on each phone.'
              : 'Once the Firebase project is set, turn them on in the app’s settings.'
          }
        />
      </Panel>
    );
  }
  return (
    <Panel className="p-0">
      <ul aria-label="Phones that get notifications" className="divide-y divide-border">
        {devices.map((device) => (
          <li key={device.id} className="flex flex-col gap-1.5 px-5 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label text-foreground">{device.tokenName}</span>
              <span className="text-caption text-placeholder">
                {device.lastSentAt ? (
                  <>
                    Last sent <RelativeTime iso={device.lastSentAt} />
                  </>
                ) : (
                  'Nothing sent yet'
                )}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {device.kinds.length === 0 ? (
                <span className="text-caption text-muted-foreground">Nothing chosen</span>
              ) : (
                device.kinds.map((kind) => (
                  <Badge key={kind} tone="neutral">
                    {PUSH_KINDS[kind].label}
                  </Badge>
                ))
              )}
            </div>
            {device.lastError ? (
              <p className="text-caption break-words text-destructive-foreground">{device.lastError}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
