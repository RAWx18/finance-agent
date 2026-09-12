// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from './api';
import { cardDate, cardMoney } from './cardFields';
import { financialText } from './money';
import { GapFigure, ResultQualification } from './PlanSummary';

/** Presents the authoritative outcome without repeating the editable working ledger. */
export function FinalPlan({ snapshot, onEdit }: { snapshot: Snapshot; onEdit: () => void }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const outcome = plan.decisionAssessment!.outcome!;
  const reserve = plan.decisionAssessment?.consequences?.find(item => item.kind === 'reserveBreach');
  const assumptions = [...new Map(plan.events.filter(event => event.dateAssumption).map(event => [event.recordId, `${event.label}: ${event.dateAssumption}`])).values()];
  return <article className="companion-card" aria-label="Your 30-day plan">
    <h3>Your 30-day plan</h3>
    <p>{financialText(outcome.summary)}</p>
    <GapFigure plan={plan} />
    {!!plan.reserveShortfallPaise && <p className="plan-reserve">Cash buffer at risk: {cardMoney(reserve?.amountPaise ?? plan.reserveShortfallPaise)} below your {cardMoney(snapshot.facts.reservePaise)} buffer{reserve?.date && <> · {cardDate(reserve.date)}</>}.{reserve && reserve.amountPaise !== plan.reserveShortfallPaise && <> Largest buffer shortfall: {cardMoney(plan.reserveShortfallPaise)}.</>} Separate from payment shortfalls.</p>}
    <p className="plan-next"><strong>Next step</strong> {financialText(outcome.nextStep)}</p>
    <div className="card-closing" aria-label="Projected closing cash"><span className="card-caption">{plan.undatedImpact ? 'Dated items only · closing cash' : 'Projected closing cash'}</span><strong>{cardMoney(plan.closingPaise)}</strong></div>
    {plan.undatedImpact && <p className="card-meta">After the separate undated-payment allowance: {cardMoney(plan.undatedImpact.closingPaise)}. What-if only; not confirmation of payment timing.</p>}
    <ResultQualification snapshot={snapshot} id="closing" details={false} />
    <details className="card-terms"><summary>What this depends on</summary>
      <p>{financialText(outcome.conditions)}</p>
      <ResultQualification snapshot={snapshot} id="closing" />
      {assumptions.map(assumption => <p key={assumption}>{financialText(assumption)}</p>)}
      <p>{financialText(outcome.revisit)}</p>
    </details>
    {snapshot.accepted && <p className="card-meta">Saved assumptions included · No payments made</p>}
    <button type="button" className="card-expand" onClick={onEdit}>Edit figures</button>
  </article>;
}