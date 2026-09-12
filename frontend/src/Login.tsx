// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from './Auth';
import { api, ApiError, authEpoch } from './api';
import type { AuthSettings, ReturnPath } from './api';
import { dismiss, notify } from './Toast';
import { Recovery } from './Recovery';
import { isMoneyRoute } from './moneyRoutes';
import { isHistoryRoute } from './historyRoutes';

export function returnPath(value: string | null | undefined): ReturnPath {
  return value && (isMoneyRoute(value) || isHistoryRoute(value)) ? value : value === '/account' ? value : '/app';
}

export function GoogleSignIn({ returnTo, onBegin }: { returnTo: ReturnPath; onBegin?: () => void }) {
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [error, setError] = useState<{ message: string; source: 'settings' | 'start' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const controls = useRef<HTMLDivElement>(null);
  const recoverFocus = useRef(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api.auth.settings(controller.signal).then(value => {
      if (!controller.signal.aborted) { setSettings(value); setError(null); }
    }).catch(() => { if (!controller.signal.aborted) setError({ message: 'We can’t reach sign-in right now. Please try again.', source: 'settings' }); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => { mounted.current = false; controller.abort(); dismiss('login:error'); };
  }, [attempt]);

  useEffect(() => {
    if (!recoverFocus.current || busy || checking) return;
    if (document.activeElement === document.body || controls.current?.contains(document.activeElement))
      controls.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    recoverFocus.current = false;
  }, [error, settings, busy, checking]);

  async function signIn() {
    if (!mounted.current || pending.current || !settings?.googleAvailable) return;
    recoverFocus.current = controls.current?.contains(document.activeElement) ?? false;
    pending.current = true;
    const epoch = authEpoch();
    setBusy(true); dismiss('login:error'); onBegin?.();
    try {
      const { url } = await api.auth.login(returnTo);
      if (!mounted.current || authEpoch() !== epoch) return;
      const target = new URL(url, window.location.origin);
      const google = target.origin === 'https://accounts.google.com';
      const callback = target.origin === window.location.origin && target.pathname === '/auth/callback';
      if ((!google && !callback) || target.username || target.password) throw new Error('Invalid sign-in destination');
      setError(null);
      window.location.assign(url);
    } catch (reason) {
      if (mounted.current && authEpoch() === epoch) setError({ source: 'start', message: reason instanceof ApiError && reason.status === 429
        ? 'Sign-in is busy. Wait a moment, then try again.'
        : reason instanceof ApiError && reason.status === 503 ? 'Sign-in is temporarily unavailable. Please try again shortly.'
          : 'Sign-in couldn’t start. Check your connection and try again.' });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <div className="google-signin" ref={controls}>
    {error ? <Recovery inline title={error.source === 'settings' ? 'Let’s get you connected.' : 'Let’s try signing in again.'}
      message={error.message} busy={busy || checking}>
      <button className="primary" disabled={busy || checking} onClick={() => {
        if (error.source === 'start') { void signIn(); return; }
        recoverFocus.current = true;
        setChecking(true); setAttempt(value => value + 1);
      }}>{busy || checking ? 'Trying again…' : error.source === 'settings' ? 'Retry connection' : 'Retry sign in'}</button>
    </Recovery> : <>
    {settings?.googleAvailable === false && <p className="hint">Sign-in is not available yet. Please try again later.</p>}
    {!settings && <p role="status">Getting sign-in ready…</p>}
    <button className="primary" disabled={!settings?.googleAvailable || busy} onClick={() => void signIn()}>
      {busy ? 'Opening Google…' : 'Continue with Google'}
    </button>
    {settings?.googleAvailable === false && <button disabled={checking} onClick={() => { setChecking(true); setAttempt(value => value + 1); }}>{checking ? 'Checking…' : 'Check again'}</button>}
    </>}
  </div>;
}

const failures: Record<string, string> = {
  cancelled: 'Sign-in was cancelled. You can try again when you’re ready.',
  failed: 'Sign-in wasn’t completed. Please try again.',
  expired: 'That sign-in link has expired. Please start again.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
};

export function Login() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const signin = useRef<HTMLElement>(null);
  const params = new URLSearchParams(location.search);
  const returnTo = returnPath(params.get('returnTo'));
  const code = params.get('error') ?? '';
  const failure = failures[code];
  useEffect(() => {
    if (!failure) return;
    let current = true;
    notify({ id: 'login:error', title: code === 'cancelled' ? 'Sign-in cancelled' : 'Sign-in not completed',
      message: failure, severity: code === 'cancelled' ? 'info' : 'error', duration: code === 'cancelled' ? 6000 : null,
      action: code === 'cancelled' ? undefined : { label: 'Continue', onClick: () => {
        if (current) signin.current?.querySelector<HTMLButtonElement>('.google-signin .primary')?.focus();
      } } });
    return () => { current = false; dismiss('login:error'); };
  }, [failure, code, location.search]);

  return <main id="main" className="access-page">
    <section className="access-copy"><p className="eyebrow">Your next 30 days</p>
      <h1>A clearer plan starts here.</h1><p>Talk through your money and bills, see what’s coming, and decide what to do next.</p>
      <p className="hint">No bank connection. No payments made.</p>
    </section>
    <section ref={signin} className="card signin-card" aria-labelledby="signin-heading">
      <h2 id="signin-heading">Sign in to Cash flow</h2>
      <p>Keep your figures private and return to your saved plan.</p>
      {auth.phase === 'ready' && <Link className="button" to={returnTo}>Continue to your plan</Link>}
      <GoogleSignIn returnTo={returnTo} onBegin={() => {
        if (location.search && auth.phase !== 'ready') void navigate(`/login${returnTo === '/app' ? '' : `?returnTo=${returnTo}`}`, { replace: true });
      }} />
      <p className="hint">Google confirms who you are. Your microphone stays off until you choose to start talking.</p>
    </section>
  </main>;
}