// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import type { Plan, Snapshot } from './api';
import { cardDate, cardMoney } from './cardFields';
import { financialText, timestamp } from './money';
import './planSummary.css';

/** Explains a calculated result's certainty and limitations. */
export function ResultQualification({ snapshot, id }: { snapshot: Snapshot; id: string }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const result = snapshot.workspace?.results?.find(item => item.id === id);
  const estimated = result?.state === 'estimated';
  const qualifications = result?.qualifications ?? [];
  const state = snapshot.facts.conflicts?.length || result?.state === 'conflicting' ? 'Conflicting figures'
    : result?.state === 'missing' ? 'Amount not yet known' : plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete ? 'Based on dated items'
      : result?.state === 'uncertain' || result?.state === 'unresolved' ? 'Based on what you shared' : 'Forecast';
  return <span className="result-qualification">
    <span>{state}{estimated && ' · Includes estimates'}{id === 'closing' && ' · Not a spending allowance'}</span>
    {qualifications.map(text => <span key={text}>{financialText(text)}</span>)}
  </span>;
}

/** Presents the first shortfall, distinguishing same-day timing exposure from remaining funding needs. */
export function GapFigure({ plan }: { plan: Plan }) {
  if (!plan.firstGap) return null;
  const timing = plan.timingRisks?.find(item => item.date === plan.firstGap!.date);
  return <div className="plan-gap" aria-label={timing ? 'Timing risk' : 'First shortfall'}>
    <strong>{cardMoney(timing?.exposurePaise ?? plan.firstGap.amountPaise)}</strong>
    <span>{timing ? 'Timing risk' : 'First shortfall'} · {cardDate(plan.firstGap.date)}</span>
    {timing && <span className="plan-gap-explanation">If payments leave before same-day income. {timing.remainingGapPaise > 0
      ? `${cardMoney(timing.remainingGapPaise)} still unfunded after included income.`
      : 'No remaining gap after included income; payment timing is not guaranteed.'}</span>}
  </div>;
}

/** Highlights the plan outcome, cash risks, qualifications, and next action. */
export function PlanSummary({ snapshot, stale = false, showQualifications = true, children }: { snapshot: Snapshot; stale?: boolean; showQualifications?: boolean; children?: ReactNode }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const assessment = plan.decisionAssessment;
  const outcome = assessment?.outcome;
  const action = snapshot.workspace?.actions?.find(item => item.id === assessment?.nextActionId) ?? snapshot.workspace?.actions?.[0];
  const meaningful = snapshot.facts.opening.amountPaise !== null || snapshot.facts.records.length > 0 || !!snapshot.facts.conflicts?.length;
  if (!meaningful || !outcome) return null;
  const ready = !stale && outcome.branch === 'fits' && outcome.readiness === 'ready' && !plan.projectionPartial
    && plan.budgetBasis.datedProjectionComplete && !snapshot.facts.conflicts?.length;
  const reserve = assessment?.consequences?.find(item => item.kind === 'reserveBreach');
  return <section className="plan-summary" aria-label="What needs attention" data-tone={plan.firstGap || plan.reserveShortfallPaise ? 'risk' : ready ? 'clear' : 'neutral'}>
    <h3>{financialText(outcome.summary)}</h3>
    <GapFigure plan={plan} />
    {showQualifications && <ResultQualification snapshot={snapshot} id={plan.firstGap ? 'firstGap' : 'closing'} />}
    {!!plan.reserveShortfallPaise && <p className="plan-reserve">Cash buffer at risk: {cardMoney(reserve?.amountPaise ?? plan.reserveShortfallPaise)} below your {cardMoney(snapshot.facts.reservePaise)} buffer{reserve?.date && <> · {cardDate(reserve.date)}</>}.{reserve && reserve.amountPaise !== plan.reserveShortfallPaise && <> Largest buffer shortfall: {cardMoney(plan.reserveShortfallPaise)}.</>} Separate from payment shortfalls.</p>}
    {action && <p className="plan-next"><strong>Next step</strong> {financialText(action.question)}{action.beforeDate && <span className="plan-deadline">Before {cardDate(action.beforeDate)}</span>}</p>}
    {!!outcome.conditions && <details className="plan-conditions"><summary>What this depends on</summary><p>{financialText(outcome.conditions)}</p><p>{financialText(outcome.revisit)}</p></details>}
    {snapshot.accepted && <p className="plan-basis">Saved assumptions included · No payments made</p>}
    {children}
  </section>;
}

/** Displays the saved plan's expiry in the requested time zone. */
export function PlanExpiry({ snapshot, timezone = 'Asia/Kolkata' }: { snapshot: Snapshot; timezone?: string }) {
  return <p className="plan-expiry">Saved plan available until <time dateTime={snapshot.expiresAt}>{timestamp(snapshot.expiresAt, timezone)} ({timezone})</time>. Download a copy to keep it.</p>;
}