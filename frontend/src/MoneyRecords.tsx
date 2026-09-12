// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { Command, Snapshot } from './api';
import type { Fact } from './WorkspaceDetails';
import { ConflictReview, incomeChecks, reasons } from './WorkspaceDetails';
import { Details, Dialog } from './Dialog';
import { amountStatus, budgetDescription, dateLabel, money, recurrenceLabels, scheduleLabel } from './money';
import { ExchangeValues, MoneySources } from './MoneyValues';
import { MoneyIcon } from './MoneyIcon';
import { PagedList } from './PagedList';
import type { EditTarget } from './MoneyEdit';
import { moneyIssues } from './MoneyChecks';
import './moneyRecords.css';

export const coverageLabels = { notDiscussed: 'Not checked', reported: 'Some shared', unknown: 'Not sure', reviewed: 'Reviewed', none: 'None reported' };
export { amountStatus } from './money';

/** Describes a fact field's certainty, conflict, or absence. */
export function factStatus(snapshot: Snapshot, field: 'opening' | 'amount' | 'target' | 'outstanding' | 'schedule.date', record?: Fact) {
  if (snapshot.facts.conflicts?.some(item => item.recordId === (record?.id ?? null) && item.field === field)) return 'Conflicting reports';
  if (field === 'schedule.date') return record?.schedule.date ? amountStatus[record.schedule.certainty] : 'Unknown';
  if (field === 'amount' && record?.schedule.amounts?.length) return 'Varies by occurrence';
  const value = field === 'opening' ? snapshot.facts.opening : record?.[field];
  return value ? amountStatus[value.status] : 'Not supplied';
}

/** Identifies records with uncertain, conflicting, or unresolved financial details. */
export function needsCheck(record: Fact, snapshot: Snapshot) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  return (record.schedule.amounts?.length ? record.schedule.amounts.some(amount => amount.status !== 'exact' || amount.conversion && (amount.conversion.rateStatus !== 'exact' || amount.conversion.feeStatus !== 'exact')) : record.amount.status !== 'exact') || !!record.schedule.date && record.schedule.certainty !== 'exact'
    || record.kind === 'income' && record.reliability !== 'reliable'
    || !!record.target && record.target.status !== 'exact' || !!record.outstanding && record.outstanding.status !== 'exact'
    || snapshot.facts.conflicts?.some(item => item.recordId === record.id)
    || plan.budgetBasis.unresolvedAmounts.some(item => item.recordId === record.id)
    || moneyIssues(snapshot).some(item => item.recordIds.includes(record.id));
}

