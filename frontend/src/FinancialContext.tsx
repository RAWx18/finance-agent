// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, useCallback, useId, useState } from 'react';
import type { Command, Plan, Snapshot } from './api';
import type { components } from './contracts';
import { CardField, ChangedValue } from './CardField';
import { CardProposal } from './CardProposal';
import { cardDate, cardMoney, cardStatus, fieldConflict, fieldDraft, sourceAmount } from './cardFields';
import type { CardTarget } from './cardFields';
import { dateLabel, lastDate, money, recurrenceLabels } from './money';
import { FinancialStatus } from './FinancialStatus';
import { FinalPlan } from './FinalPlan';
import { GapFigure } from './PlanSummary';
import { fieldLabels, resultLabels } from './WorkspaceDetails';
import type { Fact, WorkspaceCard } from './WorkspaceDetails';
import './financialCards.css';

const changeStates = { created: 'Saved', updated: 'Corrected', deleted: 'Removed', merged: 'Duplicate combined', resolved: 'Conflict resolved', proposed: 'Proposal ready to review', accepted: 'Planning assumptions saved · no payment made', rejected: 'Proposal rejected · refusal saved', invalidated: 'Assumptions need fresh consent', discarded: 'Preview closed · not a refusal' };

/** Summarizes workspace changes, prioritizing consent and cash-gap notices. */
export function changeNotes(snapshot: Snapshot, change: components['schemas']['WorkspaceChange'] | null | undefined): string[] {
  if (!change) return [];
  const notes: string[] = [];
  for (const item of change.items) {
    if (['accepted', 'rejected', 'discarded', 'invalidated', 'proposed', 'resolved', 'merged'].includes(item.state)) { notes.push(changeStates[item.state]); continue; }
    for (const field of item.fields ?? []) {
      const result = Object.keys(resultLabels).find(id => field.reference.startsWith(`workspace.results.${id}.`));
      const record = snapshot.facts.records.find(record => field.reference === `facts.records.${record.id}` || field.reference.startsWith(`facts.records.${record.id}.`));
      const tail = field.reference.split('.').at(-1)!;
      /** Formats a changed amount, date, or name for a before-and-after notice. */
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
  /** Ranks consent and cash-gap notices ahead of other changes. */
  const priority = (note: string) => /fresh consent|First cash gap:|earlier cash gap/.test(note) ? 0 : 1;
  return [...new Set(notes)].sort((a, b) => priority(a) - priority(b));
}

type Editing = { snapshot: Snapshot; blocked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>; onEditingChange?: (id: string, open: boolean, saved?: Snapshot) => void };

/** Displays an editable source amount with its reporting or conflict status. */
function AmountField({ target, label, prefix = '', suffix = '', reported = false, ...editing }: Editing & { target: CardTarget; label: string; prefix?: string; suffix?: string; reported?: boolean }) {
  const draft = fieldDraft(editing.snapshot, target);
  const conflict = fieldConflict(editing.snapshot, target);
  return <CardField {...editing} target={target} label={label}>
    <span className="card-number"><ChangedValue value={`${draft.status === 'unknown' ? '' : prefix}${sourceAmount(draft.source!)}${suffix}`} /></span>
    {(conflict || reported || draft.status === 'estimate') && <span className="card-badge" data-tone={conflict || draft.status !== 'exact' ? 'caution' : undefined}>{conflict ? 'Conflicting' : cardStatus[draft.status]}</span>}
  </CardField>;
}

/** Presents starting cash, the reserve floor, and projected cash risks. */
function CashCard({ card, ...editing }: Editing & { card: WorkspaceCard }) {
  const { snapshot } = editing;
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const results = snapshot.workspace?.results?.filter(result => card.resultIds?.includes(result.id));
  const reserve = results?.find(result => result.id === 'reserveShortfall');
  const gap = results?.find(result => result.id === 'firstGap');
  const reserveRisk = plan.decisionAssessment?.consequences?.find(item => item.kind === 'reserveBreach');
  const peakTiming = plan.timingRisks?.find(item => item.date === plan.peakGapDate);
  const laterRisk = plan.timingRisks?.some(item => item.date === plan.firstGap?.date)
    ? plan.decisionAssessment?.consequences?.find(item => item.kind === 'cashExposure' && item.date && plan.firstGap && item.date > plan.firstGap.date) : undefined;
  const laterTiming = plan.timingRisks?.find(item => item.date === laterRisk?.date);
  return <>
    <div className="card-cash"><span className="card-caption">Cash at plan start</span>
      <AmountField {...editing} target={{ field: 'opening' }} label="Cash at plan start" reported />
      <span className="card-meta">As of {cardDate(snapshot.anchorDate)} · Reported, not a bank feed</span>
    </div>
    {snapshot.facts.reservePaise > 0 && <div className="card-metric"><span className="card-caption">Keep aside</span>
      <AmountField {...editing} target={{ field: 'reserve' }} label="Reserve floor" />
      {reserve?.amountPaise != null && reserve.amountPaise > 0 && <span className="card-meta card-caution">Buffer at risk · <ChangedValue value={cardMoney(reserveRisk?.amountPaise ?? reserve.amountPaise)} /> below reserve{reserveRisk?.date && ` · ${cardDate(reserveRisk.date)}`}.{reserveRisk?.amountPaise != null && reserveRisk.amountPaise !== reserve.amountPaise && ` Largest buffer shortfall: ${cardMoney(reserve.amountPaise)}.`} Separate from payment shortfalls.</span>}
    </div>}
    {plan.firstGap && <div className="card-risk"><GapFigure plan={plan} />
      {gap && ['estimated', 'conflicting', 'uncertain', 'unresolved'].includes(gap.state) && <span className="card-meta">{gap.state === 'estimated' ? 'Includes estimates' : 'Figures need checking'}</span>}
      {plan.peakGapPaise != null && plan.peakGapPaise > plan.firstGap.amountPaise && <p className="card-meta">{peakTiming ? 'Largest timing exposure' : 'Largest shortfall'} · {cardMoney(plan.peakGapPaise)}{plan.peakGapDate && ` · ${cardDate(plan.peakGapDate)}`}{peakTiming && <> · Needed before same-day income. {peakTiming.remainingGapPaise > 0 ? `${cardMoney(peakTiming.remainingGapPaise)} still unfunded after included income.` : 'No remaining gap after included income; payment timing is not guaranteed.'}</>}</p>}
      {laterRisk && <p className="card-meta">Later payment risk · {cardMoney(laterRisk.amountPaise)}{laterTiming && ' · Needed before same-day income'}{laterRisk.date && ` · ${cardDate(laterRisk.date)}`}{laterTiming && <>. {laterTiming.remainingGapPaise > 0 ? `${cardMoney(laterTiming.remainingGapPaise)} still unfunded after included income.` : 'No remaining gap after included income; payment timing is not guaranteed.'}</>}</p>}
    </div>}
  </>;
}

/** Offers corrections to a record's reported currency-conversion terms. */
function SourceTerms({ target, record, ...editing }: Editing & { target: CardTarget; record: Fact }) {
  const conversion = fieldDraft(editing.snapshot, target).source?.conversion;
  if (!conversion || fieldConflict(editing.snapshot, target)) return null;
  return <div className="card-term-fields"><span className="card-caption">{conversion.currency} conversion terms</span>
    <CardField {...editing} target={{ ...target, term: 'rate' }} label={`${record.label} exchange rate`}>
      <span>Rate {conversion.rate == null ? 'Unknown' : `₹${conversion.rate} / ${conversion.currency}`}</span><span className="card-badge">{cardStatus[conversion.rateStatus]}</span>
    </CardField>
    <CardField {...editing} target={{ ...target, term: 'fee' }} label={`${record.label} INR deduction`}>
      <span>INR deduction {sourceAmount({ amount: conversion.fee ?? null, status: conversion.feeStatus })}</span><span className="card-badge">{cardStatus[conversion.feeStatus]}</span>
    </CardField>
    <CardField {...editing} target={{ ...target, term: 'rateDate' }} label={`${record.label} rate date`}>
      <span>Rate as of {conversion.rateDate ? cardDate(conversion.rateDate) : 'Unknown'}</span>
    </CardField>
  </div>;
}

/** Presents an editable commitment or receipt with its timing, amounts, and qualifications. */
function FactRow({ record, event, ...editing }: Editing & { record: Fact; event?: Plan['events'][number] }) {
  const { snapshot } = editing;
  const variable = !!record.schedule.amounts?.length;
  const budget = record.schedule.recurrence === 'monthlyBudget';
  const debt = record.kind === 'debt';
  // Visible event positions are not schedule positions; corrections must target the original occurrence index.
  const index = variable ? event?.scheduleIndex ?? undefined : undefined;
  const target: CardTarget = { recordId: record.id, field: debt && record.target?.amountPaise != null && !variable ? 'target' : 'amount', ...(index !== undefined ? { index } : {}) };
  const converted = target.field === 'target' ? record.target : record.amount;
  const source = variable && index === undefined ? null : fieldDraft(snapshot, target).source;
  const date = budget ? record.schedule.date : event ? event.overdue ? event.originalDueDate : event.date : record.schedule.date;
  const dateFieldLabel = `${record.label} ${record.schedule.recurrence === 'once' ? 'date' : 'series start'}`;
  const dateConflict = fieldConflict(snapshot, { recordId: record.id, field: 'schedule.date' });
  const assumed = (snapshot.accepted?.adjustments ?? []).find(item => item.eventId === event?.id);
  const issue = snapshot.workspace?.issues?.find(item => item.recordIds.includes(record.id) && ['conflict', 'uncertain'].includes(item.kind));
  const series = record.schedule.endDate || record.schedule.count || record.schedule.recurrence !== 'once' && record.schedule.date !== date;
  return <li className="card-record" aria-label={record.label} data-income={record.kind === 'income'}>
    <CardField {...editing} target={{ recordId: record.id, field: 'label' }} label={`${record.label} name`} className="card-name"><ChangedValue value={record.label} /></CardField>
    {source ? <div className="card-record-amount">
      {debt && <span className="card-caption">{target.field === 'target' ? 'Intended payment' : record.debtType === 'card' ? 'Minimum payment' : 'Required payment'}</span>}
      <AmountField {...editing} target={target} label={`${record.label} ${target.field === 'target' ? 'target' : debt ? 'required amount' : index !== undefined ? `occurrence ${index + 1} amount` : 'amount'}`} prefix={record.kind === 'income' ? '+' : '−'} suffix={budget ? '/month' : ''} />
      {budget && <span className="card-meta">Daily forecast · not a payment due</span>}
      {index !== undefined && <span className="card-meta">Occurrence {index + 1} of {record.schedule.amounts!.length}</span>}
      {source.conversion && <span className="card-net" aria-label={`${record.label} calculated net INR`}>Net INR <strong><ChangedValue value={cardMoney(index === undefined ? converted?.amountPaise ?? null : event?.amountPaise ?? null)} /></strong><span className="card-meta">Calculated{(index === undefined ? converted?.status : event?.amountStatus) === 'estimate' ? ' · Est.' : ''}</span></span>}
    </div> : <div className="card-record-amount card-meta">Varies by occurrence</div>}
    <div className="card-row-meta">
    <CardField {...editing} target={{ recordId: record.id, field: 'schedule.date' }} label={dateFieldLabel} className="card-date">
      <span><ChangedValue value={date ? `${event?.dateAssumption ? 'Assumed' : budget ? 'Starts' : event?.overdue ? 'Originally due' : record.kind === 'income' ? 'Expected' : 'Due'} ${cardDate(date)}` : record.kind === 'income' ? 'Arrival date unknown' : 'Payment date unknown'} /></span>
      {(dateConflict || date && record.schedule.certainty !== 'exact') && <span className="card-badge" data-tone="caution">{dateConflict ? 'Conflicting' : event?.dateAssumption ? 'Calculated' : cardStatus[record.schedule.certainty]}</span>}
      {record.schedule.recurrence !== 'once' && !budget && <span className="card-meta">{recurrenceLabels[record.schedule.recurrence]}</span>}
    </CardField>
    <div className="card-row-status">
      {record.autoDebit && <span className="card-badge">Auto-debit</span>}
      {record.kind === 'income' && (record.reliability !== 'reliable' || event && !event.included) && <span className="card-badge" data-tone="caution">Not counted on{record.reliability !== 'reliable' ? ' · Receipt unconfirmed' : ''}</span>}
      {event?.overdue && <span className="card-meta">Payment status unconfirmed</span>}
      {record.kind !== 'income' && record.controllability === 'committed' && <span className="card-meta">Committed</span>}
    </div>
    </div>
    {event?.dateAssumption && <p className="card-row-note card-meta">{record.schedule.pattern
      ? <>From your {record.schedule.pattern.kind === 'monthEnd' ? 'month-end' : `monthly day ${record.schedule.pattern.day}`} pattern. Editing timing replaces or removes the pattern for the whole series, not one occurrence.</>
      : event.dateAssumption}</p>}
    {debt && !variable && <div className="card-secondary"><span className="card-caption">{target.field === 'amount' ? 'Intended payment' : record.debtType === 'card' ? 'Minimum payment' : 'Required payment'}</span>
      <AmountField {...editing} target={{ recordId: record.id, field: target.field === 'amount' ? 'target' : 'amount' }} label={`${record.label} ${target.field === 'amount' ? 'target' : 'required amount'}`} /></div>}
    {assumed && <p className="card-row-note card-meta">Plan {cardMoney(assumed.amountPaise)} · Saved assumption, not paid</p>}
    {(source?.conversion || !source || debt && record.outstanding || issue?.reason || series) && <details className="card-terms card-record-details"><summary>Details</summary>
      {!source && <ol className="card-source-list">{record.schedule.amounts!.map((_, index) => <li key={index}>
      <span className="card-caption">Occurrence {index + 1}</span><AmountField {...editing} target={{ recordId: record.id, field: 'amount', index }} label={`${record.label} occurrence ${index + 1} amount`} />
      <SourceTerms {...editing} target={{ recordId: record.id, field: 'amount', index }} record={record} />
    </li>)}</ol>}
    {source?.conversion && <SourceTerms {...editing} target={target} record={record} />}
    {debt && record.outstanding && <div className="card-secondary"><span className="card-caption">Outstanding</span>
      <AmountField {...editing} target={{ recordId: record.id, field: 'outstanding' }} label={`${record.label} outstanding`} /></div>}
    {issue?.reason && <p className="card-meta">{issue.reason}</p>}
    {series && <p className="card-meta">
      Series starts {record.schedule.date ? cardDate(record.schedule.date) : 'Unknown'}{record.schedule.endDate && <> · Through {cardDate(record.schedule.endDate)}</>}{record.schedule.count && <> · {record.schedule.count} {budget ? 'months' : 'occurrences'}</>}
    </p>}
    </details>}
  </li>;
}

const issueLabels: Record<string, string> = { opening: 'Cash at plan start', amount: 'Amount', target: 'Target', outstanding: 'Outstanding', 'schedule.date': 'Date', reliability: 'Receipt', controllability: 'Changeability', coverage: 'Unreported commitments', providerResponses: 'Payment agreement', recordIdentity: 'Which commitment', currencyConversion: 'Conversion terms', schedule: 'Schedule' };
/** Presents an unresolved financial detail and any available inline correction. */
function UncertaintyCard({ card, ...editing }: Editing & { card: WorkspaceCard }) {
  const issue = editing.snapshot.workspace?.issues?.find(issue => card.issueIds?.includes(issue.id));
  if (!issue) return null;
  const record = editing.snapshot.facts.records.find(record => record.id === issue.recordIds[0]);
  const field = (['opening', 'amount', 'target', 'outstanding', 'schedule.date'] as const).find(field => field === issue.field);
  const status = issue.kind === 'conflict' ? 'Conflicting' : issue.kind === 'missing' ? 'Unknown' : 'Unconfirmed';
  return <div className="card-uncertainty">
    <span className="card-caption">{record?.label ?? 'Plan'} · {issueLabels[issue.field] ?? 'Unconfirmed detail'}</span>
    {field && (field === 'opening' || record) && !(field === 'amount' && record?.schedule.amounts?.length) ? field === 'schedule.date'
      ? <CardField {...editing} target={{ recordId: record!.id, field }} label={`${record!.label} ${record!.schedule.recurrence === 'once' ? 'date' : 'series start'}`}><span>{record!.schedule.date ? cardDate(record!.schedule.date) : 'Unknown'}</span><span className="card-badge" data-tone="caution">{status}</span></CardField>
      : <AmountField {...editing} target={{ ...(field === 'opening' ? {} : { recordId: record!.id }), field }} label={field === 'opening' ? 'Cash at plan start' : `${record!.label} ${field}`} />
      : <span className="card-badge" data-tone="caution">{status}</span>}
    {issue.field === 'controllability' && <p className="card-meta">Confirm whether this spending can be reduced or skipped.</p>}
    {issue.reason && <details className="card-terms"><summary>Why this matters</summary><p>{issue.reason}</p></details>}
    {issue.beforeDate && <span className="card-meta">Before {cardDate(issue.beforeDate)}</span>}
  </div>;
}

/** Organizes financial companion cards while keeping focused commitment editors stable. */
function CompanionCards({ proposalActive, editingActive, ...editing }: Editing & { proposalActive: boolean; editingActive: boolean }) {
  const { snapshot } = editing;
  const [expanded, setExpanded] = useState(false);
  const [focusedIds, setFocusedIds] = useState<string[] | null>(null);
  const listId = useId();
  const cards = snapshot.workspace?.cards ?? [];
  const timeline = cards.find(card => card.template === 'timeline');
  // Keep mounted editors and their position until focus leaves the commitment list.
  const visibleIds = focusedIds ?? timeline?.recordIds?.slice(0, expanded ? undefined : 4) ?? [];
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  return <>{cards.filter(card => ['cash', 'timeline', 'questions', 'proposal'].includes(card.template)).map(card => {
    if (card.template === 'questions') {
      const issue = snapshot.workspace?.issues?.find(issue => card.issueIds?.includes(issue.id));
      if (!issue) return null;
      const askable = snapshot.workspace?.questions?.some(question => question.id === issue.id && question.actionId);
      const inline = ['schedule.date', 'reliability'].includes(issue.field) || ['amount', 'target'].includes(issue.field)
        && issue.recordIds.every(id => !snapshot.facts.records.find(record => record.id === id)?.schedule.amounts?.length);
      if (issue.recordIds.length > 0 && issue.recordIds.every(id => visibleIds.includes(id)) && (!askable || inline)
        || ['opening', 'reserve'].includes(issue.field) && cards.some(card => card.template === 'cash')) return null;
    }
    const title = card.template === 'timeline' ? 'Commitments & income' : card.title;
    return <Fragment key={card.id}><article className={`companion-card companion-${card.template}`} aria-label={title}>
      <h3>{title}</h3>
      {card.template === 'cash' && <CashCard {...editing} card={card} />}
      {card.template === 'timeline' && <><ol id={listId} className="card-records" aria-label="Next commitments"
        onFocusCapture={() => { if (!focusedIds) setFocusedIds(visibleIds); }}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.querySelector('form')) setFocusedIds(null); }}>{visibleIds.map(id => {
        const record = snapshot.facts.records.find(record => record.id === id);
        return record && <FactRow key={id} {...editing} record={record} event={plan.events.find(event => event.recordId === id && card.eventIds?.includes(event.id))} />;
      })}</ol>{(card.recordIds?.length ?? 0) > 4 && <button className="card-expand" aria-expanded={expanded} aria-controls={listId} disabled={editingActive} onClick={() => { setFocusedIds(null); setExpanded(!expanded); }}>{expanded ? 'Show fewer commitments' : `Show ${card.recordIds!.length - 4} more`}</button>}</>}
      {card.template === 'questions' && <UncertaintyCard {...editing} card={card} />}
      {card.template === 'proposal' && <CardProposal {...editing} active={proposalActive} />}
    </article>{(card.template === 'timeline' || card.template === 'cash' && !timeline) && <FinancialStatus snapshot={snapshot} />}</Fragment>;
  })}</>;
}

