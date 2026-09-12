// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import type { Ref } from 'react';
import type { Command, Plan, Scenario, Snapshot } from './api';
import { Details, Dialog } from './Dialog';
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

export function Assumptions({ scenario, proposed = false }: { scenario: Scenario; proposed?: boolean }) {
  return <>
    <p><strong>{money(scenario.reducedOutflowPaise)} less planned spending</strong> · Calculated against reported amounts.</p>
    <p className="money-meta">{proposed ? 'Proposed full set · not saved' : 'Saved changes'} · {scenario.adjustments.length} {scenario.adjustments.length === 1 ? 'occurrence' : 'occurrences'}. Dates unchanged. No payments made.</p>
    <PagedList className="money-choice-cards" label="Planning assumptions" pageSize={6}>
      {scenario.adjustments.map((item) => <li key={item.eventId}>
        <div className="money-section-head"><h3>{item.label}</h3><span className="money-meta">{dateLabel(item.date)}</span></div>
        <p>{money(item.originalPaise)} Reported → <strong>{money(item.amountPaise)} {proposed ? 'Proposed' : 'Saved'}</strong>{item.kind === 'card' && ' · includes minimum'}</p>
        {!item.acceptanceReady && <p className="money-warning">Not ready to save · confirm this spending is changeable and uncommitted first.</p>}
        {item.kind === 'card' && <p className="money-meta">Required minimum {money(item.minimumPaise)} · Reported. Not payoff.</p>}
        <details className="money-assumption-details"><summary>Terms for this change</summary>
          <p>This occurrence only; dates stay unchanged.</p>
          <p>{item.acceptedRevision != null ? 'Consent saved for this occurrence; not a completed action.' : 'Not saved · requires explicit, unconditional consent.'}{proposed && ' Review and consent to this whole proposal again.'}</p>
          {item.kind === 'card' && <p>Interest and fees may apply. Outstanding debt is unchanged.</p>}
        </details>
      </li>)}
    </PagedList>
  </>;
}

export function PlanComparison({ baseline, assumed, reserve, label, beforeLabel = 'Before · reported figures' }: { baseline: Plan; assumed: Plan; reserve: number; label: string; beforeLabel?: string }) {
  return <div className="plan-comparison" aria-label={label}>
    {[baseline, assumed].map((plan, index) => <section key={index} aria-label={index ? label : beforeLabel}>
      <h3>{index ? label : beforeLabel}</h3>
      <p className="hint">{plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete ? 'Not all costs are included' : plan.decisionAssessment?.outcome?.readiness === 'qualified' ? 'Some figures need checking' : 'Based on what you shared'}</p>
      {(plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete) && <p>These balances are not available to spend.</p>}
      <p className="money-meta">Calculated</p>
      <dl className="comparison-values">
        <div><dt>First cash gap</dt><dd>{plan.firstGap ? <>{money(plan.firstGap.amountPaise)} · {dateLabel(plan.firstGap.date)}</> : plan.closingPaise === null ? 'Unknown' : 'None in dated figures'}</dd></div>
      </dl>
      <details className="money-comparison-details"><summary>More calculated results</summary><dl className="comparison-values">
        <div><dt>Largest cash gap</dt><dd>{money(plan.peakGapPaise)}{plan.peakGapDate && <> · {dateLabel(plan.peakGapDate)}</>}</dd></div>
        <div><dt>{index ? 'Assumed closing cash' : 'Projected closing cash'}</dt><dd>{money(plan.closingPaise)}</dd></div>
        {(reserve > 0 || (plan.reserveShortfallPaise !== null && plan.reserveShortfallPaise > 0)) && <>
          <div><dt>Reserve floor · Reported, not an expense</dt><dd>{money(reserve)}</dd></div>
          <div><dt>Reserve shortfall</dt><dd>{money(plan.reserveShortfallPaise)}</dd></div>
        </>}
      </dl></details>
    </section>)}
    {(baseline.firstGap || assumed.firstGap) && <p className="hint">A higher closing balance does not remove an earlier cash gap.</p>}
  </div>;
}

