// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { memo } from 'react';
import './captions.css';

export type Caption = {
  id: string; speaker: 'You' | 'Assistant'; text: string; time: number;
  pending?: boolean; interrupted?: boolean;
};

export type Transcript = { captions: Caption[]; interim: { text: string; time: number } | null };

/** Display a caption's clock time with its full date and timezone available accessibly. */
export function CaptionTime({ time, timezone }: { time: number; timezone?: string }) {
  const stamp = new Date(time);
  if (!Number.isFinite(stamp.getTime())) return null;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' });
  const label = `${date.format(time)} (${timezone ?? clock.resolvedOptions().timeZone})`;
  return <time dateTime={stamp.toISOString()} title={label} aria-label={label}>{clock.format(time)}</time>;
}

/** Present the latest spoken or interim caption with its speaker and timestamp. */
export const LiveCaption = memo(function LiveCaption({ captions, interim, timezone, assistantName = 'Assistant' }: {
  captions: Caption[]; interim?: Transcript['interim']; timezone?: string; assistantName?: string;
}) {
  const current = interim?.text ? { ...interim, speaker: 'You', pending: true, interrupted: false } : captions.at(-1);
  return <section className="live-caption" aria-label="Live caption" data-speaker={current?.speaker} tabIndex={0}>
    {current ? <><header className="caption-heading"><h3>{current.speaker === 'Assistant' ? assistantName : current.speaker}{current.interrupted ? ' · interrupted' : ''}</h3>
      <CaptionTime time={current.time} timezone={timezone} /></header><p>{current.text}</p></> : <p className="caption-empty">Captions appear here</p>}
  </section>;
});