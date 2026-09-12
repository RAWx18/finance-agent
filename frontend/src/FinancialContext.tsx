// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Command, Snapshot } from './api';
import type { components } from './contracts';
import { Details } from './Dialog';
import { dateLabel, decimal, lastDate, money } from './money';
import { PagedList } from './PagedList';
import { ActionDetails, actionLabels, Assumptions, outcomeLabels, ProposalReview } from './ScenarioDetails';
import { ConflictReview, Correction, fieldLabels, incomeChecks, reasons, ResultDetails, resultLabels, resultStates } from './WorkspaceDetails';
import type { Fact, WorkspaceCard } from './WorkspaceDetails';
import './financialCards.css';

const states = { known: 'Reported', estimated: 'Estimated', uncertain: 'Uncertain', missing: 'Not yet known', conflicting: 'Conflicting reports', proposed: 'Proposed · not saved', accepted: 'Saved assumption', unresolved: 'Needs checking' };
const sections = { facts: 'What you’ve shared', issues: 'Needs attention', timeline: 'Upcoming dates', decisions: 'Decisions & assumptions', outcome: 'Your outlook' };
const recurrence = { once: 'One time', weekly: 'Every week', fortnightly: 'Every two weeks', monthly: 'Every month' };
const changeStates = { created: 'Saved', updated: 'Corrected', deleted: 'Removed', merged: 'Duplicate combined', resolved: 'Conflict resolved', proposed: 'Proposal ready to review', accepted: 'Planning assumptions saved · no payment made', rejected: 'Proposal rejected · refusal saved', invalidated: 'Assumptions need fresh consent', discarded: 'Preview closed · not a refusal' };

function FinancialCard({ card, changed, fingerprint, children }: { card: WorkspaceCard; changed: boolean; fingerprint: string; children: ReactNode }) {
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!element.current?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const animation = element.current.animate([
      { boxShadow: 'inset 0 0 0 100vmax rgb(38 111 79 / 10%)' },
      { boxShadow: 'inset 0 0 0 100vmax rgb(38 111 79 / 0%)' },
    ], { duration: 650, easing: 'ease-out', iterations: 1 });
    return () => animation.cancel();
  }, [fingerprint]);
  return <article ref={element} className={`workspace-card workspace-${card.template}`} aria-label={card.title} data-changed={changed}>
    <header className="workspace-card-heading"><h4>{card.title}</h4><span className="state-label" data-state={card.state}>{states[card.state]}</span></header>
    {children}
  </article>;
}

