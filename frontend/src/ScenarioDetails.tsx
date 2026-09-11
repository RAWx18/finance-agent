// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import type { Ref } from 'react';
import type { Command, Plan, Scenario, Snapshot } from './api';
import { Details } from './Dialog';
import { dateLabel, money } from './money';
import { PagedList } from './PagedList';

type Action = NonNullable<NonNullable<Plan['decisionAssessment']>['actions']>[number];
export const outcomeLabels = {
  fits: 'Known commitments look covered', uncertain: 'What still needs checking',
  gap: 'A cash gap is projected', conflict: 'Reported figures conflict',
};
export const actionLabels: Record<string, string> = {
  clarify: 'Check a reported detail', contactPayee: 'Contact the payee',
  verifyTerms: 'Verify reported terms', reviewOutcome: 'Review the outcome',
  previewChange: 'Compare a change', followUp: 'Follow up', seekSupport: 'Seek support',
  resolveGroup: 'Review shared commitments', confirmReceipt: 'Confirm a receipt', reconcileStatus: 'Check payment status',
};
const recurrence = { once: 'One time', weekly: 'Every week', fortnightly: 'Every two weeks', monthly: 'Every month' };

export function ActionDetails({ action, plan, facts }: { action: Action; plan: Plan; facts: Snapshot['facts'] }) {
  const choice = plan.decisionAssessment?.choices?.find(item => item.id === action.choiceId);
  return <>
    <p>{action.question}</p>
    {action.beforeDate && <p>Before {dateLabel(action.beforeDate)}</p>}
    {action.recordIds.map(id => {
      const record = facts.records.find(item => item.id === id);
      return record && <p key={id}>{record.label} · {record.kind === 'debt' ? 'Required / minimum' : 'Reported'} {money(record.amount.amountPaise)}
        {record.schedule.date ? <> · {record.kind === 'income' ? 'Expected' : 'Due'} {dateLabel(record.schedule.date)}</> : ' · Date unknown'}
      </p>;
    })}
    {(plan.decisionAssessment?.consequences ?? []).filter(item => action.consequenceIds.includes(item.id) && item.kind !== 'conditionalIncome').map(item => <p key={item.id}>
      {item.kind === 'cashExposure' ? 'Unmet commitments' : 'Reserve shortfall'}: {money(item.amountPaise)}{item.date && <> on {dateLabel(item.date)}</>}
      {action.ifDeclinedConsequenceIds.includes(item.id) && <> · Remains if the payee declines; no agreement is assumed.</>}
    </p>)}
    {choice && <>
      {choice.adjustmentAmounts.map(item => {
        const event = plan.events.find(event => event.id === item.eventId);
        return <p key={item.eventId}>{event?.label ?? 'Reported occurrence'}{event && <> · {dateLabel(event.date)}</>} · Proposed amount {money(item.amountPaise)}. Not saved or paid.</p>;
      })}
      {choice.laterOnly && <p>This affects later commitments, not the earlier shortfall.</p>}
    </>}
  </>;
}

export function NextSteps({ plan, facts }: { plan: Plan; facts: Snapshot['facts'] }) {
  const assessment = plan.decisionAssessment;
  const actions = assessment?.actions ?? [];
  const selected = actions.find(action => action.id === assessment?.nextActionId);
  const ordered = selected ? [selected, ...actions.filter(action => action.id !== selected.id)] : actions;
  const meaningful = ordered.filter((action, index) => action.question.trim() && ordered.findIndex(item => item.question === action.question) === index);
  if (!meaningful.length) return null;
  return <section className="plan-actions" aria-label="Next steps"><h3>Next steps</h3><ol>
    {meaningful.slice(0, 3).map(action => <li key={action.id}><h4>{actionLabels[action.kind] ?? 'Next step'}</h4><ActionDetails action={action} plan={plan} facts={facts} /></li>)}
  </ol></section>;
}

export function BudgetDetails({ plan, facts }: { plan: Plan; facts: Snapshot['facts'] }) {
  return <>
    {(plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete) && <p className="hint">Some figures need checking. These balances are not available to spend.</p>}
    {plan.budgetBasis.unresolvedAmounts.length > 0 && <Details label="Missing amounts or dates">
      <PagedList label="Unresolved amounts and dates" className="saved-items">
        {plan.budgetBasis.unresolvedAmounts.map((item, index) => <li key={`${item.recordId}:${item.reason}:${index}`}>
          <strong>{facts.records.find(record => record.id === item.recordId)?.label ?? 'Reported item'}</strong>
          <p>{money(item.amount.amountPaise)}{item.amount.status === 'estimate' && ' · Estimate'} · {recurrence[item.recurrence]}</p>
          <p>{item.reason === 'missingDate' ? 'Date unknown · not included in dated totals.' : item.reason === 'unknownTarget' ? 'Selected target unknown · only the known required payment is included.' : 'Amount unknown · not fully included in dated totals.'}</p>
        </li>)}
      </PagedList>
    </Details>}
  </>;
}

