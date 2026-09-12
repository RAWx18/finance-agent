// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { useSession } from './session';
import { isMoneyRoute, moneyRoutes } from './moneyRoutes';
import { MoneyOverview } from './MoneyOverview';
import { MoneyRecords } from './MoneyRecords';
import { MoneyUpcoming } from './MoneyUpcoming';
import { MoneyChanges } from './MoneyChanges';
import { MoneyChecks } from './MoneyChecks';
import { MoneyEdit } from './MoneyEdit';
import type { EditTarget } from './MoneyEdit';
import { MoneyIcon } from './MoneyIcon';
import { Details, Dialog } from './Dialog';
import { Download } from './Download';
import { dateLabel, lastDate } from './money';
import { changeNotes } from './FinancialContext';
import { PagedList } from './PagedList';
import { MoneyPrint } from './MoneyPrint';
import './moneyPage.css';

export function MoneyPage({ session, active, voiceBusy, onEditing }: {
  session: ReturnType<typeof useSession>; active: boolean; voiceBusy: boolean; onEditing: (editing: boolean) => void;
}) {
  const { state, perform } = session;
  const { snapshot, settings } = state;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [checks, setChecks] = useState(false);
  const [tools, setTools] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [identity, setIdentity] = useState(snapshot?.sessionId);
  if (identity !== snapshot?.sessionId) { setIdentity(snapshot?.sessionId); setEdit(null); }
  useEffect(() => { onEditing(!!edit); return () => onEditing(false); }, [edit, onEditing]);
  const stale = state.connection !== 'live' || state.phase !== 'ready';
  const blocked = stale || !!edit || !!state.pending || state.busy || voiceBusy;
  const route = isMoneyRoute(pathname) ? pathname : '/money';
  const title = moneyRoutes[route];
  const notes = snapshot ? changeNotes(snapshot, snapshot.workspace?.change) : [];
  const command = (operation: Parameters<typeof perform>[1]) => { if (!blocked && operation) void perform('save', operation); };
  const openEdit = (target: EditTarget) => { if (!blocked) setEdit(target); };
  return <section className="money-page" hidden={!active} aria-labelledby="money-heading">
    <header className="money-heading"><div className="money-title">
      {route !== '/money' && <Link to="/money" className="button icon-button" aria-label="Back to Money" title="Back to Money"><MoneyIcon name="back" /></Link>}
      <div><h1 id="money-heading" tabIndex={-1}>{title}</h1><p className="money-meta">{snapshot ? <>30-day plan · {dateLabel(snapshot.anchorDate)} – {dateLabel(lastDate(snapshot.endDateExclusive))}</> : 'Your next 30 days'}</p></div>
    </div><div className="money-heading-actions no-print"><Link className="button money-continue" to="/app" aria-label="Continue conversation" title="Continue conversation"><MoneyIcon name="talk" /><span>Continue conversation</span></Link>
      {snapshot && <button className="icon-button" title="Plan tools" aria-label="Plan tools" aria-haspopup="dialog" onClick={() => setTools(true)}><MoneyIcon name="more" /></button>}
    </div></header>
    <div className="money-layout">
      <nav className="money-nav no-print" aria-label="Money navigation">{Object.entries(moneyRoutes).map(([path, label]) => <NavLink end key={path} to={path}>{label}</NavLink>)}</nav>
      <label className="money-mobile-nav no-print"><span className="sr-only">Browse Money</span><select value={route} onChange={event => void navigate(event.target.value)}>{Object.entries(moneyRoutes).map(([path, label]) => <option key={path} value={path}>{label}</option>)}</select></label>
      <div className="money-content" role="region" aria-label={`${title} content`}>
        {state.phase === 'loading' && <p role="status">Loading your saved plan…</p>}
        {state.phase === 'empty' && <section className="money-panel money-empty"><h2>No plan yet</h2><p>Talk through your money or start a blank plan and add what you know.</p><button className="primary" disabled={state.busy || voiceBusy} onClick={() => void perform('start')}>{state.busy ? 'Starting…' : 'Start a blank plan'}</button></section>}
        {snapshot && settings && <>
          <div className="money-context">
            <p className="money-basis">Reported by you · not a live bank balance</p>
            {stale && <p className="money-warning" role="status">Updates paused · showing your saved plan</p>}
            {state.messageKind === 'status' && !edit && <p role="status" className="sr-only">{state.message}</p>}
            {!!notes.length && <div className="money-update"><span>Saved changes</span><p role="status" className="sr-only">{notes[0]}</p><Details compact label="Recent changes"><PagedList label="Recent changes" className="money-checks" pageSize={6}>{notes.map(note => <li key={note}>{note}</li>)}</PagedList></Details></div>}
          </div>
          <div className="money-views" data-page={route} tabIndex={0} aria-label={`${title} details`} role="region">
            {route === '/money' && <MoneyOverview snapshot={snapshot} blocked={blocked} onEdit={openEdit} onChecks={() => setChecks(true)} onCommand={command} />}
            {['/money/income', '/money/spending', '/money/debts'].includes(route) && <MoneyRecords key={route} category={route === '/money/income' ? 'income' : route === '/money/debts' ? 'debts' : 'spending'} snapshot={snapshot} blocked={blocked} onEdit={openEdit} onCommand={command} />}
            {route === '/money/upcoming' && <MoneyUpcoming snapshot={snapshot} />}
            <div hidden={route !== '/money/changes'}><MoneyChanges key={snapshot.sessionId} snapshot={snapshot} settings={settings} active={active && route === '/money/changes'} blocked={blocked} pending={!!state.pending} onCommand={command} /></div>
          </div>
        </>}
      </div>
    </div>
    {snapshot && <>
      <MoneyChecks snapshot={snapshot} open={active && checks} blocked={blocked} onClose={() => setChecks(false)} onEdit={openEdit} onCommand={command} />
      {edit && <MoneyEdit key={`${identity}:${edit.recordId}:${edit.field}`} target={edit} snapshot={snapshot} state={state} active={active} onClose={() => setEdit(null)} onCommand={operation => void perform('save', operation)} onRetry={() => void perform('save')} />}
      <Dialog open={active && tools} title="Plan tools" onClose={() => setTools(false)}><div className="money-tool-menu">
        {state.phase === 'ready' && <Download compact label="Download saved plan" />}
        <button className="icon-button" aria-label="Print saved plan" title="Print saved plan" onClick={() => { setTools(false); requestAnimationFrame(() => window.print()); }}><MoneyIcon name="print" /></button>
        <button className="icon-button danger" disabled={blocked} aria-label="Delete plan" title="Delete plan" onClick={() => { setTools(false); setDeleting(true); }}><MoneyIcon name="remove" /></button>
      </div><p className="hint">Downloads and printing contain the saved projection, never an unsaved preview.</p></Dialog>
      <Dialog open={active && deleting} title="Delete this plan?" onClose={() => setDeleting(false)} actions={<><button onClick={() => setDeleting(false)}>Keep plan</button><button className="danger" disabled={blocked} onClick={() => { void perform('delete'); setDeleting(false); }}>Delete plan</button></>}><p>Your saved figures and corrections will be deleted. Download a copy first if needed. Your account will remain.</p></Dialog>
    </>}
    {snapshot && <MoneyPrint snapshot={snapshot} />}
  </section>;
}