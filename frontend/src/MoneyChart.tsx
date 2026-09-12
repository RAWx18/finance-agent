// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from 'react';
import type { Snapshot } from './api';
import { dateLabel, lastDate, money } from './money';

export function MoneyChart({ snapshot }: { snapshot: Snapshot }) {
  const id = useId().replaceAll(':', '');
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const opening = snapshot.facts.opening.amountPaise;
  const events = plan.events.filter(event => event.included && event.balancePaise !== null);
  if (opening === null || !events.length || plan.closingPaise === null) return <div className="money-chart-empty">
    <span className="money-chart-placeholder" aria-hidden="true" />
    <p>{opening === null ? 'Add your starting cash to see the picture.' : 'Add an income date or payment to see your cash flow.'}</p>
  </div>;

  const start = Date.parse(snapshot.anchorDate);
  const end = Date.parse(snapshot.endDateExclusive);
  const points = [{ date: snapshot.anchorDate, balance: opening }, ...events.map(event => ({ date: event.date, balance: event.balancePaise! })), { date: snapshot.endDateExclusive, balance: plan.closingPaise }];
  const high = Math.max(0, snapshot.facts.reservePaise, ...points.map(point => point.balance));
  const low = Math.min(0, ...points.map(point => point.balance));
  const range = Math.max(100, high - low);
  const x = (date: string) => 6 + (Date.parse(date) - start) / (end - start) * 628;
  const y = (amount: number) => 16 + (high - amount) / range * 158;
  // Event order preserves an intraday low even when a later receipt recovers on the same date.
  const path = points.map((point, index) => `${index ? 'H' : 'M'} ${x(point.date).toFixed(2)} ${index ? 'V' : ''} ${y(point.balance).toFixed(2)}`).join(' ');
  const zero = y(0);
  const area = `${path} V ${zero} H 6 Z`;
  const first = plan.firstGap;
  const timing = plan.timingRisks?.find(item => item.date === first?.date);
  const axis = (amount: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 }).format(amount / 100);
  return <figure className="money-chart">
    <div className="money-chart-plot">
      <div className="money-chart-axis" aria-hidden="true">{high > 0 && <span style={{ top: `${y(high) / 190 * 100}%` }}>{axis(high)}</span>}<span style={{ top: `${zero / 190 * 100}%` }}>₹0</span>{low < 0 && <span style={{ top: `${y(low) / 190 * 100}%` }}>{axis(low)}</span>}</div>
      <svg viewBox="0 0 640 190" preserveAspectRatio="none" role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
        <title id={`${id}-title`}>Projected cash over 30 days</title>
        <desc id={`${id}-description`}>Starting cash {money(opening)}. {first ? timing ? `Timing exposure ${money(timing.exposurePaise)} on ${dateLabel(first.date)} if payments leave before same-day income. ${money(timing.remainingGapPaise)} remains unfunded after included income.` : `First shortfall ${money(first.amountPaise)} on ${dateLabel(first.date)}.` : 'No shortfall in the dated figures.'} Largest conservative gap {money(plan.peakGapPaise)}{plan.peakGapDate && ` on ${dateLabel(plan.peakGapDate)}`}. Projected closing cash {money(plan.closingPaise)}. Same-day payments precede income. This is a forecast, not your bank balance. {(snapshot.workspace?.results?.find(result => result.id === 'closing')?.qualifications ?? []).join(' ')}</desc>
        <defs>
          <clipPath id={`${id}-positive`}><rect width="640" height={Math.max(0, zero)} /></clipPath>
          <clipPath id={`${id}-negative`}><rect y={zero} width="640" height={Math.max(0, 190 - zero)} /></clipPath>
        </defs>
        {low < 0 && <rect className="money-chart-danger" x="0" y={zero} width="640" height={190 - zero} />}
        <line className="money-chart-grid" x1="0" x2="640" y1={y(high)} y2={y(high)} />
        <path className="money-chart-area" d={area} clipPath={`url(#${id}-positive)`} />
        <path className="money-chart-area is-short" d={area} clipPath={`url(#${id}-negative)`} />
        <line className="money-chart-zero" x1="0" x2="640" y1={zero} y2={zero} />
        {snapshot.facts.reservePaise > 0 && <line className="money-chart-buffer" x1="0" x2="640" y1={y(snapshot.facts.reservePaise)} y2={y(snapshot.facts.reservePaise)} />}
        <path className="money-chart-line" d={path} clipPath={`url(#${id}-positive)`} />
        <path className="money-chart-line is-short" d={path} clipPath={`url(#${id}-negative)`} />
        {first && <line className="money-chart-marker" x1={x(first.date)} x2={x(first.date)} y1={zero} y2={y(-first.amountPaise)}><title>{timing ? 'Timing exposure' : 'First shortfall'}: {money(first.amountPaise)} · {dateLabel(first.date)}</title></line>}
      </svg>
    </div>
    <div className="money-chart-dates" aria-hidden="true"><span>{dateLabel(snapshot.anchorDate).replace(/ \d{4}$/, '')}</span><span>{dateLabel(lastDate(snapshot.endDateExclusive)).replace(/ \d{4}$/, '')}</span></div>
    <figcaption><span><i className="money-key" />Projected cash</span>{low < 0 && <span><i className="money-key is-short" />{plan.timingRisks?.length ? 'Funding / timing risk' : 'Shortfall'}</span>}{snapshot.facts.reservePaise > 0 && <span><i className="money-key is-buffer" />Cash buffer</span>}</figcaption>
  </figure>;
}