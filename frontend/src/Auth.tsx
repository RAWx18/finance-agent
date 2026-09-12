// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, invalidateRequests } from './api';
import type { AuthLoss, AuthSession, User } from './api';
import { dismissAll } from './Toast';

type Phase = 'restoring' | 'ready' | 'anonymous' | 'unavailable' | 'signingOut' | 'logoutUncertain';
type AuthState = { phase: Phase; session: AuthSession | null; message: string };
type AuthValue = AuthState & {
  check: (refresh?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => void;
  deleted: () => void;
};
const AuthContext = createContext<AuthValue | null>(null);
const initialState: AuthState = { phase: 'restoring', session: null, message: '' };
// Visible sessions revalidate at most five minutes apart, and sooner near cookie expiry.
const refreshInterval = 5 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);
  const current = useRef(state);
  const generation = useRef(0);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  const commit = useCallback((value: AuthState) => {
    if (!mounted.current) return;
    if (current.current.session?.user.id !== value.session?.user.id) {
      invalidateRequests();
      dismissAll();
    }
    current.current = value;
    setState(value);
  }, []);

  const check = useCallback(async (refresh = false) => {
    if (request.current || current.current.phase === 'signingOut') return;
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

  const clear = useCallback((phase: Phase, message: string) => {
    generation.current++;
    request.current?.abort(); request.current = null;
    commit({ phase, session: null, message });
  }, [commit]);

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

  const updateUser = useCallback((user: User) => {
    if (current.current.phase !== 'ready' || current.current.session?.user.id !== user.id) return;
    generation.current++;
    request.current?.abort(); request.current = null;
    commit({ ...current.current, session: { ...current.current.session, user } });
    channel.current?.postMessage('profile');
  }, [commit]);

  const deleted = useCallback(() => {
    clear('anonymous', 'Your app account and its saved figures have been deleted. Your Google account is unchanged.');
    channel.current?.postMessage('delete');
  }, [clear]);

  useEffect(() => {
    mounted.current = true;
    void check();
    const loss = (event: Event) => {
      if (['signingOut', 'logoutUncertain'].includes(current.current.phase)) return;
      const code = (event as CustomEvent<AuthLoss>).detail;
      clear('restoring', code === 'sessionExpired' ? 'Your sign-in has expired. Sign in again to continue.'
        : code === 'authUnavailable' ? '' : 'Please sign in again to continue.');
      void check();
    };
    const focus = () => {
      if (!document.hidden && current.current.phase === 'ready') void check(true);
    };
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted || ['signingOut', 'logoutUncertain'].includes(current.current.phase)) return;
      clear('restoring', '');
      void check();
    };
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('cashflow-auth');
      channel.current.onmessage = (event: MessageEvent<unknown>) => {
        if (['signingOut', 'logoutUncertain'].includes(current.current.phase)) return;
        if (event.data === 'logout' || event.data === 'delete') {
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

  return <AuthContext.Provider value={{ ...state, check, logout, updateUser, deleted }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Authentication provider is required.');
  return value;
}