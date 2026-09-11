// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useBlocker, useLocation, useNavigate } from 'react-router';
import { AuthProvider, useAuth } from './Auth';
import { Account } from './Account';
import { Login, returnPath } from './Login';
import { Figures } from './Figures';
import { Download } from './Download';
import { dismiss, notify, ToastViewport } from './Toast';
import { dateLabel, lastDate, timestamp } from './money';
import { useSession } from './session';
import { Conversation } from './Conversation';
import type { VoicePhase } from './Conversation';
import { FinancialContext } from './FinancialContext';

type Journey = 'landing' | 'ready' | 'session' | 'review' | 'finished';

function Workspace() {
  const auth = useAuth();
  const location = useLocation();
  const route = useNavigate();
  const session = useSession();
  const { state, dispatch, perform, retryConnection } = session;
  const { snapshot, settings, draft } = state;
  const heading = useRef<HTMLHeadingElement>(null);
  const [journey, setJourney] = useState<Journey>('landing');
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [reviewedSequence, setReviewedSequence] = useState<number | null>(null);
  const figuresOpen = location.pathname === '/figures';
  const accountOpen = location.pathname === '/account';
  const conversationVisible = location.pathname === '/app';
  const stale = state.connection !== 'live' || state.phase !== 'ready';
  const locked = stale || !!draft || !!state.pending || state.busy;
  const hasPicture = !!snapshot && (snapshot.facts.opening.amountPaise !== null || snapshot.facts.records.length > 0
    || Object.values(snapshot.facts.coverage).some(value => value !== 'notDiscussed')
    || !!snapshot.preview || !!snapshot.accepted || !!snapshot.facts.decision?.responses?.length);
  const changedAfterReview = journey === 'finished' && snapshot?.sequence !== reviewedSequence;
  const view = changedAfterReview ? 'review' : journey;
  const running = ['connecting', 'active', 'ending'].includes(voicePhase);
  const reviewing = view === 'review' || view === 'finished';
  const stage = view === 'session' ? voicePhase === 'active' && hasPicture ? 'taking-shape' : voicePhase : view;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (running || voiceBusy)
    && currentLocation.pathname === '/app' && nextLocation.pathname !== '/app');
  const retry = state.pending && state.pending.operation.type !== 'replaceFacts' && <div className="notice warning no-print">
    <p>Your action is not confirmed. Retry the same action before making another change.</p>
    <button type="button" disabled={stale || state.busy} onClick={() => void perform('save')}>Retry same action</button>
  </div>;
  const actions = useRef({ perform, retryConnection, navigate, openFigures, blocker });
  useLayoutEffect(() => { actions.current = { perform, retryConnection, navigate, openFigures, blocker }; });

  useEffect(() => {
    if (['unavailable', 'unreadable', 'expired', 'deleted'].includes(state.phase)) {
      const expired = state.phase === 'expired' || state.phase === 'deleted';
      notify({ id: 'session:terminal', severity: state.phase === 'unreadable' ? 'critical' : 'error', duration: null,
        title: state.phase === 'unreadable' ? 'Saved figures need attention' : state.phase === 'expired' ? 'Plan expired'
          : state.phase === 'deleted' ? 'Plan no longer available' : 'Connection unavailable',
        message: expired ? 'Your saved plan is no longer current. Start again for a fresh 30 days. Unsaved corrections will be cleared.'
          : state.phase === 'unreadable' ? 'Your saved figures could not be read. They have not been deleted.' : 'Your figures couldn’t be loaded. Your draft is still here.',
        action: { label: expired ? conversationVisible ? 'Start again' : 'Return to conversation' : 'Retry connection',
          disabled: state.busy || voiceBusy || !!state.pending,
          onClick: async () => {
            if (!expired) { actions.current.retryConnection(); return; }
            if (!conversationVisible) { actions.current.navigate('ready'); return; }
            await actions.current.perform('start'); actions.current.navigate('ready');
          } } });
    } else dismiss('session:terminal');
  }, [state.phase, state.busy, state.pending, voiceBusy, conversationVisible]);

  useEffect(() => {
    if (state.connection === 'reconnecting' && state.phase === 'ready') notify({ id: 'session:connection', severity: 'warning', duration: null,
      title: 'Reconnecting to your figures', message: 'Showing the last saved picture. Any conversation has been stopped; reconnect explicitly after updates return.',
      action: { label: 'Retry updates', disabled: state.busy, onClick: () => actions.current.retryConnection() } });
    else dismiss('session:connection');
  }, [state.connection, state.phase, state.busy]);

  useEffect(() => {
      if (!state.pending && state.messageKind === 'error' && state.message && state.phase === 'ready' && (view === 'landing' || accountOpen)) notify({ id: 'session:action', severity: 'error', duration: null,
        title: 'Action needs attention', message: state.message,
        action: { label: draft ? 'Review your draft' : 'Review figures', disabled: voiceBusy || running,
          onClick: () => actions.current.openFigures() } });
      else dismiss('session:action');
  }, [state.pending, state.messageKind, state.message, state.phase, view, accountOpen, draft, voiceBusy, running]);

  useEffect(() => {
    if (draft?.conflict) notify({ id: 'session:conflict', severity: 'warning', duration: null,
      title: 'Saved figures changed', message: 'Your draft is kept. Compare it with the saved figures before saving.',
      action: { label: 'Review your draft', disabled: voiceBusy, onClick: () => actions.current.openFigures() } });
    else dismiss('session:conflict');
  }, [draft?.conflict, voiceBusy]);

  useEffect(() => {
    if (blocker.state === 'blocked') notify({ id: 'voice:navigation', severity: 'warning', duration: null,
      title: 'A conversation is open', message: 'End it before opening another page. Your voice controls are still here.',
      action: { label: 'Continue', onClick: () => { if (actions.current.blocker.state === 'blocked') actions.current.blocker.reset(); } } });
    else dismiss('voice:navigation');
  }, [blocker.state]);

  useEffect(() => () => {
    for (const id of ['session:terminal', 'session:connection', 'session:action', 'session:pending', 'session:conflict', 'voice:navigation']) dismiss(id);
  }, []);

  useEffect(() => {
    if (!draft && !running) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, running]);

  useEffect(() => {
    const id = figuresOpen ? 'figures-heading' : accountOpen ? 'account-heading' : 'page-heading';
    document.title = `${figuresOpen ? 'Your figures' : accountOpen ? 'Your account' : 'Your 30-day plan'} · Cash flow`;
    document.getElementById(id)?.focus({ preventScroll: true });
  }, [location.pathname, figuresOpen, accountOpen]);

  function navigate(next: Journey) {
    setJourney(next);
    if (!conversationVisible) void route('/app');
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  function openFigures() {
    if (running || voiceBusy) return;
    void route('/figures');
  }

  function voiceChanged(phase: VoicePhase) {
    setVoicePhase(phase);
    if (phase === 'idle') return;
    setJourney(phase === 'ended' ? 'review' : 'session');
    if (phase === 'ended') requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  return <>
    <Header />
    <main id="main" className="product-main" data-view={view} data-stage={stage} data-route={location.pathname}>
      <p className="sr-only" role="status">{state.messageKind === 'status' && !figuresOpen ? state.message : ''}</p>
      <div className="page-feedback" hidden={accountOpen}>
      {auth.message && <p className="notice" role="status">{auth.message}</p>}
      {conversationVisible && view !== 'landing' && <nav className="journey-progress" aria-label="Your progress"><ol>
        <li aria-current={view === 'ready' || view === 'session' ? 'step' : undefined}>Talk</li>
        <li aria-current={view === 'review' ? 'step' : undefined}>Review</li>
        <li aria-current={view === 'finished' ? 'step' : undefined}>Take your plan</li>
      </ol></nav>}
      {state.phase === 'loading' && <p className="sr-only" role="status">Loading…</p>}
      </div>

      <div hidden={!conversationVisible} className={`journey-layout ${view === 'landing' ? 'welcome-layout' : reviewing ? 'review-layout' : 'live-layout'} no-print`}>
        <div className="conversation-pane">
          <div className="journey-intro">
            {view === 'landing' && <p className="eyebrow">Your next 30 days</p>}
            <h1 id="page-heading" tabIndex={-1} ref={heading}>{view === 'landing' ? <>Talk it through.<br /><span>See your next 30 days clearly.</span></> : view === 'ready' || view === 'session' ? 'Let’s talk it through.' : view === 'finished' ? 'Your next step is clearer.' : changedAfterReview ? 'Your figures have changed.' : hasPicture ? 'Your 30-day plan.' : 'Ready to talk again?'}</h1>
            {reviewing && <p className="intro-copy">{changedAfterReview ? 'Review the latest figures before finishing.' : !hasPicture ? 'No figures saved yet.' : view === 'finished' ? 'Keep a copy and check any open questions.' : 'Check the next steps and anything still uncertain.'}</p>}
          </div>
          <div className="voice-container" hidden={reviewing}>
            <Conversation settings={settings} sessionId={snapshot?.sessionId}
              presentation={view === 'landing' ? 'landing' : view === 'ready' ? 'ready' : 'session'}
              disabled={state.busy || !!state.pending || !!draft || !['empty', 'ready'].includes(state.phase) || !!snapshot && stale}
              onStarted={value => dispatch({ type: 'started', snapshot: value })} onBusyChange={setVoiceBusy}
              onPrepare={() => navigate('ready')} onPhaseChange={voiceChanged}
              visible={conversationVisible && !reviewing}
              updatesLost={!!snapshot && (state.connection === 'reconnecting' || state.connection === 'closed' || state.phase !== 'ready')}
              sessionIssue={state.phase === 'expired' || state.phase === 'deleted' || state.phase === 'unreadable' ? state.phase : undefined}
              onSettings={value => dispatch({ type: 'settings', settings: value })} />
          </div>
          {view === 'landing' && <>
            {hasPicture && snapshot && <div className="return-note">
              <p className="hint">{dateLabel(snapshot.anchorDate)} – {dateLabel(lastDate(snapshot.endDateExclusive))}</p>
              <button className="quiet" onClick={() => navigate('review')}>Review saved picture <span aria-hidden="true">→</span></button></div>}
          </>}
          {(view === 'ready' || view === 'session') && <div className="conversation-navigation">
            {view === 'ready' && <button className="quiet back-link" disabled={voiceBusy} onClick={() => navigate('landing')}>Back to welcome</button>}
            {view === 'session' && !running && !voiceBusy && hasPicture && <button className="quiet" onClick={() => navigate('review')}>Review saved picture <span aria-hidden="true">→</span></button>}
          </div>}
          {reviewing && <div className="review-controls">
            {hasPicture && view === 'review' && <button className="primary" disabled={stale || voiceBusy || !!draft || !!state.pending || state.busy} onClick={() => { setReviewedSequence(snapshot!.sequence); navigate('finished'); }}>Finish review</button>}
            {hasPicture && state.phase === 'ready' && <Download label="Download plan" primary={view === 'finished'} />}
            <button className="quiet" disabled={state.busy || !!state.pending || !!draft} onClick={() => navigate('ready')}>Return to conversation</button>
            {snapshot && settings && <p className="hint retention-note">Available until {timestamp(snapshot.expiresAt, settings.timezone)}</p>}
          </div>}
        </div>
        {view === 'landing' && <aside className="welcome-aside" aria-labelledby="welcome-aside-heading">
          <h2 id="welcome-aside-heading">A little less to carry.</h2>
          <ol className="how-it-works">
            <li><span aria-hidden="true">01</span><h3>Talk through your money and bills</h3></li>
            <li><span aria-hidden="true">02</span><h3>See your picture take shape</h3></li>
            <li><span aria-hidden="true">03</span><h3>Decide what to do next</h3></li>
          </ol>
        </aside>}
        {view !== 'landing' && <div className="financial-pane">
          <FinancialContext snapshot={snapshot} stale={!!snapshot && stale} mode={reviewing ? view as 'review' | 'finished' : 'live'}
            locked={locked} onCommand={operation => void perform('save', operation)} proposalActive={conversationVisible}
            error={conversationVisible && state.messageKind === 'error' ? state.message : undefined}
            onInspect={!voiceBusy && !running ? openFigures : undefined} />
        </div>}
      </div>

      <div className="journey-tools no-print" hidden={!conversationVisible}>
        <button className="quiet" disabled={running || voiceBusy} onClick={openFigures}>{draft ? 'Review your draft' : snapshot ? 'Your figures' : 'Prefer typing?'}</button>
        {draft && <p className="hint">Unsaved corrections</p>}
        {retry}
        {state.pending?.operation.type === 'replaceFacts' && <p className="hint">An action needs confirmation. Open your figures to retry.</p>}
      </div>
      <Figures session={session} active={figuresOpen} voiceBusy={voiceBusy || running} retry={figuresOpen ? retry : null} />
      {accountOpen && <Account retentionHours={settings?.retentionHours} />}
    </main>
    <footer className="site-footer"><span>You stay in control. No payments are made.</span></footer>
  </>;
}

function Header() {
  const auth = useAuth();
  return <><a className="skip-link" href="#main">Skip to main content</a><header className="site-header">
    <Link className="brand" to="/app" aria-label="Cash flow home"><svg aria-hidden="true" viewBox="0 0 32 32" width="34" height="34" fill="none"><path d="M7 5h18a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H13l-7 5v-5a3 3 0 0 1-3-3V8a3 3 0 0 1 4-3Z" stroke="currentColor" strokeWidth="1.7" /><path d="M10 15h3m3-5v10m5-7v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>Cash flow</Link>
    {auth.phase === 'ready' && <nav className="site-navigation no-print" aria-label="Main navigation">
      <NavLink to="/app">Conversation</NavLink><NavLink to="/figures">Your figures</NavLink><NavLink to="/account">Account</NavLink>
      <button className="quiet" onClick={() => void auth.logout()}>Sign out</button>
    </nav>}
  </header></>;
}

function AccessRoutes() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.phase === 'ready' && ['/', '/app', '/figures', '/account'].includes(location.pathname)) {
    if (location.pathname === '/') return <Navigate to="/app" replace />;
    return <Workspace key={auth.session!.user.id} />;
  }
  if (auth.phase === 'anonymous' && location.pathname !== '/login') return <Navigate replace
    to={`/login${returnPath(location.pathname) === '/app' ? '' : `?returnTo=${returnPath(location.pathname)}`}`} />;
  const checking = auth.phase === 'restoring' || auth.phase === 'signingOut';
  return <><Header />
    {location.pathname === '/login' && (auth.phase === 'anonymous' || auth.phase === 'ready') ? <Login />
      : auth.phase === 'ready' ? <main id="main" className="access-page"><section><h1>Page not found</h1><p>That page isn’t available.</p><Link to="/app">Return to your plan</Link></section></main>
        : <main id="main" className="access-page"><section className="card access-status" aria-live="polite">
          <h1>{auth.phase === 'signingOut' ? 'Signing out…' : checking ? 'Checking your sign-in…' : auth.phase === 'logoutUncertain' ? 'Sign-out not confirmed' : 'Sign-in connection unavailable'}</h1>
          {auth.message && <p>{auth.message}</p>}
          {!checking && <div className="actions">
            <button className="primary" onClick={() => void auth.check()}>{auth.phase === 'logoutUncertain' ? 'Check sign-in' : 'Retry connection'}</button>
            <button onClick={() => void auth.logout()}>{auth.phase === 'logoutUncertain' ? 'Retry sign out' : 'Sign out'}</button>
          </div>}
        </section></main>}
    <footer className="site-footer">You stay in control. No payments are made.</footer>
  </>;
}

export function App() {
  return <AuthProvider><AccessRoutes /><ToastViewport /></AuthProvider>;
}

export function RouteError() {
  return <main className="access-page"><section className="card"><h1>This page couldn’t open</h1><p>Reload to check your sign-in and try again. Your saved figures are held by the service.</p><a className="button" href="/app">Reload your plan</a></section></main>;
}