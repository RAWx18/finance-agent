// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import type { Plan, Snapshot } from './api';
import { cardDate, cardMoney } from './cardFields';
import { timestamp } from './money';
import './planSummary.css';

export function ResultQualification({ snapshot, id }: { snapshot: Snapshot; id: string }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const result = snapshot.workspace?.results?.find(item => item.id === id);
  const estimated = result?.state === 'estimated' || snapshot.facts.opening.status === 'estimate'
    || plan.events.some(event => event.included && (event.amountStatus === 'estimate'
      || snapshot.facts.records.find(record => record.id === event.recordId)?.schedule.certainty === 'estimate'));
  const qualifications = result?.qualifications ?? [];
  const state = snapshot.facts.conflicts?.length || result?.state === 'conflicting' ? 'Conflicting figures'
    : result?.state === 'missing' ? 'Unknown' : plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete ? 'Incomplete forecast'
      : result?.state === 'uncertain' || result?.state === 'unresolved' ? 'Some details unconfirmed' : 'Forecast';
  return <span className="result-qualification">
    <span>{state}{estimated && ' · Includes estimates'}{id === 'closing' && ' · Not a spending allowance'}</span>
    {qualifications.map(text => <span key={text}>{text}</span>)}
  </span>;
}

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

export function PlanSummary({ snapshot, stale = false, children }: { snapshot: Snapshot; stale?: boolean; children?: ReactNode }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const assessment = plan.decisionAssessment;
  const outcome = assessment?.outcome;
  const action = snapshot.workspace?.actions?.find(item => item.id === assessment?.nextActionId);
  const meaningful = snapshot.facts.opening.amountPaise !== null || snapshot.facts.records.length > 0 || !!snapshot.facts.conflicts?.length;
  if (!meaningful || !outcome) return null;
  const ready = !stale && outcome.branch === 'fits' && outcome.readiness === 'ready' && !plan.projectionPartial
    && plan.budgetBasis.datedProjectionComplete && !snapshot.facts.conflicts?.length;
  const reserve = assessment?.consequences?.find(item => item.kind === 'reserveBreach');
  return <section className="plan-summary" aria-label="What needs attention" data-tone={plan.firstGap || plan.reserveShortfallPaise ? 'risk' : ready ? 'clear' : 'neutral'}>
    <h3>{outcome.summary}</h3>
    <GapFigure plan={plan} />
    {plan.firstGap && <ResultQualification snapshot={snapshot} id="firstGap" />}
    {!!plan.reserveShortfallPaise && <p className="plan-reserve">Cash buffer at risk: {cardMoney(plan.reserveShortfallPaise)} below your {cardMoney(snapshot.facts.reservePaise)} buffer{reserve?.date && <> · {cardDate(reserve.date)}</>}. Separate from payment shortfalls.</p>}
    {!plan.firstGap && <ResultQualification snapshot={snapshot} id="closing" />}
    {action && <p className="plan-next"><strong>Next step</strong> {action.question}{action.beforeDate && <span className="plan-deadline">Before {cardDate(action.beforeDate)}</span>}</p>}
    {!!outcome.conditions && <details className="plan-conditions"><summary>What this depends on</summary><p>{outcome.conditions}</p><p>{outcome.revisit}</p></details>}
    {snapshot.accepted && <p className="plan-basis">Saved assumptions included · No payments made</p>}
    {children}
  </section>;
}

export function PlanExpiry({ snapshot, timezone = 'Asia/Kolkata' }: { snapshot: Snapshot; timezone?: string }) {
  return <p className="plan-expiry">Saved plan available until <time dateTime={snapshot.expiresAt}>{timestamp(snapshot.expiresAt, timezone)} ({timezone})</time>. Download a copy to keep it.</p>;
}