// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, authEpoch } from './api';
import { useAuth } from './Auth';
import { Dialog } from './Dialog';
import { GoogleSignIn } from './Login';
import { dismiss, notify } from './Toast';

export function Account({ retentionHours }: { retentionHours: number | undefined }) {
  const auth = useAuth();
  const user = auth.session!.user;
  const [name, setName] = useState(user.displayName);
  const [saveFailed, setSaveFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [requiresSignin, setRequiresSignin] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const actions = useRef<{ save: () => Promise<void>; remove: () => Promise<void> } | null>(null);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    dismiss('account:save'); dismiss('account:delete');
  }; }, []);

  useEffect(() => { actions.current = { save, remove }; });

  useEffect(() => {
    if (!saveFailed) return;
    const epoch = authEpoch();
    notify({ id: 'account:save', title: 'Your name could not be saved',
      message: 'Check your connection and try again.', severity: 'error', duration: null,
      action: { label: 'Retry', disabled: busy, onClick: () => {
        if (mounted.current && epoch === authEpoch()) return actions.current?.save();
      } } });
  }, [saveFailed, busy]);

  useEffect(() => {
    if (!deleteFailed || !deleting || requiresSignin) { dismiss('account:delete'); return; }
    const epoch = authEpoch();
    notify({ id: 'account:delete', title: 'Account deletion could not be confirmed',
      message: 'Deletion may have completed. Check your connection and keep DELETE entered to retry.', severity: 'critical', duration: null,
      action: { label: 'Retry deletion', disabled: busy || confirmation !== 'DELETE', onClick: () => {
        if (mounted.current && epoch === authEpoch()) return actions.current?.remove();
      } } });
  }, [deleteFailed, deleting, requiresSignin, busy, confirmation]);

  async function save() {
    if (!mounted.current || pending.current) return;
    const displayName = name.trim();
    dismiss('account:save'); setSaveFailed(false);
    if (!displayName || Array.from(displayName).length > 80 || /\p{C}/u.test(name)) {
      setError('Use 1–80 characters, without control characters.'); return;
    }
    pending.current = true;
    setBusy(true); setError('');
    const epoch = authEpoch();
    try {
      const saved = await api.account.update(displayName);
      if (!mounted.current || epoch !== authEpoch()) return;
      auth.updateUser(saved); setName(saved.displayName);
      notify({ id: 'account:save', title: 'Your name is saved.', severity: 'success', duration: 6000 });
    } catch (reason) {
      if (!mounted.current || epoch !== authEpoch()) return;
      if (reason instanceof ApiError && reason.status === 422) setError('Use 1–80 characters, without control characters.');
      else setSaveFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function remove() {
    if (!mounted.current || !deleting || pending.current || confirmation !== 'DELETE' || requiresSignin) return;
    pending.current = true;
    setBusy(true); setDeleteFailed(false); dismiss('account:delete');
    const epoch = authEpoch();
    try {
      const result = await api.account.delete('DELETE');
      if (!mounted.current || epoch !== authEpoch()) return;
      if (result.deleted) auth.deleted();
      else setDeleteFailed(true);
    } catch (reason) {
      if (!mounted.current || epoch !== authEpoch()) return;
      if (reason instanceof ApiError && reason.status === 428 && reason.body.code === 'requiresSignin') {
        setRequiresSignin(true); setConfirmation('');
      } else setDeleteFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="account-page" aria-labelledby="account-heading">
    <header className="page-heading"><p className="eyebrow">Your profile</p><h1 id="account-heading" tabIndex={-1}>Your account</h1></header>
    <div className="account-layout">
      <section className="card" aria-labelledby="profile-heading"><h2 id="profile-heading">How should we address you?</h2>
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <label htmlFor="display-name">Display name</label>
          <input id="display-name" autoComplete="nickname" value={name} disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'name-error' : undefined}
            onChange={event => { setName(event.target.value); setError(''); }} />
          {error && <p id="name-error" className="field-error" role="alert">{error}</p>}
          <button className="primary" disabled={busy || name === user.displayName}>{busy && !deleting ? 'Saving…' : 'Save name'}</button>
        </form>
        <div className="google-identity"><h3>Signed in with Google</h3><dl>
          <div><dt>Google name</dt><dd>{user.googleName}</dd></div><div><dt>Email</dt><dd>{user.email}</dd></div>
        </dl><p className="hint">These details come from Google and can’t be edited here. Your display name only changes in this app.</p></div>
      </section>
      <div className="account-details"><section className="card"><h2>Your sign-in and saved plan</h2>
        <p>You can stay signed in for up to 7 days. Signing out ends this app session, not other independent browser sign-ins.</p>
        <p>{retentionHours === undefined ? 'Figures and plans have a separate, shorter retention period.' : `Figures and plans are kept for ${retentionHours} hours, separately from your sign-in.`} Download a plan you want to keep.</p>
      </section>
      <section className="card account-delete" aria-labelledby="delete-heading"><h2 id="delete-heading">Delete app account</h2>
        <p>Permanently delete your figures, plan, assumptions and every app login session.</p>
        <button className="quiet danger" disabled={busy} onClick={() => { setDeleting(true); setConfirmation(''); setDeleteFailed(false); setRequiresSignin(false); }}>Delete app account</button>
      </section></div>
    </div>
    <Dialog open={deleting} title="Delete your app account?" onClose={() => { if (!pending.current) setDeleting(false); }} actions={!requiresSignin && <>
      <button disabled={busy} onClick={() => { if (!pending.current) setDeleting(false); }}>Keep account</button>
      <button className="danger" disabled={confirmation !== 'DELETE' || busy} onClick={() => void remove()}>{busy ? 'Deleting account…' : 'Permanently delete app account'}</button>
    </>}>
      <p>This irreversibly deletes all your app figures, plan and assumptions, signs out every app session, and stops any conversation.</p>
      <p><strong>Your Google account will not be deleted.</strong> Download your plan first if you want a copy.</p>
      {requiresSignin ? <><p className="notice">Sign in again with Google before deleting your app account. You’ll return here to confirm deletion again; signing in does not delete anything.</p>
        {deleting && <GoogleSignIn returnTo="/account" />}</> : <>
        <label htmlFor="delete-confirmation">Type DELETE to confirm</label>
        <input id="delete-confirmation" autoComplete="off" spellCheck={false} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} />
      </>}
    </Dialog>
  </section>;
}