export function AssessmentDetails({ plan }: { plan: Plan }) {
  const assessment = plan.decisionAssessment;
  const outcome = assessment?.outcome;
  const uncertainties = assessment?.uncertainties ?? [];
  const checks = outcome ? uncertainties.filter(item => outcome.uncertain.includes(item.id)) : uncertainties;
  return <div className="detail-actions">
    {outcome && <Details label="Plan details">
      <p>{outcome.summary}</p>
      <p>{outcome.covered}</p><p>{outcome.notCovered}</p>
      <p><strong>Next step:</strong> {outcome.nextStep}</p>
      <p>{outcome.conditions}</p>
      <PagedList label="What is known now" className="saved-items">{outcome.trueNow.filter(text => ![outcome.summary, outcome.covered, outcome.notCovered, outcome.conditions, outcome.nextStep].includes(text)).map((text, index) => <li key={index}>{text}</li>)}</PagedList>
      {outcome.revisit && <p>{outcome.revisit}</p>}
    </Details>}
    {checks.length > 0 && <Details label="Open questions">
      <PagedList label="Remaining checks" className="saved-items">{checks.map(item => <li key={item.id}>
        <p>{item.question}</p><p className="hint">{item.reason}</p>
        {item.beforeDate && <p>Before {dateLabel(item.beforeDate)}</p>}
      </li>)}</PagedList>
    </Details>}
    {!!plan.incomeComparisons?.length && <Details label="Income possibilities">
      <p>These receipts are unconfirmed and excluded from your current balances.</p>
      <PagedList label="Conditional income comparisons" className="saved-items">{plan.incomeComparisons.map(comparison => <li key={comparison.id}>
        {comparison.conditions.map(condition => {
          const event = plan.events.find(item => item.id === condition.eventId);
          return <p key={condition.eventId}>If {event?.label ?? 'the uncertain receipt'}{event?.amountPaise != null && <> ({money(event.amountPaise)})</>} {condition.arrival === 'reportedDate' ? <>arrives on {event ? dateLabel(event.date) : 'its reported date'}</> : 'does not arrive within these 30 days'}.</p>;
        })}
        <p>First cash gap: {comparison.metrics.firstGap ? <>{money(comparison.metrics.firstGap.amountPaise)} on {dateLabel(comparison.metrics.firstGap.date)}</> : comparison.metrics.closingPaise === null ? 'Unknown' : 'None under these conditions'}</p>
        <p>Conditional closing cash: {money(comparison.metrics.closingPaise)}</p>
      </li>)}</PagedList>
    </Details>}
  </div>;
}

export function Assumptions({ scenario }: { scenario: Scenario }) {
  return <>
    <p><strong>{money(scenario.reducedOutflowPaise)} less planned spending</strong> than reported. Not a completed change or payment.</p>
    <PagedList className="saved-items" label="Planning assumptions">
      {scenario.adjustments.map((item) => <li key={item.eventId}>
        <h3>{item.label} · {dateLabel(item.date)}</h3>
        <p>{money(item.originalPaise)} reported → {money(item.amountPaise)} assumed</p>
        <p className="hint">This occurrence only; dates stay unchanged.</p>
        <p className="hint">{item.acceptedRevision != null ? 'Consent saved for this occurrence; not a completed action.' : item.acceptanceReady ? 'Not saved · requires explicit, unconditional consent.' : 'Not ready to save · confirm this spending is changeable and uncommitted first.'}</p>
        {item.kind === 'card' && <p className="hint">Required minimum {money(item.minimumPaise)}. Minimum is not payoff; interest and fees may apply. Outstanding debt is unchanged.</p>}
      </li>)}
    </PagedList>
  </>;
}

