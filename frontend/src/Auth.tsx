// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, invalidateRequests } from './api';
import type { AuthLoss, AuthSession, User } from './api';
import { dismissAll } from './Toast';

type Phase = 'restoring' | 'ready' | 'anonymous' | 'unavailable' | 'signingOut' | 'logoutUncertain';
type AuthState = { phase: Phase; session: AuthSession | null; message: string; signedOut?: boolean };
type AuthValue = AuthState & {
  check: (refresh?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => void;
  deleteAccount: () => Promise<void>;
  deleting: boolean;
};
const AuthContext = createContext<AuthValue | null>(null);
const initialState: AuthState = { phase: 'restoring', session: null, message: '' };
// Visible sessions revalidate at most five minutes apart, and sooner near cookie expiry.
const refreshInterval = 5 * 60 * 1000;

/** Own authentication state, account actions, and cross-tab sign-in updates. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);
  const current = useRef(state);
  const generation = useRef(0);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const deletion = useRef<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** Apply authentication state and discard private UI data when identity changes. */
  const commit = useCallback((value: AuthState) => {
    if (!mounted.current) return;
    if (current.current.session?.user.id !== value.session?.user.id) {
      invalidateRequests();
      dismissAll();
    }
    current.current = value;
    setState(value);
  }, []);

  /** Verify the current sign-in and reconcile authentication or connection failures. */
  const check = useCallback(async (refresh = false) => {
    if (request.current || deletion.current || current.current.phase === 'signingOut') return;
    const controller = new AbortController();
    request.current = controller;
    const version = ++generation.current;
    const uncertain = current.current.phase === 'logoutUncertain';
    try {
      const session = await (refresh ? api.auth.refresh(controller.signal) : api.auth.session(controller.signal));
      if (!controller.signal.aborted && version === generation.current) commit({ phase: 'ready', session,
        message: uncertain ? 'Sign-out was not completed. You’re still signed in.' : '' });
    } catch (error) {
      if (controller.signal.aborted || version !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) {
        commit({ phase: 'anonymous', session: null, message: uncertain ? 'You’re signed out.'
          : error.body.code === 'sessionExpired' ? 'Your sign-in has expired. Sign in again to continue.'
            : current.current.phase === 'unavailable' ? 'Please sign in again to continue.'
              : current.current.message || (current.current.session ? 'Please sign in again to continue.' : '') });
        if (uncertain) channel.current?.postMessage('logout');
      } else commit({ phase: uncertain ? 'logoutUncertain' : 'unavailable', session: null,
        message: uncertain ? 'We couldn’t confirm you’re signed out. Your figures are hidden for now.'
          : 'We’ve lost the connection for a moment. Retry to see your figures.' });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [commit]);

  /** Clear the local sign-in and invalidate pending authentication checks. */
  const clear = useCallback((phase: Phase, message: string, signedOut = false) => {
    generation.current++;
    request.current?.abort(); request.current = null;
    commit({ phase, session: null, message, signedOut });
  }, [commit]);

  /** Sign out while keeping private data hidden if server confirmation fails. */
  const logout = useCallback(async () => {
    if (current.current.phase === 'signingOut') return;
    clear('signingOut', 'Signing out…');
    const version = generation.current;
    try {
      await api.auth.logout();
      if (!mounted.current || version !== generation.current) return;
      commit({ phase: 'anonymous', session: null, message: 'You’re signed out.' });
      channel.current?.postMessage('logout');
    } catch {
      if (mounted.current && version === generation.current) commit({ phase: 'logoutUncertain', session: null,
        message: 'We couldn’t confirm you’re signed out. Your figures are hidden for now.' });
    }
  }, [clear, commit]);

  /** Apply a saved profile for the active account and notify other tabs. */
  const updateUser = useCallback((user: User) => {
    if (deletion.current || current.current.phase !== 'ready' || current.current.session?.user.id !== user.id) return;
    // An in-flight auth refresh may contain the pre-save profile and must not overwrite this result.
    generation.current++;
    request.current?.abort(); request.current = null;
    commit({ ...current.current, session: { ...current.current.session, user } });
    channel.current?.postMessage('profile');
  }, [commit]);

  /** Delete the active app account and coordinate its signed-out state across tabs. */
  const deleteAccount = useCallback(async () => {
    const user = current.current.session?.user.id;
    if (!user || deletion.current) return;
    deletion.current = user;
    generation.current++;
    request.current?.abort(); request.current = null;
    setDeleting(true);
    try {
      const result = await api.account.delete('DELETE');
      if (!result.deleted) throw new Error('Account deletion was not confirmed.');
      if (!mounted.current || current.current.session && current.current.session.user.id !== user) return;
      clear('anonymous', '', true);
      channel.current?.postMessage({ type: 'delete', userId: user });
    } catch (error) {
      if (mounted.current && error instanceof ApiError && error.status === 401
        && (!current.current.session || current.current.session.user.id === user)) clear('anonymous', '', true);
      throw error;
    } finally {
      deletion.current = null;
      if (mounted.current) setDeleting(false);
    }
  }, [clear]);

  useEffect(() => {
    mounted.current = true;
    void check();
    /** Reconcile authentication loss without reviving a deleted or signing-out account. */
    const loss = (event: Event) => {
      const code = (event as CustomEvent<AuthLoss>).detail;
      if (code === 'accountDeleted') { clear('anonymous', '', true); return; }
      if (deletion.current || current.current.signedOut) return;
      if (['signingOut', 'logoutUncertain'].includes(current.current.phase)) return;
      clear('restoring', code === 'sessionExpired' ? 'Your sign-in has expired. Sign in again to continue.'
        : code === 'authUnavailable' ? '' : 'Please sign in again to continue.');
      void check();
    };
    const focus = () => {
      if (!document.hidden && current.current.phase === 'ready') void check(true);
    };
    /** Revalidate sign-in when the browser restores a cached page. */
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted || deletion.current || ['signingOut', 'logoutUncertain'].includes(current.current.phase)) return;
      if (current.current.signedOut) return;
      clear('restoring', '');
      void check();
    };
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('cashflow-auth');
      channel.current.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data && typeof event.data === 'object' && 'type' in event.data && event.data.type === 'delete'
          && 'userId' in event.data && (event.data.userId === current.current.session?.user.id || event.data.userId === deletion.current)) {
          clear('anonymous', '', true); return;
        }
        if (deletion.current || current.current.signedOut) return;
        if (['signingOut', 'logoutUncertain'].includes(current.current.phase)) return;
        if (event.data === 'logout') {
          // A tab signal hides cached data but only the server can establish authentication.
          clear('restoring', 'Please sign in again to continue.');
          void check();
        } else if (event.data === 'profile') void check();
      };
    }
    window.addEventListener('auth:loss', loss);
    window.addEventListener('focus', focus);
    window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', focus);
    return () => {
      mounted.current = false;
      clear('restoring', '');
      channel.current?.close(); channel.current = null;
      window.removeEventListener('auth:loss', loss);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [check, clear]);

  useEffect(() => {
    if (state.phase !== 'ready' || !state.session) return;
    const delay = Math.min(refreshInterval, Math.max(1000, Date.parse(state.session.expiresAt) - Date.now() - 30000));
    const timer = setTimeout(() => { if (!document.hidden) void check(true); }, delay);
    return () => clearTimeout(timer);
  }, [state, check]);

  return <AuthContext.Provider value={{ ...state, check, logout, updateUser, deleteAccount, deleting }}>{children}</AuthContext.Provider>;
}

/** Access authentication state and actions within the authentication provider. */
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Authentication provider is required.');
  return value;
}