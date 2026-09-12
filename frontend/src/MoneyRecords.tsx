// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { Command, Snapshot } from './api';
import type { Fact } from './WorkspaceDetails';
import { ConflictReview, incomeChecks, reasons } from './WorkspaceDetails';
import { Details } from './Dialog';
import { dateLabel, money } from './money';
import { MoneyIcon } from './MoneyIcon';
import { PagedList } from './PagedList';
import type { EditTarget } from './MoneyEdit';
import { moneyIssues } from './MoneyChecks';

export const coverageLabels = { notDiscussed: 'Not checked', reported: 'Some shared', unknown: 'Not sure', reviewed: 'Reviewed', none: 'None reported' };
const recurrence = { once: 'Once', weekly: 'Weekly', fortnightly: 'Every two weeks', monthly: 'Monthly' };
export const amountStatus = { exact: 'Reported', estimate: 'Estimated', unknown: 'Unknown' };

export function factStatus(snapshot: Snapshot, field: 'opening' | 'amount' | 'target' | 'outstanding' | 'schedule.date', record?: Fact) {
  if (snapshot.facts.conflicts?.some(item => item.recordId === (record?.id ?? null) && item.field === field)) return 'Conflicting reports';
  if (field === 'schedule.date') return record?.schedule.date ? amountStatus[record.schedule.certainty] : 'Unknown';
  const value = field === 'opening' ? snapshot.facts.opening : record?.[field];
  return value ? amountStatus[value.status] : 'Not supplied';
}

export function needsCheck(record: Fact, snapshot: Snapshot) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  return record.amount.status !== 'exact' || !!record.schedule.date && record.schedule.certainty !== 'exact'
    || record.kind === 'income' && record.reliability !== 'reliable'
    || !!record.target && record.target.status !== 'exact' || !!record.outstanding && record.outstanding.status !== 'exact'
    || snapshot.facts.conflicts?.some(item => item.recordId === record.id)
    || plan.budgetBasis.unresolvedAmounts.some(item => item.recordId === record.id)
    || moneyIssues(snapshot).some(item => item.recordIds.includes(record.id));
}

