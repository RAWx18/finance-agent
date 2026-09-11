// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, ApiError, authEpoch } from './api';
import type { AuthSettings, ReturnPath } from './api';
import { useAuth } from './Auth';

export function returnPath(value: string | null | undefined): ReturnPath {
  return value === '/figures' || value === '/account' ? value : '/app';
}

export function GoogleSignIn({ returnTo, onBegin }: { returnTo: ReturnPath; onBegin?: () => void }) {
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api.auth.settings(controller.signal).then(value => {
      if (!controller.signal.aborted) { setSettings(value); setError(''); }
    }).catch(() => { if (!controller.signal.aborted) setError('Sign-in could not be checked. Please try again.'); });
    return () => { mounted.current = false; controller.abort(); };
  }, [attempt]);

  async function signIn() {
    if (pending.current || !settings?.googleAvailable) return;
    pending.current = true;
    const epoch = authEpoch();
    setBusy(true); setError(''); onBegin?.();
    try {
      const { url } = await api.auth.login(returnTo);
      if (!mounted.current || authEpoch() !== epoch) return;
      const target = new URL(url, window.location.origin);
      const google = target.origin === 'https://accounts.google.com';
      const callback = target.origin === window.location.origin && target.pathname === '/auth/callback';
      if ((!google && !callback) || target.username || target.password) throw new Error('Invalid sign-in destination');
      window.location.assign(url);
    } catch (reason) {
      if (mounted.current && authEpoch() === epoch) setError(reason instanceof ApiError && reason.status === 429
        ? 'Sign-in is busy. Wait a moment, then try again.'
        : reason instanceof ApiError && reason.status === 503 ? 'Sign-in is temporarily unavailable. Please try again shortly.'
          : 'Sign-in couldn’t start. Check your connection and try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <div className="google-signin">
    {settings?.googleAvailable === false && <p className="notice">Sign-in is not available yet. Please try again later.</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
    {!settings && !error && <p role="status">Checking sign-in availability…</p>}
    <button className="primary" disabled={!settings?.googleAvailable || busy} onClick={() => void signIn()}>
      {busy ? 'Opening Google…' : 'Continue with Google'}
    </button>
    {(!settings && error || settings?.googleAvailable === false) && <button onClick={() => { setError(''); setAttempt(value => value + 1); }}>Check again</button>}
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
  const params = new URLSearchParams(location.search);
  const returnTo = returnPath(params.get('returnTo'));
  const failure = failures[params.get('error') ?? ''];
  return <main id="main" className="access-page">
    <section className="access-copy"><p className="eyebrow">Your next 30 days</p>
      <h1>A clearer plan starts here.</h1><p>Talk through your money and bills, see what’s coming, and decide what to do next.</p>
      <p className="hint">No bank connection. No payments made.</p>
    </section>
    <section className="card signin-card" aria-labelledby="signin-heading">
      <h2 id="signin-heading">Sign in to Cash flow</h2>
      <p>Keep your figures private and return to your saved plan.</p>
      {(failure || auth.message) && <p className={`notice${failure ? ' warning' : ''}`} role={failure ? 'alert' : 'status'}>{failure || auth.message}</p>}
      <GoogleSignIn returnTo={returnTo} onBegin={() => {
        if (location.search) void navigate(`/login${returnTo === '/app' ? '' : `?returnTo=${returnTo}`}`, { replace: true });
      }} />
      <p className="hint">Google confirms who you are. Your microphone stays off until you choose to start talking.</p>
    </section>
  </main>;
}