export function PlanComparison({ baseline, assumed, reserve, label }: { baseline: Plan; assumed: Plan; reserve: number; label: string }) {
  return <div className="plan-comparison" aria-label={label}>
    {[baseline, assumed].map((plan, index) => <section key={index} aria-label={index ? label : 'Before · reported figures'}>
      <h3>{index ? label : 'Before · reported figures'}</h3>
      <p className="hint">{plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete ? 'Not all costs are included' : plan.decisionAssessment?.outcome?.readiness === 'qualified' ? 'Some figures need checking' : 'Based on what you shared'}</p>
      {(plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete) && <p>These balances are not available to spend.</p>}
      <dl className="comparison-values">
        <div><dt>First cash gap</dt><dd>{plan.firstGap ? <>{money(plan.firstGap.amountPaise)} · {dateLabel(plan.firstGap.date)}</> : plan.closingPaise === null ? 'Unknown' : 'None in dated figures'}</dd></div>
        <div><dt>Largest cash gap</dt><dd>{money(plan.peakGapPaise)}{plan.peakGapDate && <> · {dateLabel(plan.peakGapDate)}</>}</dd></div>
        <div><dt>{index ? 'Assumed closing cash' : 'Projected closing cash'}</dt><dd>{money(plan.closingPaise)}</dd></div>
        {(reserve > 0 || (plan.reserveShortfallPaise !== null && plan.reserveShortfallPaise > 0)) && <>
          <div><dt>Reserve floor · not an expense</dt><dd>{money(reserve)}</dd></div>
          <div><dt>Reserve shortfall</dt><dd>{money(plan.reserveShortfallPaise)}</dd></div>
        </>}
      </dl>
    </section>)}
    {(baseline.firstGap || assumed.firstGap) && <p className="hint">A higher closing balance does not remove an earlier cash gap.</p>}
    {assumed.firstGap && <p className="hint">A cash gap remains on {dateLabel(assumed.firstGap.date)}.</p>}
  </div>;
}

export function RemovedAssumptions({ preview, accepted }: { preview: Scenario; accepted: Snapshot['accepted'] }) {
  if (!preview.removedAssumptionIds?.length) return null;
  return <section aria-label="Assumptions removed by this proposal">
    <p>This proposal would remove these saved assumptions, restoring their reported amounts:</p>
    <PagedList label="Removed assumptions" className="saved-items">{preview.removedAssumptionIds.map(id => {
      const item = accepted?.adjustments.find(adjustment => adjustment.eventId === id);
      return <li key={id}>{item ? <>{item.label} · {dateLabel(item.date)} · {money(item.amountPaise)} assumed → {money(item.originalPaise)} reported</> : 'A saved assumption would be removed.'}</li>;
    })}</PagedList>
  </section>;
}

export function ProposalReview({ snapshot, active, locked, onCommand, headingRef }: {
  snapshot: Snapshot; active: boolean; locked: boolean; onCommand: (operation: Command['operation']) => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const headingId = useId();
  const preview = snapshot.preview;
  const key = `${snapshot.sessionId}:${snapshot.revision}:${snapshot.sequence}:${preview?.sourceRevision}:${preview?.id}:${active}:${locked}`;
  const [review, setReview] = useState({ key, checked: false });
  if (review.key !== key) setReview({ key, checked: false });
  if (!preview) return null;
  const blocked = !active || locked || preview.sourceRevision !== snapshot.revision;
  const acceptanceReady = preview.adjustments.every(item => item.acceptanceReady);
  const checked = review.key === key && review.checked;
  const canAccept = !blocked && acceptanceReady && checked;

  return <section className="preview proposal-review" aria-labelledby={headingId} hidden={!active}>
    <h2 id={headingId} tabIndex={-1} ref={headingRef}>Spending change preview</h2>
    <p className="hint">Not saved or included in downloads.</p>
    {snapshot.accepted && <p>Accepting replaces all saved assumptions; changes do not stack.</p>}
    <Assumptions scenario={preview} />
    <RemovedAssumptions preview={preview} accepted={snapshot.accepted} />
    <PlanComparison baseline={snapshot.plan} assumed={preview.plan} reserve={snapshot.facts.reservePaise} label="After · preview" />
    {preview.sourceRevision !== snapshot.revision && <p className="notice warning">Your figures changed. Ask for a fresh proposal or refresh choices in Your figures before accepting.</p>}
    {!acceptanceReady && <p className="notice warning">To save, first confirm “Can this spending change?” for each item by voice or in Edit figures, then preview again.</p>}
    <p>Accepting saves this whole proposal, including removals. No payment is made.</p>
    <label className="check"><input type="checkbox" checked={checked} disabled={blocked || !acceptanceReady}
      onChange={event => setReview({ key, checked: event.target.checked })} />I agree to the exact amounts and payments or expenses shown, including removals, unconditionally—not dependent on uncertain income or payee agreement.</label>
    <div className="actions">
      <button type="button" className="primary" disabled={!canAccept} onClick={() => {
        if (!canAccept) return;
        setReview({ key, checked: false });
        onCommand({ type: 'acceptPreview', previewId: preview.id, confirmed: true, consentScope: 'unconditional' });
      }}>Accept planning assumptions</button>
      <button type="button" disabled={blocked} onClick={() => {
        if (blocked) return;
        setReview({ key, checked: false });
        onCommand({ type: 'discardPreview', previewId: preview.id });
      }}>Reject preview</button>
    </div>
    <p className="hint">Rejecting this preview does not mark any suggested cut as declined.</p>
    {!checked && <p className="hint">Review this exact preview before accepting.</p>}
  </section>;
}