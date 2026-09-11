// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { Command, Snapshot } from './api';
import { Details } from './Dialog';
import { dateLabel, lastDate, money } from './money';
import { PagedList } from './PagedList';
import { ActionDetails, actionLabels, AssessmentDetails, Assumptions, BudgetDetails, NextSteps, outcomeLabels, ProposalReview } from './ScenarioDetails';

type Fact = Snapshot['facts']['records'][number];
type Changes = { records: string[]; opening: boolean; outcome: boolean; notes: string[]; invalidated?: { eventId: string; label: string; date: string }[] };
const recurrence = { once: 'One time', weekly: 'Every week', fortnightly: 'Every two weeks', monthly: 'Every month' };
const kinds = { income: 'Income', essential: 'Essential', debt: 'Debt', optional: 'Optional' };

function reported(value: Snapshot['facts']['opening']): string {
  return `${money(value.amountPaise)}${value.status === 'unknown' ? '' : ` · ${value.status === 'estimate' ? 'Estimate' : 'Reported'}`}`;
}

function FactCard({ record, changed }: { record: Fact; changed: boolean }) {
  return <article className="fact-card" aria-label={record.label} data-changed={changed}>
    <p className="fact-kind">{kinds[record.kind]}</p>
    <h3>{record.label}</h3>
    {record.kind === 'debt' && <p className="fact-detail">Required / minimum</p>}
    <p className="fact-amount">{reported(record.amount)}</p>
    <p className="fact-detail">{record.schedule.date ? dateLabel(record.schedule.date) : 'Date unknown'} · {recurrence[record.schedule.recurrence]}</p>
    {record.kind === 'income' && record.reliability !== 'reliable' && <p className="fact-detail">
      {record.reliability === 'uncertain' ? 'Uncertain income' : 'Income reliability unknown'} · Excluded from balances.
    </p>}
    {record.kind === 'debt' && <>
      {record.debtType === 'unknown' && <p className="fact-detail">Debt type unknown</p>}
      {record.target && <p className="fact-detail">Selected target: {reported(record.target)} · Includes the required / minimum, not an extra payment.</p>}
      {record.outstanding && <p className="fact-detail">Reported outstanding: {reported(record.outstanding)} · Not reduced by planning assumptions.</p>}
    </>}
    {record.autoDebit && <p className="fact-detail">Automatic debit reported</p>}
    {record.kind !== 'income' && record.controllability && <p className="fact-detail">{record.controllability === 'committed' ? 'Committed spending' : record.controllability === 'controllable' ? 'Reported as changeable' : 'Whether this can change is not confirmed'}</p>}
  </article>;
}

