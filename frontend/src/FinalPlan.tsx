// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from './api';
import { cardDate, cardMoney } from './cardFields';
import { financialText } from './money';
import { ResultQualification } from './PlanSummary';
import { ExchangeValues, MoneySources } from './MoneyValues';

/** Presents the settled 30-day outcome: headline, key figures, key dates, and the step to take, without the editable ledger. */
export function FinalPlan({ snapshot, onEdit }: { snapshot: Snapshot; onEdit: () => void }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const outcome = plan.decisionAssessment!.outcome!;
  const reserve = plan.decisionAssessment?.consequences?.find(item => item.kind === 'reserveBreach');
  const firstTiming = plan.timingRisks?.find(item => item.date === plan.firstGap?.date);
  const peakTiming = plan.timingRisks?.find(item => item.date === plan.peakGapDate);
  const peak = plan.firstGap && plan.peakGapPaise != null && plan.peakGapPaise > plan.firstGap.amountPaise;
  // The timeline card already selects the next material occurrence per record; the plan only orders those by date.
  const timeline = snapshot.workspace?.cards?.find(card => card.template === 'timeline');
  const keyDates = (timeline?.eventIds ?? []).flatMap(id => plan.events.find(event => event.id === id) ?? [])
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label)).slice(0, 4);
  const assumptions = [...new Map(plan.events.filter(event => event.dateAssumption).map(event => [event.recordId, `${event.label}: ${event.dateAssumption}`])).values()];
  const conversions = [plan.planningFacts.opening, ...plan.planningFacts.records.flatMap(record => [record.amount, record.target, record.outstanding]),
    ...Object.values(plan.occurrenceAmounts ?? {}).flat(), ...plan.planningFacts.providerResponses?.flatMap(response => [response.payment, response.cost]) ?? []]
    .flatMap(amount => amount?.source?.conversion?.provider === 'frankfurter' ? [amount.source.conversion] : []);
  const records = snapshot.facts.records.filter(record => [record.amount, record.target, record.outstanding].some(amount => amount?.source?.conversion)
    || record.schedule.amounts?.some(amount => amount.conversion));
  return <article className="final-plan" aria-label="Your 30-day plan" data-tone={plan.firstGap || plan.reserveShortfallPaise ? 'risk' : 'clear'}>
    <header className="final-plan-heading">
      <span className="final-plan-eyebrow">Plan ready · {cardDate(plan.evaluatedOn)}</span>
      <h3>Your 30-day plan</h3>
      <p className="final-plan-headline">{financialText(outcome.headline)}</p>
    </header>
    <dl className="final-plan-figures">
      <div className="final-plan-figure" aria-label="Projected closing cash">
        <dt>{plan.undatedImpact ? 'Closing cash · dated items only' : 'Closing cash'}</dt>
        <dd>{cardMoney(plan.closingPaise)}</dd>
        {plan.undatedImpact && <span className="card-meta">{cardMoney(plan.undatedImpact.closingPaise)} after the separate undated-payment allowance · what-if only, not payment timing</span>}
      </div>
      {plan.firstGap ? <div className="final-plan-figure" data-tone="risk" aria-label={firstTiming ? 'Timing risk' : 'First shortfall'}>
        <dt>{firstTiming ? 'Timing risk' : 'First shortfall'} · {cardDate(plan.firstGap.date)}</dt>
        <dd>{cardMoney(firstTiming?.exposurePaise ?? plan.firstGap.amountPaise)}</dd>
        {firstTiming && <span className="card-meta">If payments leave before same-day income. {firstTiming.remainingGapPaise > 0 ? `${cardMoney(firstTiming.remainingGapPaise)} still unfunded after included income.` : 'No remaining gap after included income; payment timing is not guaranteed.'}</span>}
      </div> : plan.troughPaise != null && <div className="final-plan-figure" aria-label="Lowest projected balance">
        <dt>Lowest balance</dt>
        <dd>{cardMoney(plan.troughPaise)}</dd>
        <span className="card-meta">No payment shortfall projected in this window.</span>
      </div>}
      {peak && <div className="final-plan-figure" data-tone="risk" aria-label={peakTiming ? 'Largest timing exposure' : 'Largest shortfall'}>
        <dt>{peakTiming ? 'Largest timing exposure' : 'Largest shortfall'}{plan.peakGapDate && ` · ${cardDate(plan.peakGapDate)}`}</dt>
        <dd>{cardMoney(plan.peakGapPaise)}</dd>
        {peakTiming && <span className="card-meta">{peakTiming.remainingGapPaise > 0 ? `${cardMoney(peakTiming.remainingGapPaise)} still unfunded after included income.` : 'No remaining gap after included income; payment timing is not guaranteed.'}</span>}
      </div>}
      {!!plan.reserveShortfallPaise && <div className="final-plan-figure" data-tone="risk" aria-label="Cash buffer at risk">
        <dt>Below your {cardMoney(snapshot.facts.reservePaise)} buffer{reserve?.date && ` · ${cardDate(reserve.date)}`}</dt>
        <dd>{cardMoney(reserve?.amountPaise ?? plan.reserveShortfallPaise)}</dd>
        <span className="card-meta">{reserve && reserve.amountPaise !== plan.reserveShortfallPaise && `Largest buffer shortfall: ${cardMoney(plan.reserveShortfallPaise)}. `}Separate from payment shortfalls.</span>
      </div>}
    </dl>
    <ResultQualification snapshot={snapshot} id="closing" details={false} />
    {conversions.some(conversion => conversion.direction !== 'valuation' && conversion.fee == null) && <p className="card-meta card-caution">Planning estimate excludes unknown conversion fees; fees are not assumed to be zero.</p>}
    {conversions.some(conversion => conversion.rate == null || conversion.rateStatus === 'unknown') && <p className="card-meta card-caution">Exchange rate unavailable; conversion needs retry. Automatic retry is next day, subject to the daily limit.</p>}
    {keyDates.length > 0 && <section className="final-plan-dates" aria-label="Key dates">
      <h4>Key dates</h4>
      <ol>{keyDates.map(event => <li key={event.id} data-income={event.kind === 'income'} data-gap={event.date === plan.firstGap?.date || event.date === plan.peakGapDate || undefined}>
        <time dateTime={event.date}>{cardDate(event.date)}</time>
        <span className="final-plan-date-label">{event.label}{event.dateAssumption ? ' · Assumed' : event.overdue ? ' · Originally due' : ''}{event.kind === 'income' && !event.included && ' · Not counted on'}</span>
        <span className="final-plan-date-amount">{event.amountPaise == null ? 'Unknown' : `${event.kind === 'income' ? '+' : '−'}${cardMoney(event.amountPaise)}`}{event.amountStatus === 'estimate' && ' est.'}</span>
      </li>)}</ol>
    </section>}
    <section className="final-plan-actions" aria-label="What to do">
      <h4>What to do</h4>
      <p className="final-plan-action">{financialText(outcome.action)}</p>
      <p className="card-meta"><strong>Depends on</strong> {financialText(outcome.topCaveat)}{outcome.secondary && <> {financialText(outcome.secondary)}</>}</p>
    </section>
    <details className="card-terms"><summary>What this depends on</summary>
      <p>{financialText(outcome.summary)}</p>
      <p>{financialText(outcome.nextStep)}</p>
      <p>{financialText(outcome.conditions)}</p>
      <ResultQualification snapshot={snapshot} id="closing" />
      {assumptions.map(assumption => <p key={assumption}>{financialText(assumption)}</p>)}
      {snapshot.facts.opening.source?.conversion && <div><p>Opening cash</p><ExchangeValues source={snapshot.facts.opening.source} capturedPaise={snapshot.facts.opening.amountPaise} currentMoney={plan.planningFacts.opening} plan={plan} /></div>}
      {records.map(record => <div key={record.id}><p>{record.label}{record.schedule.date == null && ' · Undated'}</p><MoneySources record={record} snapshot={snapshot} /></div>)}
      {snapshot.facts.providerResponses?.map(response => (['payment', 'cost'] as const).map(field => response[field]?.source?.conversion && <div key={`${response.eventId}:${field}`}><p>Reported provider {field} · {plan.events.find(event => event.id === response.eventId)?.label ?? response.eventId} · Not verified or applied</p>
        <ExchangeValues source={response[field].source!} capturedPaise={response[field].amountPaise} currentMoney={plan.planningFacts.providerResponses?.find(item => item.eventId === response.eventId)?.[field] ?? undefined} plan={plan} /></div>))}
      <p>{financialText(outcome.revisit)}</p>
    </details>
    {snapshot.accepted && <p className="card-meta">Saved assumptions included · No payments made</p>}
    <button type="button" className="card-expand" onClick={onEdit}>Edit figures</button>
  </article>;
}