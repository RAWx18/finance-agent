// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useBlocker, useLocation, useNavigate } from 'react-router';
import { AuthProvider, useAuth } from './Auth';
import { Account } from './Account';
import { Login, returnPath } from './Login';
import { MoneyPage } from './MoneyPage';
import { isMoneyRoute, moneyRoutes } from './moneyRoutes';
import { dismiss, notify, ToastViewport } from './Toast';
import { useSession } from './session';
import { Conversation } from './Conversation';
import type { VoicePhase } from './Conversation';
import { FinancialContext } from './FinancialContext';
import { History } from './History';
import { isConversationRoute, isHistoryRoute } from './historyRoutes';
import { authEpoch, conversationError } from './api';
import { Details } from './Dialog';
import { Recovery } from './Recovery';
import { ProfileMenu } from './ProfileMenu';
import brandIcon from './brand.svg?no-inline';

type Journey = 'landing' | 'ready' | 'session';

function Workspace() {
  const location = useLocation();
  const route = useNavigate();
  const routeSlug = isConversationRoute(location.pathname) && location.pathname !== '/app' ? location.pathname.slice(5) : null;
  const session = useSession();
  const { state, dispatch, perform, retryConnection, selectConversation } = session;
  const { snapshot, settings } = state;
  const heading = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState<Journey>(routeSlug ? 'ready' : 'landing');
  const [activeChat, setActiveChat] = useState<{ slug: string; sessionId: string }>();
  const [startRequest, setStartRequest] = useState<{ id: string; slug: string }>();
  const [observedPath, setObservedPath] = useState(location.pathname);
  if (observedPath !== location.pathname) {
    setObservedPath(location.pathname);
    if (startRequest && location.pathname !== `/app/${startRequest.slug}`) setStartRequest(undefined);
  }
  const [selection, setSelection] = useState<{ path: string; error?: string }>();
  const routeSelection = useRef<{ path: string; controller: AbortController } | null>(null);
  const path = useRef(location.pathname);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const moneyOpen = isMoneyRoute(location.pathname);
  const [moneyEditing, setMoneyEditing] = useState(false);
  const accountOpen = location.pathname === '/account';
  const historyOpen = isHistoryRoute(location.pathname);
  const conversationVisible = isConversationRoute(location.pathname);
  const conversationSlug = snapshot?.conversationSlug ?? (activeChat?.sessionId === snapshot?.sessionId ? activeChat?.slug : undefined);
  const selectingRoute = !!routeSlug && (conversationSlug !== routeSlug || selection?.path === location.pathname);
  const stale = state.connection !== 'live' || state.phase !== 'ready';
  const expired = state.phase === 'expired' || state.phase === 'deleted';
  const terminal = expired || state.phase === 'unavailable' || state.phase === 'unreadable';
  const recovering = terminal || state.connection === 'reconnecting' && state.phase === 'ready';
  const fullRecovery = terminal && !snapshot && (conversationVisible || moneyOpen);
  const locked = stale || moneyEditing || !!state.pending || state.busy;
  const hasPicture = !!snapshot && (snapshot.facts.opening.amountPaise !== null || snapshot.facts.records.length > 0
    || Object.values(snapshot.facts.coverage).some(value => value !== 'notDiscussed')
    || !!snapshot.preview || !!snapshot.accepted || !!snapshot.facts.decision?.responses?.length);
  const running = ['connecting', 'active', 'ending'].includes(voicePhase);
  const stage = view === 'session' ? voicePhase === 'active' && hasPicture ? 'taking-shape' : voicePhase : view;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && (moneyEditing || (running || voiceBusy)
    && (isConversationRoute(currentLocation.pathname) || isHistoryRoute(currentLocation.pathname))
    && (!isConversationRoute(nextLocation.pathname) && !isHistoryRoute(nextLocation.pathname)
      || isConversationRoute(nextLocation.pathname) && nextLocation.pathname !== '/app' && nextLocation.pathname !== `/app/${conversationSlug}`)));
  const continueBlocked = running || voiceBusy ? 'End the current call and confirm it has closed before continuing a conversation.'
    : moneyEditing || state.pending || state.busy ? 'Finish the current correction or save before continuing a conversation.'
      : state.phase === 'loading' || !settings || stale && !(selection && (selection.error || selection.path !== location.pathname) || state.phase === 'empty') ? 'Reconnect your saved plan before continuing a conversation.' : undefined;

  useLayoutEffect(() => {
    path.current = location.pathname;
    if (routeSelection.current && routeSelection.current.path !== location.pathname) {
      routeSelection.current.controller.abort(); routeSelection.current = null;
    }
  }, [location.pathname]);
  useEffect(() => () => routeSelection.current?.controller.abort(), []);

  async function continueChat(slug: string, signal: AbortSignal) {
    if (continueBlocked) return;
    const from = location.pathname;
    const epoch = authEpoch();
    setSelection({ path: from });
    try {
      const selected = await session.selectConversation(slug, signal);
      if (!selected || signal.aborted || epoch !== authEpoch() || path.current !== from) return;
      setSelection(undefined); setView('ready');
      setStartRequest({ id: crypto.randomUUID(), slug });
      void route(`/app/${slug}`);
    } catch (error) {
      if (!signal.aborted && epoch === authEpoch() && path.current === from) setSelection({ path: from, error: conversationError(error) });
      throw error;
    }
  }

  useEffect(() => {
    if (!routeSlug || !selectingRoute || selection?.path === location.pathname || !settings || state.phase === 'loading'
      || running || voiceBusy || moneyEditing || state.pending || state.busy || routeSelection.current?.path === location.pathname) return;
    const controller = new AbortController();
    const from = location.pathname;
    const epoch = authEpoch();
    routeSelection.current = { path: from, controller };
    void selectConversation(routeSlug, controller.signal).then(selected => {
      if (selected && !controller.signal.aborted && epoch === authEpoch() && path.current === from) {
        setSelection(undefined); setView('ready');
      }
    }).catch(error => {
      if (!controller.signal.aborted && epoch === authEpoch() && path.current === from)
        setSelection({ path: from, error: conversationError(error) });
    });
  }, [routeSlug, selectingRoute, selection?.path, location.pathname, settings, state.phase, state.busy, state.pending, voiceBusy, running, moneyEditing, selectConversation]);

  useEffect(() => {
    if (location.pathname === '/app' && conversationSlug) void route(`/app/${conversationSlug}`, { replace: true });
  }, [location.pathname, conversationSlug, route]);
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
          onClick: async () => { await actions.current.perform('save'); } } });
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
    document.getElementById(id)?.focus({ preventScroll: true });
  }, [location.pathname, moneyOpen, accountOpen, historyOpen]);

  function navigate(next: Journey) {
    setView(next);
    if (!conversationVisible) void route(conversationSlug ? `/app/${conversationSlug}` : '/app');
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  function voiceChanged(phase: VoicePhase) {
    setVoicePhase(phase);
    if (phase === 'idle') return;
    setView('session');
  }

  return <>
    <Header voiceBusy={running || voiceBusy} hasDraft={moneyEditing} />
    <main id="main" className={`product-main${fullRecovery ? ' recovery-page' : ''}`} data-view={view} data-stage={stage} data-route={location.pathname}>
      <p className="sr-only" role="status">{state.messageKind === 'status' && !moneyOpen && !recovering ? state.message : ''}</p>
      <div className="page-feedback" hidden={accountOpen || historyOpen || selectingRoute || !recovering && state.phase !== 'loading'}>
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
      {state.phase === 'loading' && <p className="sr-only" role="status">Loading…</p>}
      </div>

      {selectingRoute && <Recovery inline busy={selection?.path === location.pathname && !selection.error}
        title={selection?.error ? 'Couldn’t open this conversation.' : 'Opening your conversation…'}
        message={selection?.error ?? continueBlocked ?? 'Your microphone stays off until you choose to talk.'}>
        {selection?.error && <button onClick={() => { setSelection({ path: '', error: selection.error }); routeSelection.current = null; }}>Retry opening conversation</button>}
        <Link to="/history">Choose another conversation</Link>
        {(voiceBusy || running) && <Link to="/app">Return to current conversation</Link>}
      </Recovery>}
      <div hidden={!conversationVisible || fullRecovery || selectingRoute} className={`journey-layout ${view === 'landing' ? 'welcome-layout' : 'live-layout'} no-print`}>
        <div className="conversation-pane">
          <div className={`journey-intro${view === 'ready' || view === 'session' ? ' sr-only' : ''}`}>
            {view === 'landing' && <p className="eyebrow">Your next 30 days</p>}
            <h1 id="page-heading" tabIndex={-1} ref={heading}>{view === 'landing' ? <>Talk it through.<br /><span>See your next 30 days clearly.</span></> : 'Let’s talk it through.'}</h1>
          </div>
          <div className="voice-container">
            <Conversation settings={settings} sessionId={snapshot?.sessionId}
              conversationSlug={conversationSlug}
              startRequest={startRequest && startRequest.slug === conversationSlug && routeSlug === startRequest.slug ? startRequest.id : undefined}
              onStartConsumed={() => setStartRequest(undefined)}
              onConversationChange={(slug, sessionId) => setActiveChat({ slug, sessionId })}
              presentation={view === 'landing' ? 'landing' : view === 'ready' ? 'ready' : 'session'}
              disabled={selectingRoute || state.busy || !!state.pending || moneyEditing || !['empty', 'ready'].includes(state.phase) || !!snapshot && stale}
              onStarted={value => dispatch({ type: 'started', snapshot: value })} onBusyChange={setVoiceBusy}
              onTranscriptChange={value => { if (!value.interim && !value.captions.at(-1)?.pending) setHistoryRevision(version => version + 1); }}
              onPrepare={() => navigate('ready')} onPhaseChange={voiceChanged}
              visible={conversationVisible && !fullRecovery && !selectingRoute}
              updatesReady={state.connection === 'live' && state.phase === 'ready'}
              updatesLost={!!snapshot && (state.connection === 'reconnecting' || state.phase !== 'ready')}
              sessionIssue={state.phase === 'expired' || state.phase === 'deleted' || state.phase === 'unreadable' ? state.phase : undefined}
              onSettings={value => dispatch({ type: 'settings', settings: value })} />
          </div>
          {view === 'ready' && <div className="conversation-navigation">
            <button className="quiet back-link" disabled={voiceBusy} onClick={() => navigate('landing')}>Back to welcome</button>
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
          <FinancialContext snapshot={snapshot} stale={!!snapshot && stale}
            locked={locked} onCommand={operation => perform('save', operation)} proposalActive={conversationVisible} />
        </div>}
      </div>

      <MoneyPage session={session} active={moneyOpen && !fullRecovery} voiceBusy={voiceBusy || running} onEditing={setMoneyEditing} />
      {accountOpen && <Account />}
      {historyOpen && <History timezone={settings?.timezone} assistantName={settings?.assistantName} ongoing={running}
        continueBlocked={continueBlocked} onContinue={continueChat}
        revision={`${historyRevision}:${voicePhase}:${state.phase}:${snapshot?.sessionId ?? ''}`} />}
    </main>
    <footer className="site-footer no-print"><span>No payments are made.</span><Details label="Privacy">
      <h3>Information stored</h3>
      <p>Cash flow stores your Google sign-in details, profile, financial information, plans, corrections and text conversations. Saved preferences and context may be used in later conversations. The application does not save audio recordings, receive your Google password, connect to bank accounts or make payments.</p>
      <h3>Service providers</h3>
      <p>Google provides sign-in. Daily carries live calls. Azure Speech processes audio and spoken replies. Azure OpenAI processes conversation and financial context, including your display name and saved notes, to generate responses. Provider processing and retention are governed by their applicable policies; application deletion does not guarantee deletion of provider-held data.</p>
      <h3>Retention and deletion</h3>
      <p>{settings ? `Plans and associated conversations expire ${settings.retentionHours} hours after plan creation and are removed during expiry cleanup. ` : 'Plans and associated conversations are removed during configured expiry cleanup. '}Account-level context expires separately; saved preferences remain until forgotten or the account is deleted.</p>
      <p>Deleting a plan removes its conversations and chat notes, but not account-level preferences or context. Deleting your account removes its saved application records. Signing out does not delete saved data. You may ask the assistant to forget a saved note; this does not erase the conversation in which it appeared.</p>
      <p>Do not provide passwords, bank account numbers or full payment-card details.</p>
    </Details></footer>
  </>;
}

function Brand() {
  const { pathname } = useLocation();
  useEffect(() => {
    const page = isMoneyRoute(pathname) ? moneyRoutes[pathname] : pathname === '/account' ? 'Settings'
      : isHistoryRoute(pathname) ? 'History' : isConversationRoute(pathname) ? 'Your 30-day plan' : '';
    document.title = page ? `${page} · Cash flow` : 'Cash flow';
  }, [pathname]);
  return <Link className="brand" to="/app" aria-label="Cash flow home"><img src={brandIcon} alt="" width="28" height="28" /><span>Cash flow</span></Link>;
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
  if (auth.phase === 'ready' && (['/', '/account'].includes(location.pathname) || isConversationRoute(location.pathname) || isHistoryRoute(location.pathname) || isMoneyRoute(location.pathname))) {
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