/** Keeps manual corrections open until cancelled or confirmed against the displayed revision. */
function FinancialCards({ snapshot, blocked, onCommand, proposalActive }: Editing & { proposalActive: boolean }) {
  const [editing, setEditing] = useState<{ manual: boolean; fields: string[]; saved?: { revision: number; sequence: number } }>({ manual: false, fields: [] });
  const onEditingChange = useCallback((id: string, open: boolean, saved?: Snapshot) => {
    setEditing(editing => ({
      manual: open || editing.manual,
      fields: open ? [...new Set([...editing.fields, id])] : editing.fields.filter(field => field !== id),
      saved: open ? undefined : saved ? { revision: saved.revision, sequence: saved.sequence } : editing.saved,
    }));
  }, []);
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const ready = !!plan.decisionAssessment?.outcome?.planReady && !blocked && !snapshot.preview;
  const saved = editing.saved && snapshot.revision >= editing.saved.revision && snapshot.sequence >= editing.saved.sequence;
  const manual = editing.fields.length > 0 || editing.manual && !saved;
  if (ready && !manual) return <FinalPlan snapshot={snapshot} onEdit={() => setEditing({ manual: true, fields: [] })} />;
  return <>
    {editing.manual && <button type="button" className="card-expand" disabled={!ready || editing.fields.length > 0 || !!editing.saved && !saved} onClick={() => setEditing({ manual: false, fields: [] })}>Done editing</button>}
    {!snapshot.workspace?.cards?.length ? <p className="context-empty">Figures appear as you talk</p>
      : <CompanionCards snapshot={snapshot} blocked={blocked} onCommand={onCommand} proposalActive={proposalActive} editingActive={editing.fields.length > 0} onEditingChange={onEditingChange} />}
  </>;
}