export function RecordRow({ record, snapshot, blocked, onEdit, onCommand }: {
  record: Fact; snapshot: Snapshot; blocked: boolean; onEdit: (target: EditTarget) => void;
  onCommand: (operation: Command['operation']) => void;
}) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const conflicts = snapshot.facts.conflicts?.filter(item => item.recordId === record.id) ?? [];
  const events = plan.events.filter(event => event.recordId === record.id);
  const missingDate = plan.budgetBasis.unresolvedAmounts.some(item => item.recordId === record.id && item.reason === 'missingDate');
  const exclusions = [...new Set(snapshot.workspace?.contributions?.filter(item => item.recordId === record.id && !item.included && !item.id.startsWith('proposal:'))
    .map(item => reasons[item.reason]).filter(Boolean))];
  const fieldAmount = (field: 'amount' | 'target' | 'outstanding') => <>
    <strong>{record[field] ? money(record[field].amountPaise) : 'Not supplied'}</strong>
    <span className="money-meta">{record[field] || conflicts.some(item => item.field === field) ? factStatus(snapshot, field, record) : ''}</span>
  </>;
  return <li className="money-record" aria-label={record.label}>
    <div className="money-record-head"><div><h3>{record.label}</h3><p className="money-meta">
      {record.kind === 'income' ? 'Expected' : 'Due'} {record.schedule.date ? dateLabel(record.schedule.date) : 'date unknown'}
      {conflicts.some(item => item.field === 'schedule.date') ? ' · Conflicting dates' : record.schedule.date ? ` · ${amountStatus[record.schedule.certainty]}` : ''}
      {record.schedule.recurrence !== 'once' && ` · ${recurrence[record.schedule.recurrence]}`}
    </p></div><div className="money-row-actions no-print">
      <button className="icon-button" disabled={blocked} aria-label={`Edit ${record.label}`} title={`Edit ${record.label}`} onClick={() => onEdit({ recordId: record.id, field: 'amount' })}><MoneyIcon name="edit" /></button>
      <button className="icon-button" disabled={blocked} aria-label={`Remove ${record.label}`} title={`Remove ${record.label}`} onClick={() => onEdit({ recordId: record.id, field: 'delete' })}><MoneyIcon name="remove" /></button>
    </div></div>
    {record.kind === 'debt' ? <dl className="money-debt-values">
      <div><dt>Required / minimum</dt><dd>{fieldAmount('amount')}</dd></div>
      <div><dt>Intended · includes minimum</dt><dd>{fieldAmount('target')}</dd></div>
      <div><dt>Outstanding balance</dt><dd>{fieldAmount('outstanding')}</dd></div>
    </dl> : <p className="money-record-amount">{fieldAmount('amount')}
      {record.kind !== 'income' && <span className="money-meta">{record.kind === 'essential' ? 'Essential' : 'Other spending'}</span>}</p>}
    {events.filter(event => event.amountBasis === 'assumed').map(event => <p className="money-meta" key={event.id}>Current plan: {money(event.amountPaise)} on {dateLabel(event.date)} · Saved assumption, not paid. Reported {record.target ? 'intended payment' : 'amount'} stays unchanged.</p>)}
    {record.kind === 'income' && <p className="money-meta">
      {events.length && events.every(item => item.included) ? 'Included in projected balances · not marked received'
        : events.some(item => item.included) ? 'Some occurrences are not included' : 'Not included in projected balances'}
      {!!exclusions.length && <> · {exclusions.join(' · ')}</>}
    </p>}
    {missingDate && <p className="money-warning">Date needed · not in dated balances.</p>}
    {!!conflicts.length && <p className="money-warning">Conflicting reports need your check.</p>}
    <Details compact label={`Details for ${record.label}`}>
      <p>{record.kind === 'debt' ? record.debtType === 'card' ? 'Credit card' : record.debtType === 'loan' ? 'Loan' : record.debtType === 'informal' ? 'Informal borrowing' : 'Debt type not confirmed' : record.kind === 'income' ? 'Expected income' : record.kind === 'essential' ? 'Essential spending' : 'Other spending'} · {recurrence[record.schedule.recurrence]}</p>
      {record.kind === 'income' ? <><p>{incomeChecks(record).join(' · ') || 'Amount, date and receipt reliability reported.'}</p>{exclusions.map(reason => <p key={reason}>{reason}.</p>)}</>
        : <p>{record.controllability === 'committed' ? 'Already committed' : record.controllability === 'controllable' ? 'Changeable and not committed' : 'Whether this spending can change is not confirmed'}.</p>}
      {record.autoDebit && <p>Automatic debit reported</p>}
      {record.kind === 'debt' && <p>The intended payment includes the minimum, not an extra payment. Outstanding debt is not reduced by planning assumptions.</p>}
      {events.some(event => event.amountBasis === 'requiredOnly') && <p className="money-warning">Required / minimum only is counted. The intended payment is still unknown.</p>}
      {conflicts.map(conflict => <ConflictReview key={conflict.id} conflict={conflict} snapshot={snapshot} blocked={blocked} onCommand={onCommand} />)}
      {moneyIssues(snapshot).filter(item => item.recordIds.includes(record.id)).map(item => <p key={item.id}>{item.question} {item.reason}</p>)}
      {(snapshot.facts.providerResponses ?? []).filter(item => events.some(event => event.id === item.eventId)).map((item, index) => <p key={index}>
        You reported {item.status === 'reportedTerms' ? 'proposed terms' : item.status === 'declined' ? 'a refusal' : 'awaiting a response'} on {dateLabel(item.reportedOn)}.
        {item.paymentDate && <> Payment date: {dateLabel(item.paymentDate)}.</>}
        {item.payment && <> Payment: {money(item.payment.amountPaise)} · {amountStatus[item.payment.status]}.</>}
        {item.cost && <> Cost: {money(item.cost.amountPaise)} · {amountStatus[item.cost.status]}.</>}
        {' '}Original obligations remain; these terms are not verified.
      </p>)}
    </Details>
  </li>;
}