function FactRow({ record, snapshot, blocked, onCommand }: { record: Fact; snapshot: Snapshot; blocked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined> }) {
  const conflicts = snapshot.facts.conflicts!.filter(item => item.recordId === record.id);
  const checks = record.kind === 'income' ? incomeChecks(record) : [];
  const exclusions = [...new Set(snapshot.workspace?.contributions?.filter(item => item.recordId === record.id && !item.included && !item.id.startsWith('proposal:')).map(item => reasons[item.reason]).filter(reason => !!reason))];
  const issues = snapshot.workspace?.issues?.filter(item => item.recordIds.includes(record.id)) ?? [];
  return <li className="fact-row" aria-label={record.label}>
    <div className="fact-row-heading"><h5>{record.label}</h5><p className="fact-amount">{money(record.amount.amountPaise)} <span>{conflicts.some(item => item.field === 'amount') ? 'Conflicting' : record.amount.status === 'estimate' ? 'Estimated' : record.amount.status === 'unknown' ? 'Not yet known' : 'Reported'}</span></p></div>
    {record.kind === 'debt' && <p>Required / minimum payment</p>}
    <p>{record.schedule.date ? <>{dateLabel(record.schedule.date)} · {record.schedule.certainty === 'exact' ? 'Confirmed date' : 'Estimated date'}</> : 'Date unknown · not included in dated balances'} · {recurrence[record.schedule.recurrence]}</p>
    {record.kind === 'income' ? <>
      <p>{record.reliability === 'reliable' ? 'Reliable receipt' : record.reliability === 'uncertain' ? 'Uncertain receipt' : 'Receipt reliability unknown'}</p>
      {checks.length > 0 && <p className="field-warning">Excluded from balances: {checks.join('; ')}.</p>}
      {exclusions.map(reason => <p className="field-warning" key={reason}>{reason}.</p>)}
    </> : <>
      <p>{record.kind === 'essential' ? 'Essential spending' : record.kind === 'optional' ? 'Optional spending' : record.debtType === 'card' ? 'Credit card' : record.debtType === 'unknown' ? 'Debt type not confirmed' : 'Loan or borrowing'} · {record.autoDebit ? 'Automatic debit reported' : 'Automatic debit not reported'}</p>
      <p>{record.controllability === 'committed' ? 'Already committed' : record.controllability === 'controllable' ? 'Changeable and not committed' : 'Whether this can change is not confirmed'}</p>
    </>}
    {record.target && <p>Selected target: {money(record.target.amountPaise)}{record.target.status === 'estimate' && ' · Estimated'} · Includes the minimum, not an extra payment.</p>}
    {(snapshot.accepted?.plan.events ?? []).filter(event => event.recordId === record.id && event.amountBasis === 'assumed').map(event => <p key={event.id}>Current plan: {money(event.amountPaise)} on {dateLabel(event.date)} · Saved assumption, not paid. Reported {record.target ? 'intended payment' : 'amount'} stays unchanged.</p>)}
    {record.outstanding && <p>Reported outstanding: {money(record.outstanding.amountPaise)}{record.outstanding.status === 'estimate' && ' · Estimated'} · Not reduced by planning assumptions.</p>}
    {conflicts.map(conflict => <ConflictReview key={conflict.id} conflict={conflict} snapshot={snapshot} blocked={blocked} onCommand={onCommand} />)}
    {issues.length > 0 && <Details label={`Checks for ${record.label}`}><PagedList label={`${record.label} checks`} className="evidence-list">{issues.map(issue => <li key={issue.id}><p>{issue.question}</p><p>{issue.reason}</p></li>)}</PagedList></Details>}
    <Correction record={record} snapshot={snapshot} blocked={blocked} onCommand={onCommand} />
  </li>;
}

export function changeNotes(snapshot: Snapshot, change: components['schemas']['WorkspaceChange'] | null | undefined): string[] {
  if (!change) return [];
  const notes: string[] = [];
  for (const item of change.items) {
    if (['accepted', 'rejected', 'discarded', 'invalidated', 'proposed', 'resolved', 'merged'].includes(item.state)) { notes.push(changeStates[item.state]); continue; }
    for (const field of item.fields ?? []) {
      const result = Object.keys(resultLabels).find(id => field.reference.startsWith(`workspace.results.${id}.`));
      const record = snapshot.facts.records.find(record => field.reference === `facts.records.${record.id}` || field.reference.startsWith(`facts.records.${record.id}.`));
      const tail = field.reference.split('.').at(-1)!;
      const value = (value: unknown): string => value === null ? 'Unknown' : typeof value === 'number' ? money(value)
        : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateLabel(value)
          : typeof value === 'string' && tail === 'label' ? value : '';
      if (result && ['amountPaise', 'date'].includes(tail)) notes.push(`${resultLabels[result]}: ${value(field.before)} → ${value(field.after)}`);
      else if (!result && (tail === 'amountPaise' || tail === 'date' || tail === 'label' || tail === 'reservePaise')) {
        const debtField = record?.kind === 'debt' && tail === 'amountPaise' ? field.reference.includes('.outstanding.') ? 'outstanding balance' : field.reference.includes('.target.') ? 'intended payment' : 'required payment' : null;
        const label = record ? `${record.label}${debtField ? ` · ${debtField}` : ''}` : field.reference.startsWith('facts.opening') ? 'Cash at plan start' : fieldLabels[tail];
        if (label) notes.push(`${label}${record && tail === 'date' ? ' date' : ''}: ${value(field.before)} → ${value(field.after)}`);
      } else if (item.state === 'created' || item.state === 'deleted') {
        const detail = (item.state === 'deleted' ? field.before : field.after) as { label?: string } | null;
        if (detail && typeof detail === 'object' && typeof detail.label === 'string') notes.push(`${detail.label}: ${changeStates[item.state].toLowerCase()}`);
      }
    }
  }
  if (notes.some(note => note.startsWith('Projected closing cash:'))
    && !notes.some(note => note.startsWith('First cash gap:'))
    && snapshot.workspace?.results?.some(result => result.id === 'firstGap' && result.date)) notes.push('The earlier cash gap amount and date are unchanged.');
  const priority = (note: string) => /fresh consent|First cash gap:|earlier cash gap/.test(note) ? 0 : 1;
  return [...new Set(notes)].sort((a, b) => priority(a) - priority(b));
}

