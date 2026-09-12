// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { MoneyInput, Plan, Snapshot } from './api';
import { amountStatus, dateLabel, money, sourceDescription, timestamp } from './money';
import { PagedList } from './PagedList';

/** Separates retained capture values from server-supplied planning estimates. */
export function ExchangeValues({ source, capturedPaise, currentMoney, event, plan, monthly = false }: {
  source: MoneyInput; capturedPaise?: number | null; currentMoney?: Snapshot['facts']['opening']; event?: Plan['events'][number]; plan: Plan; monthly?: boolean;
}) {
  const conversion = source.conversion;
  if (!conversion) return null;
  const current = currentMoney?.source?.conversion;
  const reference = current?.provider === 'frankfurter' || conversion.provider === 'frankfurter';
  const unavailable = reference && !!current && (current.rate == null || current.rateStatus === 'unknown');
  return <div className="card-meta">
    <p>Captured INR: {capturedPaise === undefined ? 'Not supplied for this occurrence' : money(capturedPaise)}</p>
    <p>{reference ? 'Today’s approximate INR' : 'Current INR'}: <strong>{money(currentMoney?.amountPaise ?? null)}</strong>{monthly && ' · Full monthly amount'}{!reference && currentMoney && ` · ${amountStatus[currentMoney.status]}`}</p>
    {event?.amountBasis === 'budget' && <p>Daily forecast share: {money(event.amountPaise)} · {dateLabel(event.date)} · not the full monthly amount or a payment due.</p>}
    {event?.amountBasis === 'assumed' && <p>Accepted occurrence amount: {money(event.amountPaise)} · {dateLabel(event.date)} · Saved assumption, not paid.</p>}
    {reference && conversion.direction !== 'valuation' && (current ?? conversion).fee == null && <p className="card-caution">Planning estimate excludes unknown conversion fees; fees are not assumed to be zero.</p>}
    {unavailable && <p className="card-caution">Exchange rate unavailable; conversion needs retry. Automatic retry is next day, subject to the daily limit.</p>}
    {!currentMoney && <p>Current INR not supplied by the server.</p>}
    <details className="card-terms"><summary>Exchange rate details</summary>
      <p>Captured conversion · {sourceDescription(source)}</p>
      {conversion.fetchedAt && <p>Captured rate retrieved {timestamp(conversion.fetchedAt, 'UTC')} UTC</p>}
      {currentMoney?.source && <p>Planning conversion · {sourceDescription(currentMoney.source)}</p>}
      {current?.fetchedAt && <p>Planning rate retrieved {timestamp(current.fetchedAt, 'UTC')} UTC</p>}
      {reference && plan.exchangeCheckedOn && <p>Exchange checked on {dateLabel(plan.exchangeCheckedOn)}. Reference-rate dates may precede the check date.</p>}
      {reference && <p>Frankfurter reference rates are estimates, not actual bank rates or net quotes. Only the currency pair is sent to Frankfurter by the backend, not your amounts or financial details.</p>}
    </details>
  </div>;
}

/** Shows reported conversion terms or ordered occurrence amounts and their calculated INR values. */
export function MoneySources({ record, snapshot }: { record: Snapshot['facts']['records'][number]; snapshot: Snapshot }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const event = plan.events.find(event => event.recordId === record.id);
  const current = plan.planningFacts.records.find(item => item.id === record.id);
  const basis = event?.amountBasis ?? plan.undatedImpact?.items.find(item => item.recordId === record.id)?.amountBasis;
  const primary = record.kind === 'debt' && record.target && basis !== 'requiredOnly' && basis !== 'requiredFloor' ? 'target' : 'amount';
  const fields = primary === 'target' ? ['target', 'amount', 'outstanding'] as const : ['amount', 'target', 'outstanding'] as const;
  return <>
    {fields.map(field => {
      const captured = record[field];
      if (field === 'amount' && record.schedule.amounts?.length || !captured?.source?.conversion) return null;
      return <div key={field}>{record.kind === 'debt' && <p>{field === 'target' ? 'Intended payment' : field === 'outstanding' ? 'Outstanding balance' : 'Required / minimum payment'}</p>}
        <ExchangeValues source={captured.source} capturedPaise={captured.amountPaise} currentMoney={current?.[field] ?? undefined} event={field === primary ? event : undefined} plan={plan} monthly={record.schedule.recurrence === 'monthlyBudget'} /></div>;
    })}
    {basis === 'requiredFloor' && <p className="card-caution">Current required / minimum payment exceeds the chosen target. The minimum is counted; your target is retained.</p>}
    {!!record.schedule.amounts?.length && <PagedList label={`${record.label} ordered amounts`} className="evidence-list" pageSize={5} ordered>{record.schedule.amounts.map((amount, index) => {
    const event = plan.events.find(event => event.recordId === record.id && event.scheduleIndex === index);
    return <li key={index}>Occurrence {index + 1}: {amount.conversion ? <>
      {amount.conversion.currency} {amount.amount ?? 'Unknown amount'}<ExchangeValues source={amount} currentMoney={plan.occurrenceAmounts?.[record.id]?.[index]} event={event} plan={plan} /></>
      : <>{amount.amount == null ? 'Unknown' : `₹${amount.amount}`} · {amountStatus[amount.status]}</>}</li>;
  })}</PagedList>}
  </>;
}