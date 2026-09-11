// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, ApiError, authEpoch } from './api';
import type { AuthSettings, ReturnPath } from './api';
import { dismiss, notify } from './Toast';

export function returnPath(value: string | null | undefined): ReturnPath {
  return value === '/figures' || value === '/account' ? value : '/app';
}

export function GoogleSignIn({ returnTo, onBegin }: { returnTo: ReturnPath; onBegin?: () => void }) {
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [error, setError] = useState<{ message: string; source: 'settings' | 'start' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const start = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => { start.current = signIn; });
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api.auth.settings(controller.signal).then(value => {
      if (!controller.signal.aborted) { setSettings(value); setError(null); }
    }).catch(() => { if (!controller.signal.aborted) setError({ message: 'Sign-in could not be checked. Please try again.', source: 'settings' }); });
    return () => { mounted.current = false; controller.abort(); dismiss('login:error'); };
  }, [attempt]);

  useEffect(() => {
    if (!error) return;
    let current = true;
    const epoch = authEpoch();
    notify({ id: 'login:error', title: error.source === 'settings' ? 'Could not check sign-in' : 'Could not start sign-in',
      message: error.message, severity: 'error', duration: null,
      action: { label: error.source === 'settings' ? 'Check again' : 'Retry', disabled: busy, onClick: () => {
        if (!current || !mounted.current || epoch !== authEpoch() || pending.current) return;
        current = false;
        if (error.source === 'start') return start.current?.();
        setError(null); setAttempt(value => value + 1);
      } } });
    return () => { current = false; dismiss('login:error'); };
  }, [error, busy]);

  async function signIn() {
    if (!mounted.current || pending.current || !settings?.googleAvailable) return;
    pending.current = true;
    const epoch = authEpoch();
    setBusy(true); setError(null); dismiss('login:error'); onBegin?.();
    try {
      const { url } = await api.auth.login(returnTo);
      if (!mounted.current || authEpoch() !== epoch) return;
      const target = new URL(url, window.location.origin);
      const google = target.origin === 'https://accounts.google.com';
      const callback = target.origin === window.location.origin && target.pathname === '/auth/callback';
      if ((!google && !callback) || target.username || target.password) throw new Error('Invalid sign-in destination');
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

  return <div className="google-signin">
    {settings?.googleAvailable === false && <p className="hint">Sign-in is not available yet. Please try again later.</p>}
    {!settings && !error && <p role="status">Checking sign-in availability…</p>}
    <button className="primary" disabled={!settings?.googleAvailable || busy} onClick={() => void signIn()}>
      {busy ? 'Opening Google…' : 'Continue with Google'}
    </button>
    {settings?.googleAvailable === false && !error && <button onClick={() => { setError(null); setAttempt(value => value + 1); }}>Check again</button>}
  </div>;
}

const failures: Record<string, string> = {
  cancelled: 'Sign-in was cancelled. You can try again when you’re ready.',
  failed: 'Sign-in wasn’t completed. Please try again.',
  expired: 'That sign-in link has expired. Please start again.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
};

export function Login() {
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
      <GoogleSignIn returnTo={returnTo} onBegin={() => {
        if (location.search) void navigate(`/login${returnTo === '/app' ? '' : `?returnTo=${returnTo}`}`, { replace: true });
      }} />
      <p className="hint">Google confirms who you are. Your microphone stays off until you choose to start talking.</p>
    </section>
  </main>;
}