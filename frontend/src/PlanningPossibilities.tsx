// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from './api';
import { cardDate, cardMoney } from './cardFields';

/** Presents conditional comparisons for undated payments and unconfirmed income. */
export function PlanningPossibilities({ snapshot }: { snapshot: Snapshot }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const impact = plan.undatedImpact;
  const arrival = plan.incomeComparisons?.find(item => item.id === 'income:reportedDate');
  if (!impact && !arrival) return null;
  return <section className="planning-possibilities" aria-label="Planning possibilities">
    {impact && <div className="planning-allowance">
      <h3>Allow for payments without dates</h3>
      <p>{impact.outflowPaise > 0 ? <><strong>{cardMoney(impact.outflowPaise)}</strong> in possible payments beyond the dated forecast.</> : 'Amounts are visible below; a total needs the missing amounts or number of payments.'}</p>
      <p className="card-meta">What-if only: one payment for each monthly item and each one-off item, if still unpaid and due in this period. Not a maximum.</p>
      {impact.closingPaise !== null && impact.outflowPaise > 0 && <p className="planning-result">If these payments fall in this period: <strong>{cardMoney(impact.closingPaise)}</strong> {impact.closingPaise < 0 ? 'remaining — more money would be needed.' : 'remaining — dates still decide whether each payment fits.'}</p>}
      <ul className="planning-items">{impact.items.slice(0, 2).map(item => <li key={item.recordId}><strong>{item.label}</strong> · {cardMoney(item.amountPaise)}{item.status === 'estimate' && ' · Estimated amount'}{item.amountBasis === 'requiredOnly' && ' · Minimum only; intended total unknown'}{item.amountBasis === 'requiredFloor' && ' · Current minimum counted; chosen target retained'}</li>)}</ul>
      {!!impact.unknownRecordIds.length && <p className="card-caution">Some amounts or payment counts are still unknown, so the need may be higher.</p>}
      <details className="card-terms"><summary>Assumptions behind this comparison</summary>
        <ul>{impact.items.map(item => <li key={item.recordId}><strong>{item.label}</strong> · {cardMoney(item.amountPaise)} — {item.assumption}</li>)}</ul>
        <p>{impact.qualification}</p>
      </details>
    </div>}
    {arrival && <div className="planning-income">
      <h3>If expected income arrives</h3>
      <p>Dated end balance: <strong>{cardMoney(arrival.metrics.closingPaise)}</strong>. Compared with <strong>{cardMoney(plan.closingPaise)}</strong> without these unconfirmed receipts.</p>
      {impact && <p className="card-meta">Both figures are before the separate payments-without-dates comparison above.</p>}
      {arrival.metrics.firstGap && <p className="card-caution">A timing or funding gap of {cardMoney(arrival.metrics.firstGap.amountPaise)} remains on {cardDate(arrival.metrics.firstGap.date)} even in this scenario.</p>}
      <details className="card-terms"><summary>Which receipts this depends on</summary><ul>{arrival.conditions.map(condition => {
        const event = plan.events.find(event => event.id === condition.eventId);
        return event && <li key={event.id}>{event.label} · {cardMoney(event.amountPaise)} · {cardDate(event.date)}{event.dateAssumption && ' · Calculated date from your pattern'}</li>;
      })}</ul><p>These receipts are not guaranteed or counted in the main balance. Confirm availability before relying on them.</p></details>
    </div>}
  </section>;
}