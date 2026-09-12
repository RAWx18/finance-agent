// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from '@assistant-ui/react';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { api, ApiError, authEpoch, conversationError } from './api';
import type { ConversationMessage, ConversationSummary, SavedConversation } from './api';
import { DaySeparator } from './components/assistant-ui/elements/daySeparator';
import { ThreadList } from './components/assistant-ui/elements/threadList';
import { MoneyIcon } from './MoneyIcon';
import { CallIcon } from './CallIcon';
import './history.css';
import './components/assistant-ui/elements/history.css';

const convertMessage = (message: ConversationMessage): ThreadMessageLike => ({
  id: message.id, role: message.role, content: [{ type: 'text', text: message.text }], createdAt: new Date(message.createdAt),
});

export function History({ timezone, assistantName = 'Assistant', revision = '', ongoing = false, continueBlocked, onContinue }: {
  timezone?: string; assistantName?: string; revision?: string; ongoing?: boolean;
  continueBlocked?: string; onContinue?: (slug: string, signal: AbortSignal) => Promise<void>;
}) {
  const { pathname } = useLocation();
  const slug = pathname.startsWith('/history/') ? pathname.slice('/history/'.length) : null;
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const [retry, setRetry] = useState(0);
  const version = `${revision}:${retry}`;
  const [list, setList] = useState<{ query: string; version: string; observedAt: number; conversations: ConversationSummary[]; error?: boolean }>();
  const loading = list?.query !== query || list.version !== version;
  const conversations = list?.query === query ? list.conversations : [];
  const error = !loading && list?.error;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short' });
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  useEffect(() => {
    const controller = new AbortController();
    void api.history.list(query, controller.signal).then(value => {
      if (!controller.signal.aborted) setList({ query, version, observedAt: Date.now(), conversations: value.conversations });
    }).catch(() => {
      if (!controller.signal.aborted) setList({ query, version, observedAt: Date.now(), conversations: [], error: true });
    });
    return () => controller.abort();
  }, [query, version]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setRetry(value => value + 1); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  return <section className="history-page no-print" aria-label="History" data-selected={!!slug}>
    <aside className="history-sidebar" aria-label="Conversation history">
      <header className="history-sidebar-heading"><h1 id="history-heading" tabIndex={-1}>History</h1>
        <Link className="history-icon" to="/app" aria-label={ongoing ? 'Return to call' : `Talk to ${assistantName}`} title={ongoing ? 'Return to call' : `Talk to ${assistantName}`}><MoneyIcon name={ongoing ? 'back' : 'add'} /></Link>
      </header>
      <label className="history-search"><span className="sr-only">Search conversations</span><MoneyIcon name="search" />
        <input type="search" placeholder="Search conversations" value={search} onChange={event => setSearch(event.target.value)} />
      </label>
      <nav className="history-list-scroll" aria-label="Saved conversations" aria-busy={loading}>
        {loading && !conversations.length ? <p className="history-list-state" role="status">Loading conversations…</p>
          : error ? <div className="history-list-state" role="status"><p>Couldn’t load history.</p><button className="quiet" onClick={() => setRetry(value => value + 1)}>Try again</button></div>
            : conversations.length ? <ThreadList activeIndex={conversations.findIndex(item => item.slug === slug)} threads={conversations.map(item => ({
              id: item.slug, title: item.title, time: date.format(new Date(item.startedAt)) === date.format(list!.observedAt)
                ? clock.format(new Date(item.startedAt)) : date.format(new Date(item.startedAt)), href: `/history/${item.slug}`,
            }))} />
              : <div className="history-list-state" role="status"><p>{query ? 'No matching conversations.' : 'No conversations yet.'}</p>
                {query && <button className="quiet" onClick={() => setSearch('')}>Clear search</button>}</div>}
      </nav>
      <Link className="history-return" to="/app"><MoneyIcon name="back" />{ongoing ? 'Return to call' : `Talk to ${assistantName}`}</Link>
    </aside>
    <div className="history-main">
      {slug ? <SavedChat key={slug} slug={slug} timezone={timezone} assistantName={assistantName} revision={version}
        continueBlocked={continueBlocked ?? (ongoing ? 'End the current call before continuing another conversation.' : undefined)} onContinue={onContinue} />
        : <div className="history-empty"><span className="history-avatar" aria-hidden="true">{Array.from(assistantName)[0]}</span><h2>Your conversations with {assistantName}</h2><p>Choose a conversation to read it.</p></div>}
    </div>
  </section>;
}

function SavedChat({ slug, timezone, assistantName, revision, continueBlocked, onContinue }: {
  slug: string; timezone?: string; assistantName: string; revision: string;
  continueBlocked?: string; onContinue?: (slug: string, signal: AbortSignal) => Promise<void>;
}) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ conversation?: SavedConversation; error?: 'unavailable' | 'gone' }>();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const download = useRef<AbortController | null>(null);
  const selection = useRef<AbortController | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState('');
  const title = useRef<HTMLHeadingElement>(null);
  const conversation = result?.conversation;

  useEffect(() => {
    const controller = new AbortController();
    void api.history.get(slug, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ conversation: value });
    }).catch(error => {
      if (!controller.signal.aborted) {
        const gone = error instanceof ApiError && [404, 410].includes(error.status);
        if (gone) download.current?.abort();
        setResult({ error: gone ? 'gone' : 'unavailable' });
      }
    });
    return () => controller.abort();
  }, [slug, revision, retry]);

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    return () => { download.current?.abort(); selection.current?.abort(); };
  }, [slug]);

  useEffect(() => {
    if (!conversation) return;
    const timer = setTimeout(() => { download.current?.abort(); selection.current?.abort(); setResult({ error: 'gone' }); }, Math.max(0, Date.parse(conversation.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [conversation]);

  async function continueTalking() {
    if (!onContinue || !conversation || continueBlocked || selection.current) return;
    const controller = new AbortController();
    const epoch = authEpoch();
    selection.current = controller;
    setContinuing(true); setContinueError('');
    try { await onContinue(slug, controller.signal); }
    catch (error) {
      if (!controller.signal.aborted && epoch === authEpoch()) setContinueError(conversationError(error));
    } finally {
      if (!controller.signal.aborted) { selection.current = null; setContinuing(false); }
    }
  }

  async function downloadCaptions() {
    if (download.current || !conversation?.messages.length) return;
    const controller = new AbortController();
    download.current = controller;
    const epoch = authEpoch();
    setDownloading(true); setDownloadError(false);
    try {
      const text = await api.history.transcript(slug, controller.signal);
      if (controller.signal.aborted || epoch !== authEpoch()) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `${slug}-captions.txt`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!controller.signal.aborted && epoch === authEpoch()) {
        if (error instanceof ApiError && [404, 410].includes(error.status)) setResult({ error: 'gone' });
        else setDownloadError(true);
      }
    } finally {
      if (!controller.signal.aborted) { download.current = null; setDownloading(false); }
    }
  }

  return <>
    <header className="history-chat-heading">
      <Link className="history-icon history-back" to="/history" aria-label="All conversations" title="All conversations"><MoneyIcon name="back" /></Link>
      <div className="history-chat-title"><h2 id="history-conversation-heading" ref={title} tabIndex={-1}>{conversation?.title ?? 'Conversation'}</h2>
        {conversation && <p>{new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(conversation.startedAt))} · {assistantName} & you</p>}
      </div>
      {conversation && <div className="history-chat-actions">
        <button className="history-continue" disabled={!onContinue || !!continueBlocked || continuing} aria-busy={continuing}
          aria-describedby={continueError || continueBlocked ? 'history-continue-status' : undefined} onClick={() => void continueTalking()}>
          <CallIcon kind="call" /><span>{continuing ? 'Opening…' : 'Continue talking'}</span>
        </button>
        {!!conversation.messages.length && <button className="history-download" disabled={downloading} aria-label={downloading ? 'Preparing captions' : 'Download captions'}
          title="Download captions" onClick={() => void downloadCaptions()}><MoneyIcon name="download" /><span>{downloading ? 'Preparing…' : 'Download captions'}</span></button>}
      </div>}
    </header>
    {(continueError || continueBlocked) && <p id="history-continue-status" className="history-download-error" role="status">{continueError || continueBlocked}</p>}
    {downloadError && <p className="history-download-error" role="status">Couldn’t download captions. Please try again.</p>}
    {!result ? <div className="history-empty" role="status"><p>Loading conversation…</p></div>
      : result.error ? <div className="history-empty" role="status"><h3>{result.error === 'gone' ? 'Conversation unavailable' : 'Couldn’t open this conversation'}</h3>
        <p>{result.error === 'gone' ? 'It may have been deleted or expired.' : 'Please try again.'}</p>
        {result.error === 'unavailable' && <button className="quiet" onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>Try again</button>}
        <Link to="/history">All conversations</Link></div>
        : conversation?.messages.length ? <ChatMessages conversation={conversation} timezone={timezone} assistantName={assistantName} />
          : <div className="history-empty" role="status"><h3>No captions saved</h3><p>This conversation has no stored messages.</p></div>}
  </>;
}

function ChatMessages({ conversation, timezone, assistantName }: { conversation: SavedConversation; timezone?: string; assistantName: string }) {
  const runtime = useExternalStoreRuntime({ messages: conversation.messages, convertMessage, isDisabled: true,
    onNew: async () => { throw new Error('Saved conversations are read-only.'); } });
  const dated = useMemo(() => {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'long' });
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return conversation.messages.map(message => ({ ...message, day: day.format(new Date(message.createdAt)), time: time.format(new Date(message.createdAt)), dateTime: message.createdAt }));
  }, [conversation.messages, timezone]);

  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="history-thread">
      <ThreadPrimitive.Viewport className="history-viewport" role="region" aria-label="Conversation messages" tabIndex={0}
        autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false} scrollToBottomOnRunStart={false}>
        <DaySeparator messages={dated} assistantName={assistantName} />
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom className="history-latest" behavior="auto">Latest messages <span aria-hidden="true">↓</span></ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}