export function FinancialContext({ snapshot, stale, mode, locked, onCommand, proposalActive }: {
  snapshot: Snapshot | null; stale: boolean; mode: 'live' | 'review' | 'finished';
  locked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>; proposalActive: boolean;
}) {
  const proposalHeading = useRef<HTMLHeadingElement>(null);
  const workspace = snapshot?.workspace;
  const [recent, setRecent] = useState({ sessionId: snapshot?.sessionId, change: workspace?.change });
  if (recent.sessionId !== snapshot?.sessionId || workspace?.change && workspace.change.id !== recent.change?.id)
    setRecent({ sessionId: snapshot?.sessionId, change: workspace?.change });
  const notes = snapshot ? changeNotes(snapshot, recent.sessionId === snapshot.sessionId ? recent.change : null) : [];
  const blocked = locked || stale;
  const plan = snapshot?.accepted?.plan ?? snapshot?.plan;
  const changed = recent.change?.items.flatMap(item => item.cardIds ?? []) ?? [];
  const cards = workspace?.cards ?? [];
  const renderResults = (card: WorkspaceCard, identities: string[]) => card.resultIds?.filter(id => identities.includes(id)).map(id => {
    const result = workspace!.results!.find(result => result.id === id)!;
    if (id === 'reserveShortfall' && !snapshot!.facts.reservePaise && !result.amountPaise) return null;
    return <div className="workspace-result" key={id}><p>{resultLabels[id] ?? 'Proposed result'}</p>
      <p className="result-value">{money(result.amountPaise)}{result.date && id !== 'closing' && <span> · {dateLabel(result.date)}</span>}</p>
      {result.state !== 'known' && <p className="hint">{resultStates[result.state]}</p>}
      <ResultDetails result={result} snapshot={snapshot!} />
    </div>;
  });
  function content(card: WorkspaceCard) {
    if (!snapshot || !workspace || !plan) return null;
    switch (card.template) {
      case 'cash': return <>
        <p className="result-value">{money(snapshot.facts.opening.amountPaise)}{snapshot.facts.opening.status === 'estimate' && <span> · Estimated</span>}</p>
        <p>At the start of this plan, before upcoming commitments. Not spare spending money.</p>
        {snapshot.facts.reservePaise > 0 && <p>Reserve floor: {money(snapshot.facts.reservePaise)} · Cash to keep aside, not spending.</p>}
        {snapshot.facts.conflicts!.filter(item => item.field === 'opening').map(item => <ConflictReview key={item.id} conflict={item} snapshot={snapshot} blocked={blocked} onCommand={onCommand} />)}
        <div className="detail-actions"><Correction snapshot={snapshot} blocked={blocked} onCommand={onCommand} />
          {workspace.results?.find(result => result.id === 'opening') && <ResultDetails snapshot={snapshot} result={workspace.results.find(result => result.id === 'opening')!} />}</div>
      </>;
      case 'income': case 'essential': case 'optional': case 'loans': case 'creditCards': return <>
        <PagedList label={card.title} className="fact-rows" printable={false}>{(card.recordIds ?? []).map(id => {
          const record = snapshot.facts.records.find(record => record.id === id)!;
          return <FactRow key={id} record={record} snapshot={snapshot} blocked={blocked} onCommand={onCommand} />;
        })}</PagedList>
        <div className="detail-actions">{card.resultIds?.map(id => workspace.results?.find(result => result.id === id)).filter(result => !!result).map(result =>
          <Details key={result.id} label={resultLabels[result.id] ?? 'Dated figures'}><p>{money(result.amountPaise)} · {resultStates[result.state]}</p><ResultDetails snapshot={snapshot} result={result} /></Details>)}</div>
      </>;
      case 'questions': return <ol className="workspace-questions">{workspace.questions?.filter(question => card.issueIds?.includes(question.id)).map(question => {
        const action = workspace.actions?.find(action => action.id === question.actionId);
        const issue = workspace.issues?.find(issue => issue.id === question.id);
        return <li key={question.id}><p className="question-title">{action?.question ?? issue?.question ?? 'Check this reported detail'}</p>
          <p>{question.why}</p>{question.beforeDate && <p>Before {dateLabel(question.beforeDate)}</p>}
          {action && ['clarify', 'confirmReceipt', 'verifyTerms', 'contactPayee', 'followUp', 'seekSupport', 'resolveGroup'].includes(action.kind) && <button type="button" className="detail-button" disabled={blocked} onClick={() => {
            if (!blocked) onCommand({ type: 'respondToAction', actionId: action.id, response: 'unavailable' });
          }}>{['clarify', 'confirmReceipt', 'verifyTerms'].includes(action.kind) ? 'I cannot confirm this now' : 'I cannot take this step now'}</button>}
        </li>;
      })}</ol>;
      case 'timeline': return <>
        <p>Payments come before income on the same day. Balances show requirements, not completed payments.</p>
        <PagedList label="Dated requirements" className="timeline-rows" ordered>{plan.events.filter(event => card.eventIds?.includes(event.id)).map(event => {
          const record = snapshot.facts.records.find(record => record.id === event.recordId);
          const amount = event.amountBasis === 'requiredOnly' ? record?.amount : record?.target ?? record?.amount;
          return <li key={event.id}><div className="timeline-date">{dateLabel(event.date)}{record?.schedule.certainty !== 'exact' && <span>Estimated date</span>}</div>
            <div><strong>{event.label}</strong><p>{event.kind === 'income' ? 'Expected income' : 'Payment due'} · {money(event.amountPaise)}</p>
              <p>{event.included ? event.amountBasis === 'assumed' ? 'Saved assumption · not paid' : amount?.status === 'estimate' ? 'Estimated requirement' : 'Reported requirement' : 'Excluded from balances'}{event.overdue && <> · Originally due {dateLabel(event.originalDueDate)}</>}</p>
              {record?.kind === 'debt' && <p>{event.amountBasis === 'requiredOnly' ? 'Required / minimum only · intended payment unknown' : record.target ? 'Intended payment · includes minimum' : 'Required / minimum payment'}</p>}
              {event.autoDebit && <p>Automatic debit reported</p>}
              {!event.included && record?.kind === 'income' && <p>{reasons[workspace.contributions?.find(item => item.eventId === event.id && !item.id.startsWith('proposal:'))?.reason ?? '']} {incomeChecks(record).join('; ')}</p>}
              <p>Balance after: <strong>{money(event.balancePaise)}</strong></p>
            </div></li>;
        })}</PagedList>
        <div className="result-grid">{renderResults(card, ['closing', 'trough'])}</div>
        <p>Closing cash is not spare spending money. Missing amounts and dates are not treated as zero.</p>
      </>;
      case 'gap': {
        const gap = workspace.results?.find(result => result.id === 'firstGap');
        const witnesses = workspace.results?.filter(result => card.resultIds?.includes(result.id)).flatMap(result => result.witnessEventIds ?? []) ?? [];
        return <><div className="result-grid">{renderResults(card, ['firstGap', 'peakGap', 'reserveShortfall'])}</div>
          {plan.events.filter(event => witnesses.includes(event.id)).map(event => <p key={event.id}><strong>{event.label}</strong> · {money(event.amountPaise)} due {dateLabel(event.date)} brings the balance to {money(event.balancePaise)}.</p>)}
          {gap?.date && <Details label="Payments and later receipts"><PagedList label="Cash gap timing" className="evidence-list">{workspace.contributions!.filter(item =>
            gap.contributionIds.includes(item.id) || gap.excludedIds.includes(item.id) && item.date && item.date >= gap.date! && snapshot.facts.records.some(record => record.id === item.recordId && record.kind === 'income'))
            .map(item => <li key={item.id}><strong>{snapshot.facts.records.find(record => record.id === item.recordId)?.label ?? 'Opening cash'}</strong> · {money(item.amountPaise)}{item.date && <> · {dateLabel(item.date)}</>}
              <p>{gap.excludedReasons?.[item.id] ? reasons[gap.excludedReasons[item.id]] : item.date && item.date > gap.date! ? 'Later receipt: cannot cover the earlier deadline.' : 'Part of the position at the first gap.'}{!item.included && ' Not counted in balances.'}</p></li>)}</PagedList></Details>}
        </>;
      }
      case 'proposal': return <ProposalReview snapshot={snapshot} active={proposalActive} locked={blocked} onCommand={onCommand} headingRef={proposalHeading} />;
      case 'assumptions': return snapshot.accepted && <><Assumptions scenario={snapshot.accepted} /><p>Reported facts remain separate. Accepted does not mean paid.</p></>;
      case 'invalidation': return <><p>These assumptions are no longer included. Review a fresh proposal before consenting again.</p><PagedList label="Affected assumptions" className="evidence-list">{card.rows?.map(row => <li key={row.field}>{typeof row.value === 'string' ? row.value : 'A saved assumption needs checking.'}</li>) ?? []}</PagedList>{snapshot.accepted && <p>Unaffected saved assumptions remain in the picture.</p>}</>;
      case 'outcome': {
        const outcome = plan.decisionAssessment?.outcome;
        return <>{outcome && <>
          <p className="question-title">{outcome.readiness === 'qualified' ? 'Your picture is still taking shape' : outcomeLabels[outcome.branch]}</p>
          <p>{outcome.summary}</p><p>{outcome.notCovered}</p>
          <Details label="Plan details"><p>{outcome.covered}</p><p>{outcome.conditions}</p><p>{outcome.nextStep}</p><p>{outcome.revisit}</p></Details>
        </>}
          {!!snapshot.facts.decision?.responses?.length && <p aria-label="Saved answers">{snapshot.facts.decision.responses.some(item => item.response === 'unavailable') && 'Unconfirmed details remain open.'}{snapshot.facts.decision.responses.some(item => item.response === 'declined') && ' Declined cuts are not assumed.'}</p>}
          {workspace.actions && workspace.actions.some(action => !workspace.questions?.some(question => question.actionId === action.id)) && <section aria-label="Next steps"><h5>Next steps</h5><ol className="workspace-questions">{workspace.actions.filter(action => !workspace.questions?.some(question => question.actionId === action.id)).map(action => {
            const choice = workspace.choices?.find(choice => choice.id === action.choiceId);
            const label = action.recordIds.map(id => snapshot.facts.records.find(record => record.id === id)?.label).filter(Boolean).join(', ');
            return <li key={action.id}><p><strong>{actionLabels[action.kind] ?? 'Next step'}</strong>{label && <> · {label}</>}{action.beforeDate && <> · Before {dateLabel(action.beforeDate)}</>}</p><p>{action.question}</p>
              <Details label={`Details: ${actionLabels[action.kind] ?? 'Next step'}${label ? ` · ${label}` : ''}`}><ActionDetails action={action} plan={{ ...plan, decisionAssessment: { ...plan.decisionAssessment, choices: workspace.choices } }} facts={snapshot.facts} /></Details>
              {['clarify', 'confirmReceipt', 'verifyTerms', 'contactPayee', 'followUp', 'seekSupport', 'resolveGroup'].includes(action.kind) && <button disabled={blocked} onClick={() => {
                if (!blocked) onCommand({ type: 'respondToAction', actionId: action.id, response: 'unavailable' });
              }}>{['clarify', 'confirmReceipt', 'verifyTerms'].includes(action.kind) ? 'I cannot confirm this now' : 'I cannot take this step now'}</button>}
              {action.kind === 'previewChange' && !!choice?.adjustmentAmounts.length && <button disabled={blocked} onClick={() => {
                if (!blocked) onCommand({ type: 'respondToAction', actionId: action.id, response: 'declined' });
              }}>Do not suggest this cut</button>}
              {action.kind === 'previewChange' && !!choice?.adjustmentAmounts.length && <button disabled={blocked || !!snapshot.preview} onClick={() => {
                if (!blocked && !snapshot.preview) onCommand({ type: 'previewAdjustments', adjustments: choice.adjustmentAmounts.map(item => ({ eventId: item.eventId, amount: decimal(item.amountPaise) })) });
              }}>Compare this change</button>}
            </li>;
          })}</ol></section>}
          {!!workspace.issues?.some(issue => !workspace.questions?.some(question => question.id === issue.id)) && <section aria-label="Other open checks"><h5>Still needs checking</h5>
            <PagedList label="Other open checks" className="evidence-list">{workspace.issues.filter(issue => !workspace.questions?.some(question => question.id === issue.id)).map(issue =>
              <li key={issue.id}><p className="question-title">{issue.question}</p><p>{issue.reason}</p>{issue.beforeDate && <p>Before {dateLabel(issue.beforeDate)}</p>}<p>Still open · not confirmed</p></li>)}</PagedList>
          </section>}
        </>;
      }
    }
  }
  return <section className="financial-context" aria-label="Your financial picture">
    <header className="context-heading"><h2>{mode === 'live' ? 'Your financial picture' : 'Your 30-day plan'}</h2>
      {snapshot && <p className="context-period">{dateLabel(snapshot.anchorDate)} – {dateLabel(lastDate(snapshot.endDateExclusive))}</p>}
    </header>
    <div className="context-updates">
      <div className="change-note" role="status" aria-live="polite" aria-atomic="true">{stale ? 'Updates paused · showing saved figures' : notes.length > 0 && <><p>Latest saved change</p><ul>{notes.slice(0, 3).map(note => <li key={note}>{note}</li>)}</ul></>}</div>
      {notes.length > 0 && <Details label="Recent changes"><PagedList label="Recent changes" className="evidence-list">{notes.map(note => <li key={note}>{note}</li>)}</PagedList></Details>}
      {cards.some(card => card.template === 'proposal') && <button type="button" className="detail-button" disabled={!proposalActive} onClick={() => proposalHeading.current?.focus()}>Review proposed change</button>}
    </div>
    <div className="context-scroll" tabIndex={0} role="region" aria-label="Financial picture details">
      {!cards.length && <div className="context-empty"><h3>No figures yet</h3><p>They’ll appear as you talk.</p></div>}
      {(Object.keys(sections) as (keyof typeof sections)[]).map(section => {
        const group = cards.filter(card => card.section === section);
        return group.length > 0 && <section className="workspace-section" aria-label={sections[section]} key={section}><h3>{sections[section]}</h3>
          {group.map(card => <FinancialCard key={card.id} card={card} changed={changed.includes(card.id)} fingerprint={JSON.stringify([card,
            snapshot?.facts.records.filter(record => card.recordIds?.includes(record.id)), workspace?.results?.filter(result => card.resultIds?.includes(result.id)),
            snapshot?.facts.conflicts?.filter(conflict => card.recordIds?.includes(conflict.recordId ?? '') || card.template === 'cash' && conflict.field === 'opening'),
            plan?.events.filter(event => card.eventIds?.includes(event.id))])}>{content(card)}</FinancialCard>)}
        </section>;
      })}
    </div>
  </section>;
}