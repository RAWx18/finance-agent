// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Editor } from './Editor';
import { Projection } from './Projection';
import { Comparison } from './Comparison';
import { Dialog } from './Dialog';
import { Download } from './Download';
import { dateLabel, lastDate, timestamp } from './money';
import type { useSession } from './session';

export function Figures({ session, active, voiceBusy, retry }: {
  session: ReturnType<typeof useSession>; active: boolean; voiceBusy: boolean; retry: ReactNode;
}) {
  const { state, dispatch, perform } = session;
  const { snapshot, settings, draft } = state;
  const editButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<'overview' | 'edit' | 'changes'>('overview');
  const [deleting, setDeleting] = useState(false);
  const [visited, setVisited] = useState(active);
  if (visited !== active) {
    setVisited(active);
    if (active && draft) setView('edit');
  }
  const current = view === 'edit' && !draft ? 'overview' : view;
  const stale = state.connection !== 'live' || state.phase !== 'ready';
  const locked = stale || !!draft || !!state.pending || state.busy || voiceBusy;

  return <section className="figures-page" hidden={!active} aria-labelledby="figures-heading">
    <header className="page-heading"><div><p className="eyebrow">Your next 30 days</p><h1 id="figures-heading" tabIndex={-1}>Your figures</h1></div>
      <Link className="button" to="/app">Back to conversation</Link>
    </header>
    <div className="figures-content">
      {state.messageKind === 'status' && <p className="sr-only" role="status">{state.message}</p>}
      {state.messageKind === 'error' && state.message && <p className="notice warning" role="alert">{state.message}</p>}
      {retry}
      {state.phase === 'empty' && settings && <section className="card start-card"><h2>A quieter way to share figures</h2>
        <p>Add what you know. You can leave anything uncertain.</p>
        <button className="primary" disabled={state.busy || voiceBusy} onClick={() => void perform('start')}>{state.busy ? 'Creating…' : 'Add figures'}</button>
      </section>}
      {snapshot && settings && <>
        <section className="projection-bar" aria-label="Plan dates and actions">
          <div><h2>{dateLabel(snapshot.anchorDate)} – {dateLabel(lastDate(snapshot.endDateExclusive))}</h2>
            <p className="hint">Starting figures from {timestamp(snapshot.asOf, settings.timezone)}</p>
          </div>
          {stale && <p className="connection warning-text" role="status">{state.connection === 'reconnecting' ? 'Reconnecting · figures may be out of date' : 'Updates paused · figures may be out of date'}</p>}
        </section>
        <nav className="figure-navigation" aria-label="Figure views">
          <button aria-pressed={current === 'overview'} onClick={() => setView('overview')}>Overview</button>
          <button ref={editButton} aria-pressed={current === 'edit'} disabled={voiceBusy || !draft && (state.busy || !!state.pending || state.phase !== 'ready')}
            onClick={() => { if (!draft) dispatch({ type: 'edit' }); setView('edit'); }}>Edit figures</button>
          <button aria-pressed={current === 'changes'} onClick={() => setView('changes')}>Spending changes</button>
        </nav>
        {draft && (snapshot.accepted || snapshot.preview) && <p className="notice warning no-print">Saving clears the preview. Changes affecting saved assumptions need fresh consent.</p>}
        <div className="workspace">
          <div hidden={current !== 'edit'}>{draft && <Editor facts={draft.facts} settings={settings} locked={state.busy || voiceBusy || state.phase !== 'ready'} conflict={draft.conflict} pending={!!state.pending}
            onChange={facts => dispatch({ type: 'draft', facts })} onSave={() => void perform('save')}
            onCancel={() => { dispatch({ type: 'cancel' }); requestAnimationFrame(() => editButton.current?.focus()); }}
            onUseSaved={() => dispatch({ type: 'useSaved' })} onReconcile={() => dispatch({ type: 'reconcile' })} />}</div>
          <div className="saved-report" hidden={current !== 'overview'}><Projection snapshot={snapshot} stale={stale} /></div>
          <div hidden={current !== 'changes'}><Comparison key={snapshot.sessionId} snapshot={snapshot} settings={settings} draft={!!draft}
            active={active && current === 'changes'} locked={locked} pending={!!state.pending && state.pending.operation.type !== 'replaceFacts'}
            onCommand={operation => void perform('save', operation)} /></div>
        </div>
      </>}
    </div>
    {snapshot && <div className="figure-actions actions no-print">
      {state.phase === 'ready' && <Download label="Download saved projection" />}
      <button onClick={() => window.print()}>Print saved figures</button>
      <button className="quiet danger" disabled={state.busy || voiceBusy || !!state.pending} onClick={() => setDeleting(true)}>Delete plan</button>
    </div>}
    <Dialog open={active && deleting} title="Delete this plan?" onClose={() => setDeleting(false)} actions={<>
      <button onClick={() => setDeleting(false)}>Keep plan</button>
      <button className="danger" disabled={state.busy || voiceBusy || !!state.pending} onClick={() => { void perform('delete'); setDeleting(false); }}>Delete saved figures and draft</button>
    </>}><p>Your saved figures and unsaved corrections will be deleted. Download a copy first if you want to keep them. Your app account will remain.</p></Dialog>
  </section>;
}