export function MoneyRecords({ category, snapshot, blocked, onEdit, onCommand }: {
  category: 'income' | 'spending' | 'debts'; snapshot: Snapshot; blocked: boolean;
  onEdit: (target: EditTarget) => void; onCommand: (operation: Command['operation']) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const kinds = category === 'income' ? ['income'] as const : category === 'debts' ? ['debt'] as const : ['essential', 'optional'] as const;
  const records = snapshot.facts.records.filter(item => kinds.some(kind => item.kind === kind));
  const noneReported = kinds.every(kind => snapshot.facts.coverage[kind] === 'none');
  const reviewed = kinds.every(kind => ['none', 'reviewed'].includes(snapshot.facts.coverage[kind] ?? 'notDiscussed'));
  const matching = records.filter(item => item.label.toLocaleLowerCase('en').includes(search.trim().toLocaleLowerCase('en'))
    && (filter === 'all' || filter === 'check' ? filter !== 'check' || needsCheck(item, snapshot) : item.kind === filter));
  return <section className="money-panel" aria-label="Money items">
    <div className="money-list-tools no-print">
      {(records.length > 8 || search) && <label className="money-search"><span className="sr-only">Search item names</span><MoneyIcon name="search" /><input type="search" value={search} placeholder="Find an item" onChange={event => setSearch(event.target.value)} /></label>}
      <label className="money-filter"><span className="sr-only">Filter items</span><MoneyIcon name="filter" /><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All items</option><option value="check">Needs check</option>{category === 'spending' && <><option value="essential">Essentials</option><option value="optional">Other spending</option></>}</select></label>
      <button className="icon-button" disabled={blocked} aria-label="Add item" title="Add item" onClick={() => onEdit({ kind: kinds[0], field: 'add' })}><MoneyIcon name="add" /></button>
    </div>
    {category === 'income' && !!plan.incomeComparisons?.length && <Details label="If income arrives">
      <p>Conditional calculations only. These receipts are not included in your current balances.</p>
      <PagedList label="Income possibilities" className="money-checks" pageSize={4}>{plan.incomeComparisons.map(comparison => <li key={comparison.id}>
        {comparison.conditions.map(condition => {
          const event = plan.events.find(event => event.id === condition.eventId);
          return <p key={condition.eventId}><strong>{event?.label ?? 'Unconfirmed receipt'}</strong>{event?.amountPaise != null && <> · {money(event.amountPaise)}</>}<br />
            {condition.arrival === 'reportedDate' ? <>If it arrives {event ? `on ${dateLabel(event.date)}` : 'on the reported date'}</> : 'If it does not arrive within this plan'}</p>;
        })}
        <p>First shortfall · Calculated: {comparison.metrics.firstGap ? <>{money(comparison.metrics.firstGap.amountPaise)} · {dateLabel(comparison.metrics.firstGap.date)}</> : comparison.metrics.closingPaise === null ? 'Unknown' : 'None under these conditions'}</p>
        <p>Closing cash · Calculated: {money(comparison.metrics.closingPaise)}</p>
      </li>)}</PagedList>
    </Details>}
    <p className="money-meta" role="status">{matching.length} of {records.length} items</p>
    {matching.length ? <PagedList key={`${search}:${filter}`} label="Money items" className="money-records" pageSize={8} printable={false}>{matching.map(record => <RecordRow key={record.id} {...{ record, snapshot, blocked, onEdit, onCommand }} />)}</PagedList>
      : <div className="money-empty"><h2>{records.length ? 'No matching items' : noneReported ? 'None reported' : reviewed ? 'Review recorded · no listed items' : kinds.every(kind => snapshot.facts.coverage[kind] === 'notDiscussed') ? 'Not discussed yet' : 'No items listed'}</h2><p>{records.length ? 'Try another name or filter.' : noneReported ? 'You reported no items in this category. You can add one if that changes.' : reviewed ? 'The category review is recorded. Add any missing item or correct the coverage below.' : 'Coverage is not complete. An empty list does not mean there is nothing expected or due.'}</p></div>}
    <div className="money-coverage">{kinds.map(kind => <p key={kind}>{kind === 'income' ? 'Income' : kind === 'debt' ? 'Loans & cards' : kind === 'essential' ? 'Essentials' : 'Other spending'}: <strong>{coverageLabels[snapshot.facts.coverage[kind] ?? 'notDiscussed']}</strong>
      <button className="icon-button" disabled={blocked} aria-label={`Review ${kind === 'debt' ? 'loans and cards' : kind} coverage`} title="Review category" onClick={() => onEdit({ kind, field: 'coverage' })}><MoneyIcon name="edit" /></button></p>)}</div>
  </section>;
}