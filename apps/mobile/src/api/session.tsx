import { api, apiVoid, configureClient, onUnauthorized, ProblemError, setApiToken } from '@superagent/client';
import { CreatedTokenSchema, type Me, MeSchema } from '@superagent/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { deviceName, type PairingLink } from './pairing';
import { clearSession, loadSession, type StoredSession, saveSession } from './storage';

/** The admin token's id in `/v1/me`: it can mint tokens, so the app swaps it for a device token (D45). */
const ADMIN_TOKEN_ID = 'admin';

const NETWORK_ERROR = 'Can’t reach superagent. Is Tailscale on?';

export type SessionState =
  | { status: 'checking' }
  | { status: 'signed-out'; reason?: 'revoked' | 'signed-out' }
  | {
      status: 'signed-in';
      session: StoredSession;
      /** What the server said about this token, once it has answered since the app started. */
      me: Me | null;
      /** The keystore kept the session (else the app asks again when it next starts). */
      persisted: boolean;
    };

interface SessionValue {
  state: SessionState;
  /** Claims a device token with a pairing code from the web app (D53). */
  pair(link: PairingLink): Promise<void>;
  /** Signs in with a pasted token: an admin token is swapped for a device token. */
  signInWithToken(server: string, token: string): Promise<void>;
  /** Revokes this phone's token and forgets it. */
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() outside <SessionProvider>');
  return value;
}

/** The signed-in session. Only for screens behind the sign-in gate. */
export function useSignedIn(): Extract<SessionState, { status: 'signed-in' }> {
  const { state } = useSession();
  if (state.status !== 'signed-in')
    throw new Error('useSignedIn() on a screen that does not require sign-in');
  return state;
}

function connect(server: string, token: string | null): void {
  configureClient({ baseUrl: server, networkErrorDetail: NETWORK_ERROR });
  setApiToken(token);
}

/**
 * The phone's session: a device token for one server, kept in the keystore. A stored session counts
 * as signed in at once (the server may be out of reach: Tailscale off, no signal); the server's
 * answer then confirms it, or a refusal signs the app out.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: 'checking' });

  const forget = useCallback(
    async (reason: 'revoked' | 'signed-out') => {
      await clearSession();
      setApiToken(null);
      queryClient.clear();
      setState({ status: 'signed-out', reason });
    },
    [queryClient],
  );

  const keep = useCallback(
    async (session: StoredSession, me: Me | null) => {
      const persisted = await saveSession(session);
      connect(session.server, session.token);
      queryClient.clear();
      setState({ status: 'signed-in', session, me, persisted });
    },
    [queryClient],
  );

  // The stored session, checked with the server in the background.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (cancelled) return;
      if (!session) {
        setState({ status: 'signed-out' });
        return;
      }
      connect(session.server, session.token);
      setState({ status: 'signed-in', session, me: null, persisted: true });
      try {
        const me = await api(MeSchema, '/v1/me', { token: session.token });
        if (!cancelled) {
          setState((current) =>
            current.status === 'signed-in' && current.session.token === session.token
              ? { ...current, me }
              : current,
          );
        }
      } catch (error) {
        if (!cancelled && error instanceof ProblemError && (error.status === 401 || error.status === 403)) {
          await forget('revoked');
        }
        // Otherwise unreachable for now: the screens say so, and try again.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [forget]);

  // A request refused mid-session (the token was revoked from the web app): back to sign-in.
  useEffect(() => {
    onUnauthorized(() => void forget('revoked'));
    return () => onUnauthorized(null);
  }, [forget]);

  const pair = useCallback(
    async (link: PairingLink) => {
      connect(link.server, null);
      const created = await api(CreatedTokenSchema, '/v1/tokens/claim', {
        method: 'POST',
        json: { name: deviceName() },
        token: link.code,
      });
      await keep(
        {
          server: link.server,
          token: created.token,
          tokenId: created.record.id,
          tokenName: created.record.name,
        },
        null,
      );
    },
    [keep],
  );

  const signInWithToken = useCallback(
    async (server: string, raw: string) => {
      const token = raw.trim();
      connect(server, null);
      const me = await api(MeSchema, '/v1/me', { token });
      if (me.token.id === ADMIN_TOKEN_ID) {
        const created = await api(CreatedTokenSchema, '/v1/tokens', {
          method: 'POST',
          json: { name: deviceName() },
          token,
        });
        // From the answer itself: a later request could fail and leave the new token valid but unheld.
        await keep(
          { server, token: created.token, tokenId: created.record.id, tokenName: created.record.name },
          { ...me, token: { id: created.record.id, name: created.record.name } },
        );
        return;
      }
      await keep({ server, token, tokenId: me.token.id, tokenName: me.token.name }, me);
    },
    [keep],
  );

  const signOut = useCallback(async () => {
    if (state.status !== 'signed-in') return;
    try {
      await apiVoid(`/v1/tokens/${encodeURIComponent(state.session.tokenId)}`, { method: 'DELETE' });
    } catch {
      // Signed out here either way; the token can still be revoked from the web app.
    }
    await forget('signed-out');
  }, [state, forget]);

  const value = useMemo<SessionValue>(
    () => ({ state, pair, signInWithToken, signOut }),
    [state, pair, signInWithToken, signOut],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}