/** Shows the conversation's financial picture and saved-change notices. */
export function FinancialContext({ snapshot, stale, locked, onCommand, proposalActive }: {
  snapshot: Snapshot | null; stale: boolean;
  locked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>; proposalActive: boolean;
}) {
  const change = snapshot?.workspace?.change;
  const decision = change?.items.find(item => ['accepted', 'rejected', 'discarded', 'invalidated'].includes(item.state));
  const notes = snapshot && change?.items.some(item => ['updated', 'resolved'].includes(item.state)) ? changeNotes(snapshot, change).slice(0, 2) : [];
  return <section className="financial-context" aria-label="Your financial picture">
    <header className="context-heading"><h2>Your financial picture</h2>
      {snapshot && <p className="context-period">{cardDate(snapshot.anchorDate)} – {cardDate(lastDate(snapshot.endDateExclusive))}</p>}
    </header>
    <div className="card-update" role="status" aria-live="polite" aria-atomic="true">{stale ? 'Updates paused · showing saved figures' : decision ? changeStates[decision.state] : notes.length ? `Saved · ${notes.join(' · ')}` : ''}</div>
    <div className="context-scroll" tabIndex={0} role="region" aria-label="Financial picture details">
      {!snapshot ? <p className="context-empty">Figures appear as you talk</p>
        : <FinancialCards key={snapshot.sessionId} snapshot={snapshot} blocked={locked || stale} onCommand={onCommand} proposalActive={proposalActive} />}
    </div>
  </section>;
}