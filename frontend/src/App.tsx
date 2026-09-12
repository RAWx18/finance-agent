// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useBlocker, useLocation, useNavigate } from 'react-router';
import { AuthProvider, useAuth } from './Auth';
import { Account } from './Account';
import { Login, returnPath } from './Login';
import { MoneyPage } from './MoneyPage';
import { isMoneyRoute, moneyRoutes } from './moneyRoutes';
import { Download } from './Download';
import { dismiss, notify, ToastViewport } from './Toast';
import { dateLabel, lastDate, timestamp } from './money';
import { useSession } from './session';
import { Conversation } from './Conversation';
import type { VoicePhase } from './Conversation';
import { FinancialContext } from './FinancialContext';
import { History } from './History';
import { isHistoryRoute } from './historyRoutes';
import { Details } from './Dialog';
import { Recovery } from './Recovery';
import { ProfileMenu } from './ProfileMenu';

type Journey = 'landing' | 'ready' | 'session' | 'review' | 'finished';

function Workspace() {
  const location = useLocation();
  const route = useNavigate();
  const session = useSession();
  const { state, dispatch, perform, retryConnection } = session;
  const { snapshot, settings } = state;
  const heading = useRef<HTMLHeadingElement>(null);
  const [journey, setJourney] = useState<Journey>('landing');
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [reviewedSequence, setReviewedSequence] = useState<number | null>(null);
  const moneyOpen = isMoneyRoute(location.pathname);
  const [moneyEditing, setMoneyEditing] = useState(false);
  const accountOpen = location.pathname === '/account';
  const historyOpen = isHistoryRoute(location.pathname);
  const conversationVisible = location.pathname === '/app';
  const stale = state.connection !== 'live' || state.phase !== 'ready';
  const expired = state.phase === 'expired' || state.phase === 'deleted';
  const terminal = expired || state.phase === 'unavailable' || state.phase === 'unreadable';
  const recovering = terminal || state.connection === 'reconnecting' && state.phase === 'ready';
  const fullRecovery = terminal && !snapshot && (conversationVisible || moneyOpen);
  const locked = stale || moneyEditing || !!state.pending || state.busy;
  const hasPicture = !!snapshot && (snapshot.facts.opening.amountPaise !== null || snapshot.facts.records.length > 0
    || Object.values(snapshot.facts.coverage).some(value => value !== 'notDiscussed')
    || !!snapshot.preview || !!snapshot.accepted || !!snapshot.facts.decision?.responses?.length);
  const changedAfterReview = journey === 'finished' && snapshot?.sequence !== reviewedSequence;
  const view = changedAfterReview ? 'review' : journey;
  const running = ['connecting', 'active', 'ending'].includes(voicePhase);
  const reviewing = view === 'review' || view === 'finished';
  const stage = view === 'session' ? voicePhase === 'active' && hasPicture ? 'taking-shape' : voicePhase : view;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && (moneyEditing || (running || voiceBusy)
    && (currentLocation.pathname === '/app' || isHistoryRoute(currentLocation.pathname))
    && nextLocation.pathname !== '/app' && !isHistoryRoute(nextLocation.pathname)));
  function openMoney() {
    if (running || voiceBusy) return;
    void route('/money');
  }

  const uncertain = useRef<string | null>(null);
  const actions = useRef({ perform, openMoney, blocker });
  useLayoutEffect(() => { actions.current = { perform, openMoney, blocker }; });

  useEffect(() => {
    if (state.pending) {
      dismiss('session:action');
      if (!state.busy || state.messageKind === 'error') uncertain.current = state.pending.commandId;
      if (uncertain.current === state.pending.commandId) notify({ id: 'session:pending', severity: 'critical', duration: null, dismissible: false,
        title: 'Save not confirmed', message: 'Keep this page open. Retry the same action before making another change.',
        action: { label: state.pending.operation.type === 'replaceFacts' ? 'Retry same save' : 'Retry same action', disabled: stale || state.busy, dismiss: false,
          onClick: () => actions.current.perform('save') } });
    } else {
      uncertain.current = null; dismiss('session:pending');
      if (state.messageKind === 'error' && state.message && state.phase === 'ready') notify({ id: 'session:action', severity: 'error', duration: null,
        title: 'Action needs attention', message: state.message,
        action: { label: 'Review Money', disabled: voiceBusy || running,
          onClick: () => actions.current.openMoney() } });
      else dismiss('session:action');
    }
  }, [state.pending, state.busy, state.messageKind, state.message, state.phase, stale, voiceBusy, running]);

  useEffect(() => {
    if (blocker.state === 'blocked') notify({ id: 'voice:navigation', severity: 'warning', duration: null,
      title: moneyEditing ? 'Finish your correction' : 'A conversation is open', message: moneyEditing ? 'Save or discard the correction before leaving Money.' : 'End it before opening Money or account settings. Return to Conversation for call controls.',
      action: { label: 'Continue', onClick: () => { if (actions.current.blocker.state === 'blocked') actions.current.blocker.reset(); } } });
    else dismiss('voice:navigation');
  }, [blocker.state, moneyEditing]);

  useEffect(() => () => {
    for (const id of ['session:action', 'session:pending', 'voice:navigation']) dismiss(id);
  }, []);

  useEffect(() => {
    if (!running && !moneyEditing && !state.pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running, moneyEditing, state.pending]);

  useEffect(() => {
    const id = moneyOpen ? 'money-heading' : accountOpen ? 'account-heading' : historyOpen
      ? location.pathname === '/history' ? 'history-heading' : 'history-conversation-heading' : 'page-heading';
    document.title = `${isMoneyRoute(location.pathname) ? moneyRoutes[location.pathname] : accountOpen ? 'Settings' : historyOpen ? 'History' : 'Your 30-day plan'} · Cash flow`;
    document.getElementById(id)?.focus({ preventScroll: true });
  }, [location.pathname, moneyOpen, accountOpen, historyOpen]);

  function navigate(next: Journey) {
    setJourney(next);
    if (!conversationVisible) void route('/app');
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  function voiceChanged(phase: VoicePhase) {
    setVoicePhase(phase);
    if (phase === 'idle') return;
    setJourney(phase === 'ended' ? 'review' : 'session');
    if (phase === 'ended' && conversationVisible) requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  return <>
    <Header voiceBusy={running || voiceBusy} hasDraft={moneyEditing} />
    <main id="main" className={`product-main${fullRecovery ? ' recovery-page' : ''}`} data-view={view} data-stage={stage} data-route={location.pathname}>
      <p className="sr-only" role="status">{state.messageKind === 'status' && !moneyOpen && !recovering ? state.message : ''}</p>
      <div className="page-feedback" hidden={accountOpen || historyOpen}>
      {recovering && <Recovery inline={!fullRecovery} busy={state.busy}
        title={state.phase === 'unreadable' ? 'Your figures need another look.' : state.phase === 'expired' ? 'Time for a fresh plan.'
          : state.phase === 'deleted' ? 'This plan is no longer available.' : 'Your saved plan is safe.'}
        message={expired ? 'Start a fresh 30-day plan. Unsaved corrections will be cleared.'
          : state.phase === 'unreadable' ? 'We couldn’t open your saved figures. Nothing has been deleted.'
            : snapshot ? 'You’re seeing your last saved figures. Retry to continue.'
              : 'We’ve lost the connection for a moment. Retry to see your figures.'}>
        <button className="primary" disabled={state.busy || expired && (voiceBusy || !!state.pending)} onClick={async () => {
          if (!expired) { retryConnection(); return; }
          if (!conversationVisible) { navigate('ready'); return; }
          await perform('start'); navigate('ready');
        }}>{state.busy && fullRecovery ? expired ? 'Starting…' : 'Trying again…'
            : expired ? conversationVisible ? 'Start again' : 'Return to conversation' : 'Retry connection'}</button>
      </Recovery>}
      {!recovering && conversationVisible && view !== 'landing' && <nav className="journey-progress" aria-label="Your progress"><ol>
        <li aria-current={view === 'ready' || view === 'session' ? 'step' : undefined}>Talk</li>
        <li aria-current={view === 'review' ? 'step' : undefined}>Review</li>
        <li aria-current={view === 'finished' ? 'step' : undefined}>Take your plan</li>
      </ol></nav>}
      {state.phase === 'loading' && <p className="sr-only" role="status">Loading…</p>}
      </div>

      <div hidden={!conversationVisible || fullRecovery} className={`journey-layout ${view === 'landing' ? 'welcome-layout' : reviewing ? 'review-layout' : 'live-layout'} no-print`}>
        <div className="conversation-pane">
          <div className={`journey-intro${view === 'ready' || view === 'session' ? ' sr-only' : ''}`}>
            {view === 'landing' && <p className="eyebrow">Your next 30 days</p>}
            <h1 id="page-heading" tabIndex={-1} ref={heading}>{view === 'landing' ? <>Talk it through.<br /><span>See your next 30 days clearly.</span></> : view === 'ready' || view === 'session' ? 'Let’s talk it through.' : view === 'finished' ? 'Your next step is clearer.' : changedAfterReview ? 'Your figures have changed.' : hasPicture ? 'Your 30-day plan.' : 'Ready to talk again?'}</h1>
            {reviewing && <p className="intro-copy">{changedAfterReview ? 'Review the latest figures before finishing.' : !hasPicture ? 'No figures saved yet.' : view === 'finished' ? 'Keep a copy and check any open questions.' : 'Check the next steps and anything still uncertain.'}</p>}
          </div>
          <div className="voice-container" hidden={reviewing}>
            <Conversation settings={settings} sessionId={snapshot?.sessionId}
              presentation={view === 'landing' ? 'landing' : view === 'ready' ? 'ready' : 'session'}
              disabled={state.busy || !!state.pending || moneyEditing || !['empty', 'ready'].includes(state.phase) || !!snapshot && stale}
              onStarted={value => dispatch({ type: 'started', snapshot: value })} onBusyChange={setVoiceBusy}
              onTranscriptChange={value => { if (!value.interim && !value.captions.at(-1)?.pending) setHistoryRevision(version => version + 1); }}
              onPrepare={() => navigate('ready')} onPhaseChange={voiceChanged}
              visible={conversationVisible && !reviewing && !fullRecovery}
              updatesReady={state.connection === 'live' && state.phase === 'ready'}
              updatesLost={!!snapshot && (state.connection === 'reconnecting' || state.phase !== 'ready')}
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
            {hasPicture && view === 'review' && <button className="primary" disabled={stale || voiceBusy || !!state.pending || state.busy} onClick={() => { setReviewedSequence(snapshot!.sequence); navigate('finished'); }}>Finish review</button>}
            {hasPicture && state.phase === 'ready' && <Download label="Download plan" primary={view === 'finished'} />}
            <button className="quiet" disabled={state.busy || !!state.pending} onClick={() => navigate('ready')}>Return to conversation</button>
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
            locked={locked} onCommand={operation => void perform('save', operation)} proposalActive={conversationVisible} />
        </div>}
      </div>

      <MoneyPage session={session} active={moneyOpen && !fullRecovery} voiceBusy={voiceBusy || running} onEditing={setMoneyEditing} />
      {accountOpen && <Account />}
      {historyOpen && <History timezone={settings?.timezone} assistantName={settings?.assistantName} ongoing={running}
        revision={`${historyRevision}:${voicePhase}:${state.phase}:${snapshot?.sessionId ?? ''}`} />}
    </main>
    <footer className="site-footer no-print"><span>No payments are made.</span><Details label="Privacy">
      <p>Audio and words are processed to prepare your plan. Avoid account numbers, passwords and card details.</p>
      <p>{settings ? `Figures and saved conversations are kept for up to ${settings.retentionHours} hours. ` : ''}Deleting your plan or account also deletes its conversations. Signing out hides them on this device.</p>
    </Details></footer>
  </>;
}

function Brand() {
  return <Link className="brand" to="/app" aria-label="Cash flow home"><svg aria-hidden="true" viewBox="0 0 32 32" width="30" height="30" fill="none"><path d="M7 5h18a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H13l-7 5v-5a3 3 0 0 1-3-3V8a3 3 0 0 1 4-3Z" stroke="currentColor" strokeWidth="1.7" /><path d="M10 15h3m3-5v10m5-7v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg><span>Cash flow</span></Link>;
}

function Header({ voiceBusy = false, hasDraft = false }: { voiceBusy?: boolean; hasDraft?: boolean }) {
  const auth = useAuth();
  const location = useLocation();
  return <><a className="skip-link" href="#main">Skip to main content</a><header className="site-header">
    <Brand />
    {auth.phase === 'ready' && <nav className="site-navigation no-print" aria-label="Main navigation">
      <NavLink to="/app">Conversation</NavLink>
      <NavLink to="/history">History</NavLink>
      <NavLink to="/money" aria-disabled={voiceBusy || undefined} aria-label="Money" aria-description={hasDraft ? 'Unsaved corrections' : undefined}>
        Money{hasDraft && <span className="nav-draft" aria-hidden="true" title="Unsaved corrections" />}
      </NavLink>
    </nav>}
    {auth.phase === 'ready' && <ProfileMenu key={location.key} />}
  </header></>;
}

function AccessRoutes() {
  const auth = useAuth();
  const location = useLocation();
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (auth.message && (auth.phase === 'ready' || auth.phase === 'anonymous')) notify({ id: 'auth:status',
      title: auth.phase === 'ready' ? 'Sign-in update' : 'Your sign-in', message: auth.message, severity: 'info', duration: 8000 });
    else dismiss('auth:status');
  }, [auth.phase, auth.message]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    await auth.check();
    setRetrying(false);
  }

  if (auth.phase === 'ready' && location.pathname === '/login' && !new URLSearchParams(location.search).has('error'))
    return <Navigate to={returnPath(new URLSearchParams(location.search).get('returnTo'))} replace />;
  if (auth.phase === 'ready' && (['/', '/app', '/account'].includes(location.pathname) || isHistoryRoute(location.pathname) || isMoneyRoute(location.pathname))) {
    if (location.pathname === '/') return <Navigate to="/app" replace />;
    return <Workspace key={auth.session!.user.id} />;
  }
  if (auth.phase === 'anonymous' && location.pathname !== '/login') return <Navigate replace
    to={`/login${returnPath(location.pathname) === '/app' ? '' : `?returnTo=${returnPath(location.pathname)}`}`} />;
  const checking = auth.phase === 'restoring' || auth.phase === 'signingOut';
  return <><Header />
    {location.pathname === '/login' && (auth.phase === 'anonymous' || auth.phase === 'ready') ? <Login />
      : auth.phase === 'ready' ? <main id="main" className="access-page"><section><h1>Page not found</h1><p>That page isn’t available.</p><Link to="/app">Return to your plan</Link></section></main>
        : <main id="main" className="recovery-page"><Recovery busy={checking || retrying}
          title={auth.phase === 'signingOut' ? 'Signing out…' : checking ? 'Opening your plan…' : auth.phase === 'logoutUncertain' ? 'Let’s finish signing out.' : 'Your saved plan is safe.'}
          message={auth.phase === 'signingOut' ? 'Your figures are hidden on this device.' : checking ? 'Your figures stay private while we get things ready.' : auth.message}>
          {!checking && <>
            <button className="primary" disabled={retrying} onClick={() => void retry()}>{retrying ? 'Trying again…' : 'Retry connection'}</button>
            <button className="quiet" onClick={() => void auth.logout()}>{auth.phase === 'logoutUncertain' ? 'Retry sign out' : 'Sign out'}</button>
          </>}
        </Recovery></main>}
    <footer className="site-footer">You stay in control. No payments are made.</footer>
  </>;
}

export function App() {
  return <AuthProvider><AccessRoutes /><ToastViewport /></AuthProvider>;
}

export function RouteError() {
  return <><a className="skip-link" href="#main">Skip to main content</a><header className="site-header"><Brand /></header>
    <main id="main" className="recovery-page"><Recovery title="Let’s try that again." message="Try opening your plan again. Your saved figures won’t be changed.">
      <a className="button primary" href="/app">Try again</a>
    </Recovery></main>
    <footer className="site-footer">You stay in control. No payments are made.</footer>
  </>;
}