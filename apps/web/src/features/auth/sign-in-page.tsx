import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ProblemError } from '../../api/client';
import { useSession } from '../../api/session';
import { Button } from '../../ui/button';
import { Notice, Spinner } from '../../ui/feedback';
import { Field, Input } from '../../ui/field';
import { LogoMark } from '../../ui/icons';
import { raisedSurface } from '../../ui/recipes';

interface LocationState {
  from?: string;
  reason?: 'revoked' | 'signed-out';
}

function failure(error: unknown): string {
  if (error instanceof ProblemError) {
    if (error.status === 401) return 'That token isn’t valid. Check that you copied all of it.';
    if (error.status === 0)
      return 'Can’t reach the server. Check that it’s running and that you’re on your tailnet.';
    return error.message;
  }
  return 'Signing in failed. Try again.';
}

/** Paste a token once: an admin token is swapped for a token for this browser, and isn't kept (D45). */
export function SignInPage() {
  const { state, signIn } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as LocationState | null)?.from;
  const reason = (location.state as LocationState | null)?.reason;
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'signed-in') return <Navigate to={from ?? '/'} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) {
      setError('Paste a token to sign in.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(token);
      setToken('');
      navigate(from && from !== '/sign-in' ? from : '/', { replace: true });
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-sidebar px-4 py-10">
      <div className="flex w-full max-w-[25rem] flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-card text-foreground shadow-raised">
            <LogoMark className="size-6" />
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-display text-foreground">Sign in to superagent</h1>
            <p className="text-body-sm text-muted-foreground">
              Your organization of agents, on your own server.
            </p>
          </div>
        </div>

        {reason === 'revoked' ? (
          <Notice tone="warning" title="You were signed out">
            This browser’s token was revoked or is no longer valid. Sign in again.
          </Notice>
        ) : null}

        <form onSubmit={submit} className={`flex flex-col gap-4 rounded-2xl p-5 ${raisedSurface}`} noValidate>
          <Field
            label="API token"
            error={error}
            hint="Your admin token, or a device token made for this browser."
          >
            {(control) => (
              <Input
                {...control}
                type="password"
                name="token"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                placeholder="sa_…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
            {busy ? <Spinner /> : <KeyRound aria-hidden />}
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="px-2 text-center text-caption text-muted-foreground">
          An admin token is exchanged for a token for this browser, which you can revoke on its own. The admin
          token itself is never stored.
        </p>
      </div>
    </div>
  );
}
