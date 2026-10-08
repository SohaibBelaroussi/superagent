import { ChevronLeft, LogIn } from 'lucide-react';
import { useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useBrowserIdentity, useCloseSignIn, useOpenSignIn } from '../../api/browsers';
import { errorMessage, ProblemError } from '../../api/client';
import { useDocumentTitle } from '../../lib/title';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton, Spinner } from '../../ui/feedback';
import { Page, PageHeader } from '../../ui/layout';
import { toast } from '../../ui/toast';
import { LiveView } from '../browsers/live-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Signing an identity in: its browser, yours to use, until Done saves what you signed in to (its
 * cookies). Left open, it closes by itself after a while unused, and saves them then too.
 */
export function IdentitySignInPage() {
  const { identityId = '' } = useParams<{ identityId: string }>();
  const valid = UUID.test(identityId);
  const identity = useBrowserIdentity(valid ? identityId : '');
  const open = useOpenSignIn();
  const close = useCloseSignIn();
  const navigate = useNavigate();
  const name = identity.data?.name;
  useDocumentTitle(name ? `Sign in as ${name}` : 'Sign in');
  const { refetch } = identity;
  // Its browser opened or closed meanwhile: who holds the identity changed.
  const onStatus = useCallback(() => void refetch(), [refetch]);

  const back = (
    <Link to="/settings/browsers" className="flex items-center gap-1 hover:text-foreground">
      <ChevronLeft aria-hidden className="size-3.5" />
      Browsers
    </Link>
  );

  if (
    !valid ||
    (identity.isError && identity.error instanceof ProblemError && identity.error.status === 404)
  ) {
    return (
      <Page header={<PageHeader eyebrow={back} title="No such identity" />}>
        <EmptyState
          title="No such identity"
          description="It may have been deleted, or the link mistyped."
          action={
            <Link to="/settings/browsers" className="text-label text-foreground underline underline-offset-4">
              Back to the browsers
            </Link>
          }
        />
      </Page>
    );
  }
  if (identity.isError) {
    return (
      <Page header={<PageHeader eyebrow={back} title="Sign in" />}>
        <Notice
          tone="destructive"
          title="Couldn’t load the identity"
          action={
            <Button size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(identity.error)}
        </Notice>
      </Page>
    );
  }
  if (identity.isPending) {
    return (
      <Page header={<PageHeader eyebrow={back} title="Sign in" />}>
        <Skeleton className="h-96 rounded-xl" />
      </Page>
    );
  }

  const signingIn = identity.data.holder?.kind === 'owner';
  const done = () =>
    close.mutate(identity.data.id, {
      onSuccess: () => {
        toast.success('Sign-ins saved', `Agents given ${identity.data.name} browse signed in.`);
        navigate('/settings/browsers');
      },
    });

  return (
    <Page
      width="medium"
      header={
        <PageHeader
          eyebrow={back}
          title={`Sign in as ${identity.data.name}`}
          description="Sign in to the sites its agents will use, as in your own browser. Done saves the sign-ins to the identity."
          actions={
            signingIn ? (
              <Button variant="primary" disabled={close.isPending} onClick={done}>
                {close.isPending ? <Spinner /> : null}
                Done
              </Button>
            ) : null
          }
        />
      }
    >
      {signingIn ? (
        <LiveView
          path={`/v1/browser-identities/${encodeURIComponent(identity.data.id)}/stream`}
          kind="sign-in"
          label={`${identity.data.name}’s browser`}
          waiting={{
            title: 'Its browser is opening',
            description: 'It shows here in a moment.',
          }}
          onStatus={onStatus}
        />
      ) : (
        <EmptyState
          icon={<LogIn />}
          title="Its browser isn’t open"
          description={
            identity.data.holder?.kind === 'task'
              ? `Task #${identity.data.holder.taskNumber ?? ''} is using it. Try again once it’s done.`
              : 'Open it to sign in to sites as this identity.'
          }
          action={
            identity.data.holder ? null : (
              <Button
                variant="primary"
                disabled={open.isPending}
                onClick={() => open.mutate(identity.data.id, { onSuccess: () => void refetch() })}
              >
                {open.isPending ? <Spinner /> : <LogIn aria-hidden />}
                Open its browser
              </Button>
            )
          }
        />
      )}
    </Page>
  );
}