export function FinancialContext({ snapshot, stale, mode, onInspect, locked, onCommand, proposalActive, error }: {
  snapshot: Snapshot | null; stale: boolean; mode: 'live' | 'review' | 'finished'; onInspect?: () => void;
  locked: boolean; onCommand: (operation: Command['operation']) => void; proposalActive: boolean; error?: string;
}) {
  const proposalHeading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) feedback.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  // Snapshot history annotates changes only; every financial value below comes from the prop.
  const [history, setHistory] = useState<{ snapshot: Snapshot | null; changes: Changes }>({
    snapshot, changes: { records: [], opening: false, outcome: false, notes: [] },
  });
  if (snapshot !== history.snapshot) {
    const previous = history.snapshot;
    const changes: Changes = { records: [], opening: false, outcome: false, notes: [] };
    if (snapshot && previous && snapshot.sessionId === previous.sessionId) {
      changes.opening = JSON.stringify(previous.facts.opening) !== JSON.stringify(snapshot.facts.opening);
      if (changes.opening) changes.notes.push(`Money available: ${reported(previous.facts.opening)} → ${reported(snapshot.facts.opening)}`);
      const records = new Map(previous.facts.records.map(record => [record.id, record]));
      for (const record of snapshot.facts.records) {
        const before = records.get(record.id);
        records.delete(record.id);
        if (JSON.stringify(before) === JSON.stringify(record)) continue;
        changes.records.push(record.id);
        if (!before) {
          changes.notes.push(`${record.label}: saved`);
          continue;
        }
        const details: string[] = [];
        if (before.label !== record.label) details.push(`${before.label} → ${record.label}`);
        if (JSON.stringify(before.amount) !== JSON.stringify(record.amount)) details.push(`${reported(before.amount)} → ${reported(record.amount)}`);
        if (before.schedule.date !== record.schedule.date) details.push(`${before.schedule.date ? dateLabel(before.schedule.date) : 'Date unknown'} → ${record.schedule.date ? dateLabel(record.schedule.date) : 'Date unknown'}`);
        if (before.schedule.recurrence !== record.schedule.recurrence) details.push(`${recurrence[before.schedule.recurrence]} → ${recurrence[record.schedule.recurrence]}`);
        if (JSON.stringify(before.target) !== JSON.stringify(record.target)) details.push(`Selected target: ${before.target ? reported(before.target) : 'Not reported'} → ${record.target ? reported(record.target) : 'Not reported'}`);
        if (JSON.stringify(before.outstanding) !== JSON.stringify(record.outstanding)) details.push(`Outstanding: ${before.outstanding ? reported(before.outstanding) : 'Not reported'} → ${record.outstanding ? reported(record.outstanding) : 'Not reported'}`);
        if (before.reliability !== record.reliability) details.push(`Income reliability: ${before.reliability ?? 'Not reported'} → ${record.reliability ?? 'Not reported'}`);
        if (before.controllability !== record.controllability) details.push(`Spending flexibility: ${before.controllability ?? 'Not reported'} → ${record.controllability ?? 'Not reported'}`);
        if (before.debtType !== record.debtType) details.push(`Debt type: ${before.debtType ?? 'Not reported'} → ${record.debtType ?? 'Not reported'}`);
        if (before.autoDebit !== record.autoDebit) details.push(`Automatic debit: ${before.autoDebit ? 'Reported' : 'Not reported'} → ${record.autoDebit ? 'Reported' : 'Not reported'}`);
        changes.notes.push(`${record.label}: ${details.join('; ') || 'Reported details changed'}`);
      }
      for (const record of records.values()) changes.notes.push(`${record.label}: removed`);
      changes.invalidated = (snapshot.invalidatedAssumptions ?? []).flatMap(item => {
        const adjustment = previous.accepted?.adjustments.find(before => before.eventId === item.eventId);
        return adjustment ? [{ eventId: item.eventId, label: adjustment.label, date: adjustment.date }] : history.changes.invalidated?.filter(before => before.eventId === item.eventId) ?? [];
      });
      if (JSON.stringify(previous.accepted) !== JSON.stringify(snapshot.accepted)) {
        changes.notes.push(snapshot.accepted
          ? previous.accepted?.id === snapshot.accepted.id ? 'Saved planning assumptions recalculated; unaffected assumptions remain saved.' : 'Planning assumptions saved; reported figures are separate.'
          : snapshot.invalidatedAssumptions?.length ? 'Affected assumptions need fresh consent; showing reported figures.' : 'Planning assumptions cleared; showing reported figures.');
      }
      changes.outcome = JSON.stringify(previous.accepted?.plan ?? previous.plan) !== JSON.stringify(snapshot.accepted?.plan ?? snapshot.plan);
      if (JSON.stringify(previous.facts.providerResponses) !== JSON.stringify(snapshot.facts.providerResponses)) changes.notes.push('Reported payee response changed; original dues remain unless confirmed in the reported figures.');
      if (JSON.stringify(previous.facts.decision?.responses ?? []) !== JSON.stringify(snapshot.facts.decision?.responses ?? [])) changes.notes.push('Saved answers and next steps changed.');
      if (!changes.notes.length && changes.outcome) changes.notes.push('Plan figures changed.');
      if (!changes.notes.length && JSON.stringify(previous.facts) !== JSON.stringify(snapshot.facts)) changes.notes.push('Reported coverage or reserve changed.');
      if (!changes.notes.length) Object.assign(changes, history.changes);
    }
    setHistory({ snapshot, changes });
  }
  const changes = history.changes;
  const plan = snapshot?.accepted?.plan ?? snapshot?.plan;
  const assessment = plan?.decisionAssessment;
  const outcome = assessment?.outcome;
  const action = assessment?.actions?.find(item => item.id === assessment.nextActionId);
  const question = assessment?.uncertainties?.find(item => item.id === assessment.nextQuestionId);
  const choice = assessment?.choices?.find(item => item.id === action?.choiceId);
  const response = action && ['clarify', 'confirmReceipt', 'verifyTerms'].includes(action.kind) && (!action.choiceId || choice)
    ? 'unavailable' : action?.kind === 'previewChange' && choice && ['reduceOptional', 'cardMinimum'].includes(choice.kind) && choice.adjustmentAmounts.length
      ? 'declined' : null;
  const responses = snapshot?.facts.decision?.responses ?? [];
  const followup = mode === 'live' && snapshot && plan && <div className="focus-followup">
    {action && <p className="focus-action">{action.question}</p>}
    {question && question.question !== action?.question && <p className="clarification">{question.question}{question.beforeDate && <> · Before {dateLabel(question.beforeDate)}</>}</p>}
    {action && <Details label={`${action.kind === 'clarify' ? 'Why this matters' : actionLabels[action.kind] ?? 'Next step'}${action.beforeDate ? ` · Before ${dateLabel(action.beforeDate)}` : ''}`}>
      <ActionDetails action={action} plan={plan} facts={snapshot.facts} />
      {question && <>{question.question !== action.question && <p>{question.question}</p>}<p className="hint">{question.reason}</p></>}
    </Details>}
    {action && response && <div className="actions"><button type="button" disabled={locked || stale} onClick={() => {
      if (!locked && !stale) onCommand({ type: 'respondToAction', actionId: action.id, response });
    }}>{response === 'unavailable' ? 'I cannot confirm this now' : 'Do not suggest this cut'}</button></div>}
  </div>;
  const learned = snapshot && (snapshot.facts.opening.amountPaise !== null || snapshot.facts.records.length > 0
    || Object.values(snapshot.facts.coverage).some(value => value !== 'notDiscussed') || snapshot.preview || snapshot.accepted || snapshot.invalidatedAssumptions?.length || responses.length);
  const heading = <header className="context-heading"><h2>{mode === 'live' ? 'Your financial picture' : 'Your 30-day plan'}</h2></header>;
  const period = <p className="context-period">{snapshot && `${dateLabel(snapshot.anchorDate)} – ${dateLabel(lastDate(snapshot.endDateExclusive))}`}</p>;
  const updates = <div className="context-updates">
    <p className={`change-note${stale ? ' warning-text' : ''}`} aria-hidden="true">{stale ? 'Updates paused · showing saved figures' : changes.notes.length > 0 && `Latest change: ${changes.notes[0]}`}</p>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{stale ? 'Latest changes are not confirmed. Showing the last saved picture.' : changes.notes.length > 0 && `Latest saved change: ${changes.notes.join(' · ')}`}</p>
    <div className="detail-actions">
      {changes.notes.length > 0 && <Details label="Recent changes">
        <PagedList label="Recent changes" className="saved-items">{changes.notes.map((note, index) => <li key={index}>{note}</li>)}</PagedList>
      </Details>}
    </div>
    <div className="proposal-notice">
      {snapshot?.preview && <>
        <p className="sr-only" role="status">Proposal to review · Not saved</p>
        <button type="button" className="detail-button" disabled={!proposalActive} onClick={() => proposalHeading.current?.focus()}>Review proposed change</button>
      </>}
    </div>
  </div>;
  if (!snapshot || !plan || !learned) return <section className="financial-context" aria-label="Your financial picture">
    {heading}
    {period}
    {updates}
    <div className="context-scroll" tabIndex={0} role="region" aria-label="Financial picture details">
      {error && <p className="notice warning" role="alert" ref={feedback}>{error}</p>}
      <div className="context-empty"><h3>No figures yet</h3><p>They’ll appear as you talk.</p></div>
      {followup}
    </div>
  </section>;

  const qualification = plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete
    ? 'Not all costs are included'
    : outcome?.readiness === 'qualified' ? 'Some figures need checking'
      : 'Based on what you shared';
  const records = snapshot.facts.records;
  const relevant = records.slice(4).find(record => changes.records.includes(record.id))
    ?? records.slice(4).find(record => action?.recordIds.includes(record.id));
  const opening = snapshot.facts.opening.amountPaise !== null && <article className="fact-card" aria-label="Money available" data-changed={changes.opening}>
    <h3>Money available</h3><p className="fact-amount">{reported(snapshot.facts.opening)}</p>
    <p className="fact-detail">At the start of this plan</p>
  </article>;
  const facts = <PagedList key={snapshot.sessionId} label="Saved items" className="fact-grid">
    {snapshot.facts.records.map(record => <li key={record.id}><FactCard record={record} changed={changes.records.includes(record.id)} /></li>)}
  </PagedList>;

  return <section className="financial-context" aria-label="Your financial picture">
    {heading}
    {period}
    {updates}
    <div className="context-scroll" tabIndex={0} role="region" aria-label="Financial picture details">
      {error && <p className="notice warning" role="alert" ref={feedback}>{error}</p>}
      {snapshot.accepted && <p>Includes saved assumptions, not completed payments.</p>}
      <article className="focus-card" aria-label="Plan focus" data-tone={plan.firstGap || outcome?.branch === 'conflict' || outcome?.branch === 'gap' ? 'warning' : outcome?.branch === 'fits' ? 'positive' : 'neutral'} data-changed={changes.outcome}>
        <h3>{outcome ? outcomeLabels[outcome.branch] : 'Your picture is taking shape'}</h3>
        {mode === 'live' && outcome && <p className="focus-summary">{outcome.summary}</p>}
        {plan.firstGap && <>
          <h4>First cash gap</h4>
          <p className="focus-amount">{money(plan.firstGap.amountPaise)}</p>
          <p>On {dateLabel(plan.firstGap.date)}</p>
          {plan.peakGapPaise !== null && (plan.peakGapPaise !== plan.firstGap.amountPaise || (plan.peakGapDate && plan.peakGapDate !== plan.firstGap.date)) && <p>
            Largest gap: {money(plan.peakGapPaise)}{plan.peakGapDate && <> on {dateLabel(plan.peakGapDate)}</>}
          </p>}
        </>}
        {followup}
        {mode === 'live' && relevant && <div className="focus-item" role="group" aria-label="Current reported item">
          <p className="fact-kind">{changes.records.includes(relevant.id) ? 'Latest reported change' : 'For this next step'}</p>
          <FactCard record={relevant} changed={changes.records.includes(relevant.id)} />
        </div>}
        {mode !== 'live' && question && question.question !== action?.question && <p className="clarification">{question.question}{question.beforeDate && <> · Before {dateLabel(question.beforeDate)}</>}</p>}
        {!outcome && <p>No financial conclusion yet.</p>}
        {responses.length > 0 && <p className="response-note" aria-label="Saved answers">
          {responses.some(item => item.response === 'unavailable') && 'Unconfirmed details remain open.'}
          {responses.some(item => item.response === 'declined') && ' Declined cuts are not assumed.'}
        </p>}
        <p className="fact-detail">{qualification}</p>
      </article>
      <ProposalReview snapshot={snapshot} active={proposalActive} locked={locked || stale} onCommand={onCommand} headingRef={proposalHeading} />
      <BudgetDetails plan={plan} facts={snapshot.facts} />
      {mode === 'live' ? <>
        <div className="fact-grid">{opening}{records.slice(0, 4).map(record => <FactCard key={record.id} record={record} changed={changes.records.includes(record.id)} />)}</div>
        {records.length > 4 && <>
          <p>Showing 4 of {records.length} reported items.</p>
          <Details label="View all figures" wide>{opening}{facts}</Details>
        </>}
      </> : <>
        <NextSteps plan={plan} facts={snapshot.facts} />
        <dl className="review-numbers" data-changed={changes.outcome}>
          <div><dt>{snapshot.accepted ? 'Assumed closing cash' : 'Projected closing cash'}</dt><dd>{money(plan.closingPaise)}</dd></div>
        </dl>
        {plan.firstGap && plan.closingPaise !== null && <p>Closing cash does not remove an earlier gap.</p>}
        <Details label="What this is based on" wide>{opening}{facts}</Details>
        {onInspect && <button type="button" onClick={onInspect}>Edit figures</button>}
      </>}
      <AssessmentDetails plan={plan} />
      {!!snapshot.invalidatedAssumptions?.length && <section aria-label="Assumptions needing fresh consent">
        <h3>Some assumptions need fresh consent</h3>
        <PagedList label="Affected assumptions" className="saved-items">{snapshot.invalidatedAssumptions.map(item => {
          const occurrence = changes.invalidated?.find(before => before.eventId === item.eventId)
            ?? snapshot.plan.events.find(event => event.id === item.eventId);
          return <li key={item.eventId}><strong>{occurrence ? `${occurrence.label} · ${dateLabel(occurrence.date)}` : 'A previously saved occurrence'}</strong><p>{item.reason}</p></li>;
        })}</PagedList>
        {snapshot.accepted && <p>Other saved assumptions remain in this picture. Reported facts are separate.</p>}
      </section>}
      {snapshot.accepted && <Details label="Saved planning assumptions"><Assumptions scenario={snapshot.accepted} /></Details>}
    </div>
  </section>;
}