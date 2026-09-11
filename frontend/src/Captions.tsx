// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useLayoutEffect, useRef, useState } from 'react';
import './captions.css';

export type Caption = {
  id: string; speaker: 'You' | 'Assistant'; text: string; time: number;
  pending?: boolean; interrupted?: boolean;
};

function CaptionTime({ time, timezone }: { time: number; timezone?: string }) {
  const stamp = new Date(time);
  if (!Number.isFinite(stamp.getTime())) return null;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' });
  const label = `${date.format(time)} (${timezone ?? clock.resolvedOptions().timeZone})`;
  return <time dateTime={stamp.toISOString()} title={label} aria-label={label}>{clock.format(time)}</time>;
}

export const Captions = memo(function Captions({ captions, interim, timezone }: {
  captions: Caption[]; interim?: { text: string; time: number } | null; timezone?: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const latest = useRef<HTMLButtonElement>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  const ordered = [...captions].sort((a, b) => a.time - b.time);
  const current: Omit<Caption, 'id'> | undefined = interim?.text ? { ...interim, speaker: 'You', pending: true } : captions.at(-1);
  const history = ordered.filter(item => item !== current);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const selection = document.getSelection();
    const reading = element.contains(document.activeElement) || !!selection && !selection.isCollapsed
      && (element.contains(selection.anchorNode) || element.contains(selection.focusNode));
    if (!captions.length && !interim?.text) {
      element.scrollTop = 0;
      following.current = true;
      setUnread(false);
    } else if (following.current && !reading) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (document.activeElement !== latest.current) setUnread(false);
    } else {
      following.current = false;
      setUnread(true);
    }
  }, [captions, interim]);

  return <div className="captions">
    <section className="live-caption" aria-label="Live caption" data-speaker={current?.speaker} tabIndex={0}>
      <header className="caption-heading">
        <h3>{current ? `${current.speaker}${current.interrupted ? ' · interrupted' : current.pending ? interim?.text ? ' · still being transcribed' : ' · spoken so far' : ''}` : 'Live caption'}</h3>
        {current && <CaptionTime time={current.time} timezone={timezone} />}
      </header>
      <p>{current?.text ?? 'Captions appear as you speak'}</p>
    </section>
    <section className="caption-history" aria-label="Caption history">
      <header className="captions-heading">
        <h3>Caption history</h3>
        {unread && <button ref={latest} type="button" className="quiet" onClick={() => {
          const element = scroll.current;
          if (!element) return;
          element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          following.current = true;
        }} onBlur={() => { if (following.current) setUnread(false); }}>Latest captions</button>}
      </header>
      <div ref={scroll} className="caption-history-scroll" role="region" aria-label="Earlier captions" tabIndex={0} onScroll={event => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
        if (following.current && document.activeElement !== latest.current) setUnread(false);
      }}>
        <ol className="transcript" aria-label="Conversation transcript">{history.map(item => <li key={item.id} data-speaker={item.speaker}>
          <header className="caption-heading"><strong>{item.speaker}{item.interrupted ? ' · interrupted' : item.pending ? ' · spoken so far' : ''}</strong><CaptionTime time={item.time} timezone={timezone} /></header>
          <p>{item.text}</p>
        </li>)}</ol>
      </div>
    </section>
  </div>;
});