/** Presents a reported item's amounts, schedule, checks, and correction controls. */
export function RecordRow({ record, snapshot, blocked, onEdit, onCommand }: {
  record: Fact; snapshot: Snapshot; blocked: boolean; onEdit: (target: EditTarget) => void;
  onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>;
}) {
  const [details, setDetails] = useState(false);
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const conflicts = snapshot.facts.conflicts?.filter(item => item.recordId === record.id) ?? [];
  const events = plan.events.filter(event => event.recordId === record.id);
  const next = events.find(event => event.date >= plan.evaluatedOn);
  const current = plan.planningFacts.records.find(item => item.id === record.id);
  const budget = record.schedule.basis === 'allowance' || record.schedule.recurrence === 'monthlyBudget';
  const changes = events.filter(event => event.amountBasis === 'assumed');
  const conversions = [current?.amount, current?.target].flatMap(value => value?.source?.conversion ? [value.source.conversion] : []);
  const missingDate = plan.budgetBasis.unresolvedAmounts.some(item => item.recordId === record.id && item.reason === 'missingDate');
  const exclusions = [...new Set(snapshot.workspace?.contributions?.filter(item => item.recordId === record.id && !item.included && !item.id.startsWith('proposal:'))
    .map(item => reasons[item.reason]).filter(Boolean))];
  /** Presents a record amount with its reporting status and monthly-budget qualifier. */
  const fieldAmount = (field: 'amount' | 'target' | 'outstanding') => {
    const value = record[field]?.source?.conversion ? current?.[field] : record[field];
    const variable = field === 'amount' && !!record.schedule.amounts?.length;
    const status = conflicts.some(item => item.field === field) ? 'Conflicting reports' : value ? amountStatus[value.status] : '';
    return <><button className="record-value" disabled={blocked} aria-label={`Edit ${record.label} ${field === 'amount' && record.kind === 'debt' ? 'required payment' : field === 'target' ? 'intended payment' : field}`} onClick={() => { setDetails(false); onEdit({ recordId: record.id, field }); }}>
      <strong>{variable ? 'Varies by payment' : record[field] ? money(value?.amountPaise ?? null) : 'Not supplied'}</strong><MoneyIcon name="edit" />
    </button>
      {!variable && status && status !== 'Reported' && <span className="money-meta">{status}</span>}
      {record[field]?.source?.conversion && <span className="money-meta">{record[field]!.source!.conversion!.currency} {record[field]!.source!.amount ?? 'Unknown'} · {value?.status === 'exact' ? 'INR conversion' : 'INR estimate'}</span>}
      {field === 'amount' && record.schedule.recurrence !== 'once' && !variable && <span className="record-cadence">{record.schedule.recurrence === 'monthlyBudget' ? 'per calendar month' : ({ daily: 'per day', weekly: 'per week', fortnightly: 'every two weeks', monthly: 'per month' })[record.schedule.recurrence]}</span>}
    </>;
  };
  return <li className="money-record" data-kind={record.kind} aria-label={record.label}>
    <div className="money-record-main"><div className="money-record-identity"><h3>{record.label}</h3>
      <button className="record-timing" disabled={blocked} aria-label={`Edit ${record.label} date`} onClick={() => onEdit({ recordId: record.id, field: 'schedule.date' })}>
        {budget ? 'Budget timing' : next ? record.kind === 'income' ? 'Expected' : 'Due' : record.kind === 'income' ? 'Expected date' : 'Payment date'} {budget ? next ? dateLabel(next.date).replace(/ \d{4}$/, '') : 'not set' : next ? dateLabel(next.overdue ? next.originalDueDate : next.date).replace(/ \d{4}$/, '') : record.schedule.date ? dateLabel(record.schedule.date).replace(/ \d{4}$/, '') : 'unknown'}<MoneyIcon name="edit" />
      </button>
      <div className="record-tags">{record.kind !== 'income' && <span>{record.kind === 'debt' ? record.debtType === 'card' ? 'Credit card' : 'Loan / debt' : record.kind === 'essential' ? 'Essential' : 'Optional'}</span>}
        <span>{record.schedule.recurrence === 'monthlyBudget' ? 'Monthly budget' : recurrenceLabels[record.schedule.recurrence]}</span>
        {budget && <span>Budget estimate · not a bill</span>}
        {record.autoDebit && <span>Auto-debit</span>}
        {record.kind !== 'income' && record.controllability === 'committed' && <span>Committed</span>}
        {record.kind === 'income' && <span className={record.reliability === 'reliable' ? '' : 'money-warning'}>{record.reliability === 'reliable' ? 'Reliable' : 'Receipt uncertain'}</span>}
        {record.schedule.pattern || next?.dateAssumption ? <span className="money-warning">Forecast date</span> : record.schedule.certainty === 'estimate' && <span className="money-warning">Date estimated</span>}
        {next?.overdue && !budget && <span className="money-warning">Check earlier payment</span>}
      </div>
      {record.kind === 'income' && <p className={events.some(event => event.included) ? 'record-status' : 'record-status money-warning'}>{events.length && events.every(event => event.included) ? 'Included in forecast' : events.some(event => event.included) ? 'Some payments not counted' : 'Not counted in forecast'}</p>}
      {record.kind === 'income' && !events.some(event => event.included) && exclusions.map(reason => <p className="record-status money-warning" key={reason}>{reason}</p>)}
      {missingDate && <p className="record-status money-warning">Date needed · not in dated balances</p>}
      {!!conflicts.length && <p className="record-status money-warning">Conflicting reports · check details</p>}
      {events.some(event => event.amountBasis === 'requiredOnly') && <p className="record-status money-warning">Minimum only · intended payment unknown</p>}
      {events.some(event => event.amountBasis === 'requiredFloor') && <p className="record-status money-warning">Minimum exceeds intended payment</p>}
      {conversions.some(conversion => conversion.provider === 'frankfurter' && conversion.fee == null && conversion.direction !== 'valuation') && <p className="record-status money-warning">Conversion fees unknown · not included</p>}
      {conversions.some(conversion => conversion.rateStatus === 'unknown') && <p className="record-status money-warning">INR estimate unavailable</p>}
      {!!changes.length && <p className="record-status">Saved plan change · not paid</p>}
    </div>
    {record.kind === 'debt' ? <dl className="money-debt-values">
      <div><dt>Required / minimum</dt><dd>{fieldAmount('amount')}</dd></div>
      {record.target != null && <div><dt>Intended · includes minimum</dt><dd>{fieldAmount('target')}</dd></div>}
    </dl> : <div className="money-record-amount">{fieldAmount('amount')}</div>}
    <div className="money-row-actions no-print">
      <button className="icon-button" disabled={blocked} aria-label={`Edit ${record.label}`} title={`Edit ${record.label}`} onClick={() => onEdit({ recordId: record.id, field: 'amount' })}><MoneyIcon name="edit" /></button>
    <button className="icon-button" aria-label={`Details for ${record.label}`} title={`Details for ${record.label}`} aria-haspopup="dialog" onClick={() => setDetails(true)}><MoneyIcon name="expand" /></button>
    <Dialog open={details} title={`Details for ${record.label}`} onClose={() => setDetails(false)}>
      <p>{record.kind === 'debt' ? record.debtType === 'card' ? 'Credit card' : record.debtType === 'loan' ? 'Loan' : record.debtType === 'informal' ? 'Informal borrowing' : 'Debt type not confirmed' : record.kind === 'income' ? 'Expected income' : record.kind === 'essential' ? 'Essential spending' : 'Other spending'} · {scheduleLabel(record.schedule)}</p>
      <p className="money-meta">Reported start: {record.schedule.date ? dateLabel(record.schedule.date) : 'Date unknown'} · {factStatus(snapshot, 'schedule.date', record)}</p>
      <MoneySources record={record} snapshot={snapshot} />
      {record.schedule.recurrence === 'monthlyBudget' && <p className="money-meta">{budgetDescription}</p>}
      {budget && <p className="money-meta">Budget timing is used for the forecast, not a confirmed payment due date.</p>}
      {changes.map(event => <p className="money-meta" key={event.id}>Current plan: {money(event.amountPaise)} on {dateLabel(event.date)} · Saved assumption, not paid. Reported {record.target ? 'intended payment' : 'amount'} stays unchanged.</p>)}
      {record.kind === 'debt' && <dl className="record-secondary-values">{record.target == null && <div><dt>Intended · includes minimum</dt><dd>{fieldAmount('target')}</dd></div>}<div><dt>Outstanding balance</dt><dd>{fieldAmount('outstanding')}</dd></div></dl>}
      {record.kind === 'income' ? <><p>{incomeChecks(record).join(' · ') || 'Amount, date and receipt reliability reported.'}</p>{events.some(event => event.included) && exclusions.map(reason => <p key={reason}>{reason}.</p>)}</>
        : <p>{record.controllability === 'committed' ? 'Already committed' : record.controllability === 'controllable' ? 'Changeable and not committed' : 'Whether this spending can change is not confirmed'}.</p>}
      {record.autoDebit && <p>Automatic debit reported</p>}
      {record.kind === 'debt' && <p>The intended payment includes the minimum, not an extra payment. Outstanding debt is not reduced by planning assumptions.</p>}
      {events.some(event => event.amountBasis === 'requiredOnly') && <p className="money-warning">Required / minimum only is counted. The intended payment is still unknown.</p>}
      {conflicts.map(conflict => <ConflictReview key={conflict.id} conflict={conflict} snapshot={snapshot} blocked={blocked} onCommand={onCommand} />)}
      {moneyIssues(snapshot).filter(item => item.recordIds.includes(record.id)).map(item => <p key={item.id}>{item.question} {item.reason}</p>)}
      {(snapshot.facts.providerResponses ?? []).filter(item => events.some(event => event.id === item.eventId)).map((item, index) => <div key={index}><p>
        You reported {item.status === 'reportedTerms' ? 'proposed terms' : item.status === 'declined' ? 'a refusal' : 'awaiting a response'} on {dateLabel(item.reportedOn)}.
        {item.paymentDate && <> Payment date: {dateLabel(item.paymentDate)}.</>}
        {item.payment && <> Payment: {money(item.payment.amountPaise)} · {amountStatus[item.payment.status]}.</>}
        {item.cost && <> Cost: {money(item.cost.amountPaise)} · {amountStatus[item.cost.status]}.</>}
        {' '}Original obligations remain; these terms are not verified.
      </p>{(['payment', 'cost'] as const).map(field => item[field]?.source?.conversion && <div key={field}><p>Reported terms · {field === 'payment' ? 'Payment' : 'Cost'}</p>
        <ExchangeValues source={item[field].source!} capturedPaise={item[field].amountPaise} currentMoney={plan.planningFacts.providerResponses?.find(response => response.eventId === item.eventId)?.[field] ?? undefined} plan={plan} /></div>)}</div>)}
      <button className="quiet" disabled={blocked} aria-label={`Remove ${record.label}`} onClick={() => { setDetails(false); onEdit({ recordId: record.id, field: 'delete' }); }}>Remove item</button>
    </Dialog>
    </div></div>
  </li>;
}