export function RestoreReported({ snapshot, active, locked, onCommand }: {
  snapshot: Snapshot; active: boolean; locked: boolean; onCommand: (operation: Command['operation']) => void;
}) {
  const key = `${snapshot.sessionId}:${snapshot.revision}:${snapshot.sequence}:${snapshot.accepted?.id}:${snapshot.preview?.id}:${active}:${locked}`;
  const [review, setReview] = useState({ key, open: false });
  if (review.key !== key) setReview({ key, open: false });
  if (!snapshot.accepted) return null;
  const blocked = !active || locked;
  return <>
    <button className="detail-button" disabled={blocked} onClick={() => setReview({ key, open: true })}>Restore reported amounts</button>
    <Dialog open={review.key === key && review.open} title="Restore reported amounts?" onClose={() => setReview({ key, open: false })} actions={<>
      <button onClick={() => setReview({ key, open: false })}>Keep saved changes</button>
      <button className="danger" disabled={blocked} onClick={() => {
        if (blocked || review.key !== key) return;
        setReview({ key, open: false }); onCommand({ type: 'clearAccepted' });
      }}>Restore all reported amounts</button>
    </>}>
      <p>Remove every saved planning change below and clear the current preview? Your reported facts stay unchanged. No payment is made.</p>
      <PagedList label="Amounts to restore" className="money-choice-cards" pageSize={6}>{snapshot.accepted.adjustments.map(item => <li key={item.eventId}><h3>{item.label}</h3><p>{dateLabel(item.date)} · {money(item.amountPaise)} Saved → {money(item.originalPaise)} Reported</p></li>)}</PagedList>
    </Dialog>
  </>;
}

export function RemovedAssumptions({ preview, accepted }: { preview: Scenario; accepted: Snapshot['accepted'] }) {
  if (!preview.removedAssumptionIds?.length) return null;
  return <section aria-label="Assumptions removed by this proposal">
    <p>This proposal would remove these saved assumptions, restoring their reported amounts:</p>
    <PagedList label="Removed assumptions" className="money-choice-cards" pageSize={6}>{preview.removedAssumptionIds.map(id => {
      const item = accepted?.adjustments.find(adjustment => adjustment.eventId === id);
      return <li key={id}>{item ? <>{item.label} · {dateLabel(item.date)} · {money(item.amountPaise)} Saved → {money(item.originalPaise)} Reported</> : 'A saved assumption would be removed.'}</li>;
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
    <p className="money-meta">Not saved or included in downloads.{snapshot.accepted && ' Replaces all saved assumptions; changes do not stack.'}</p>
    <Assumptions scenario={preview} proposed />
    <RemovedAssumptions preview={preview} accepted={snapshot.accepted} />
    <PlanComparison baseline={snapshot.accepted?.plan ?? snapshot.plan} assumed={preview.plan} reserve={snapshot.facts.reservePaise} label="After · preview" beforeLabel="Before · active plan" />
    {snapshot.accepted && <Details label="Reported baseline"><PlanComparison baseline={snapshot.plan} assumed={snapshot.accepted.plan} reserve={snapshot.facts.reservePaise} label="With saved assumptions" /></Details>}
    {preview.sourceRevision !== snapshot.revision && <p className="notice warning">Your figures changed. Ask for a fresh proposal or refresh choices in Plan changes before accepting.</p>}
    {!acceptanceReady && <p className="notice warning">To save, first confirm “Can this spending change?” for each item by voice or by editing it in Money, then preview again.</p>}
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
        onCommand({ type: 'rejectPreview', previewId: preview.id });
      }}>Reject preview</button>
      <button type="button" disabled={blocked} onClick={() => {
        if (blocked) return;
        setReview({ key, checked: false });
        onCommand({ type: 'discardPreview', previewId: preview.id });
      }}>Close preview</button>
    </div>
    <p className="hint">Reject saves your refusal of this proposal. Close preview only puts it aside; it is not a refusal.</p>
    {!checked && <p className="hint">Review this exact preview before accepting.</p>}
  </section>;
}