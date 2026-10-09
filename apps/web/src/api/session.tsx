import { api, apiVoid, onUnauthorized, ProblemError, setApiToken } from '@superagent/client';
import { CreatedTokenSchema, type Me, MeSchema } from '@superagent/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { storage } from '../lib/storage';

export const TOKEN_KEY = 'superagent.token';

/** The admin token's id in `/v1/me`: it can mint tokens, so the app swaps it for a device token (D45). */
const ADMIN_TOKEN_ID = 'admin';

export type SessionState =
  | { status: 'checking' }
  | { status: 'signed-out'; reason?: 'revoked' | 'signed-out' }
  | { status: 'signed-in'; me: Me; token: string; persisted: boolean }
  | { status: 'unreachable' };

interface SessionValue {
  state: SessionState;
  /** Checks a pasted token and keeps a device token for this browser. */
  signIn(token: string): Promise<void>;
  /** Revokes this browser's token and forgets it. */
  signOut(): Promise<void>;
  /** After `unreachable`: check the stored token again. */
  retry(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() outside <SessionProvider>');
  return value;
}

/** The signed-in owner. Only for pages behind the sign-in gate. */
export function useMe(): Me {
  const { state } = useSession();
  if (state.status !== 'signed-in') throw new Error('useMe() on a page that does not require sign-in');
  return state.me;
}

/** "Web: Chrome on Windows": how this browser's token appears in the devices list. */
export function deviceName(userAgent: string = navigator.userAgent): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'a browser';
  const os = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'an unknown system';
  return `Web: ${browser} on ${os}`;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: 'checking' });

  /**
   * Back to signed out. The stored token goes only if it is still `token`: another tab may have signed
   * in since and stored its own, which this tab must not take with it.
   */
  const forget = useCallback(
    (reason: 'revoked' | 'signed-out', token: string | null) => {
      if (token === null || storage.get(TOKEN_KEY) === token) storage.remove(TOKEN_KEY);
      setApiToken(null);
      queryClient.clear();
      setState({ status: 'signed-out', reason });
    },
    [queryClient],
  );

  const check = useCallback(async () => {
    const stored = storage.get(TOKEN_KEY);
    if (!stored) {
      setState({ status: 'signed-out' });
      return;
    }
    setState({ status: 'checking' });
    try {
      const me = await api(MeSchema, '/v1/me', { token: stored });
      setApiToken(stored);
      setState({ status: 'signed-in', me, token: stored, persisted: true });
    } catch (error) {
      if (error instanceof ProblemError && (error.status === 401 || error.status === 403)) {
        forget('revoked', stored);
      } else setState({ status: 'unreachable' });
    }
  }, [forget]);

  useEffect(() => {
    void check();
  }, [check]);

  // A request refused mid-session (token revoked from another device): back to sign-in.
  useEffect(() => {
    onUnauthorized((token) => forget('revoked', token));
    return () => onUnauthorized(null);
  }, [forget]);

  const signIn = useCallback(
    async (raw: string) => {
      const token = raw.trim();
      const me = await api(MeSchema, '/v1/me', { token });
      let kept = token;
      let keptMe = me;
      if (me.token.id === ADMIN_TOKEN_ID) {
        const created = await api(CreatedTokenSchema, '/v1/tokens', {
          method: 'POST',
          json: { name: deviceName() },
          token,
        });
        kept = created.token;
        // From the answer itself: another request could fail and leave the new token valid but unheld.
        keptMe = { ...me, token: { id: created.record.id, name: created.record.name } };
      }
      const persisted = storage.set(TOKEN_KEY, kept);
      setApiToken(kept);
      queryClient.clear();
      setState({ status: 'signed-in', me: keptMe, token: kept, persisted });
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    if (state.status !== 'signed-in') return;
    if (state.me.token.id !== ADMIN_TOKEN_ID) {
      try {
        await apiVoid(`/v1/tokens/${encodeURIComponent(state.me.token.id)}`, { method: 'DELETE' });
      } catch {
        // Signed out here either way; the token can still be revoked from another device.
      }
    }
    forget('signed-out', state.token);
  }, [state, forget]);

  const value = useMemo<SessionValue>(
    () => ({ state, signIn, signOut, retry: () => void check() }),
    [state, signIn, signOut, check],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}