/** Provides searchable category records, coverage review, and conditional income comparisons. */
export function MoneyRecords({ category, snapshot, blocked, onEdit, onCommand }: {
  category: 'income' | 'spending' | 'debts'; snapshot: Snapshot; blocked: boolean;
  onEdit: (target: EditTarget) => void; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [reviewing, setReviewing] = useState(false);
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const kinds = category === 'income' ? ['income'] as const : category === 'debts' ? ['debt'] as const : ['essential', 'optional'] as const;
  const records = snapshot.facts.records.filter(item => kinds.some(kind => item.kind === kind));
  const noneReported = kinds.every(kind => snapshot.facts.coverage[kind] === 'none');
  const reviewed = kinds.every(kind => ['none', 'reviewed'].includes(snapshot.facts.coverage[kind] ?? 'notDiscussed'));
  const matching = records.filter(item => item.label.toLocaleLowerCase('en').includes(search.trim().toLocaleLowerCase('en'))
    && (filter === 'all' || filter === 'check' ? filter !== 'check' || needsCheck(item, snapshot) : item.kind === filter));
  if (category === 'spending') matching.sort((a, b) => Number(a.kind === 'optional') - Number(b.kind === 'optional'));
  return <section className="money-panel money-category" aria-label="Money items">
    <div className="money-list-tools no-print">
      <label className="money-search"><span className="sr-only">Search item names</span><MoneyIcon name="search" /><input type="search" value={search} placeholder="Find an item" onChange={event => setSearch(event.target.value)} /></label>
      <label className="money-filter"><span className="sr-only">Filter items</span><MoneyIcon name="filter" /><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All items</option><option value="check">Needs check</option>{category === 'spending' && <><option value="essential">Essentials</option><option value="optional">Other spending</option></>}</select></label>
      <button disabled={blocked} onClick={() => onEdit({ kind: kinds[0], field: 'add' })}><MoneyIcon name="add" />Add item</button>
    </div>
    {category === 'income' && <p className="category-note">Expected income · not confirmed received</p>}
    {category === 'spending' && <p className="category-note">Essentials first, then optional spending. Budgets are estimates, not bills.</p>}
    {category === 'debts' && <p className="category-note">Required payments first. Intended payments include the minimum.</p>}
    {category === 'income' && !!plan.incomeComparisons?.length && <Details label="If income arrives">
      <p>Compare different income outcomes. These are alternatives to your current forecast, not confirmed receipts.</p>
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
    <p className={search || filter !== 'all' ? 'money-meta' : 'sr-only'} role="status">{matching.length} of {records.length} items</p>
    {matching.length ? <PagedList key={`${search}:${filter}`} label="Money items" className="money-records" pageSize={8} printable={false}>{matching.map(record => <RecordRow key={record.id} {...{ record, snapshot, blocked, onEdit, onCommand }} />)}</PagedList>
      : <div className="money-empty"><h2>{records.length ? 'No matching items' : noneReported ? 'None reported' : reviewed ? 'Review recorded · no listed items' : kinds.every(kind => snapshot.facts.coverage[kind] === 'notDiscussed') ? 'Not discussed yet' : 'No items listed'}</h2><p>{records.length ? 'Try another name or filter.' : noneReported ? 'You reported no items in this category. You can add one if that changes.' : reviewed ? 'The category review is recorded. Add any missing item or correct the coverage below.' : 'Coverage is not complete. An empty list does not mean there is nothing expected or due.'}</p></div>}
    <div className="category-review">{!reviewed && <span className="money-meta">Some items may still be missing.</span>}<button aria-haspopup="dialog" onClick={() => setReviewing(true)}>Review included items</button><Dialog open={reviewing} title="Review included items" onClose={() => setReviewing(false)}><div className="money-coverage">{kinds.map(kind => <p key={kind}>{kind === 'income' ? 'Income' : kind === 'debt' ? 'Loans & cards' : kind === 'essential' ? 'Essentials' : 'Other spending'}: <strong>{coverageLabels[snapshot.facts.coverage[kind] ?? 'notDiscussed']}</strong>
      <button className="icon-button" disabled={blocked} aria-label={`Review ${kind === 'debt' ? 'loans and cards' : kind} coverage`} title="Review category" onClick={() => { setReviewing(false); onEdit({ kind, field: 'coverage' }); }}><MoneyIcon name="edit" /></button></p>)}</div></Dialog></div>
  </section>;
}