// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link } from 'react-router';
import type { Plan, Snapshot } from './api';
import { budgetDescription, dateLabel, money, sourceDescription } from './money';
import { PagedList } from './PagedList';
import { Details } from './Dialog';
import { MoneyIcon } from './MoneyIcon';
import { reasons } from './WorkspaceDetails';
import { amountStatus, factStatus } from './MoneyRecords';
import './moneyUpcoming.css';

/** Presents a projected receipt or payment with its timing, certainty, and balance impact. */
export function MoneyEvent({ event, snapshot, expanded = false }: { event: Plan['events'][number]; snapshot: Snapshot; expanded?: boolean }) {
  const record = snapshot.facts.records.find(item => item.id === event.recordId);
  // Required bases count the minimum without rewriting the chosen target.
  const field = event.amountBasis !== 'requiredOnly' && event.amountBasis !== 'requiredFloor' && record?.target ? 'target' : 'amount';
  const adjustment = snapshot.accepted?.adjustments.find(item => item.eventId === event.id);
  const contribution = snapshot.workspace?.contributions?.find(item => item.eventId === event.id && !item.id.startsWith('proposal:'));
  const elapsed = event.date < (snapshot.accepted?.plan ?? snapshot.plan).evaluatedOn;
  const budget = event.amountBasis === 'budget';
  const status = event.amountBasis === 'assumed' ? adjustment ? 'Saved assumption' : 'Assumption'
    : factStatus(snapshot, field, record) === 'Conflicting reports' ? 'Conflicting reports' : amountStatus[event.amountStatus];
  const dateStatus = factStatus(snapshot, 'schedule.date', record);
  const category = budget ? 'Budget estimate' : event.kind === 'income' ? 'Money in' : event.kind === 'essential' ? 'Essential' : event.kind === 'optional' ? 'Optional' : record?.debtType === 'card' ? 'Card payment' : record?.debtType === 'loan' ? 'Loan payment' : 'Debt payment';
  const detail = <>
      <p>{dateLabel(event.date)} · {category}</p>
      <p className="money-meta">{event.dateAssumption || budget || event.overdue ? 'Date used for the forecast' : `Date: ${dateStatus}`}</p>
      {event.dateAssumption && <p className="money-meta">{event.dateAssumption}</p>}
      {budget && <p className="money-meta">{record?.schedule.recurrence === 'monthlyBudget' ? budgetDescription : 'A recurring spending allowance, not a confirmed payment date.'}</p>}
      {event.source?.conversion && <p className="money-meta">{sourceDescription(event.source)} · Calculated INR shown alongside.</p>}
      {event.scheduleIndex != null && !!record?.schedule.amounts?.length && <p className="money-meta">Occurrence {event.scheduleIndex + 1} of {record.schedule.amounts.length}</p>}
      {elapsed && <p className="money-meta">Earlier requirement · status not confirmed</p>}
      {event.overdue && !budget && <p className="money-warning">Originally due {dateLabel(event.originalDueDate)} · Date: {factStatus(snapshot, 'schedule.date', record)} · status needs checking</p>}
      {!event.included && <p className="money-warning">Not counted in balances{contribution && reasons[contribution.reason] ? ` · ${reasons[contribution.reason]}` : ''}</p>}
      {event.amountBasis === 'requiredOnly' && <p className="money-warning">Required / minimum only · intended payment unknown</p>}
      {event.amountBasis === 'requiredFloor' && <p className="money-warning">Current required / minimum payment exceeds the chosen target. The minimum is counted; your target is retained.</p>}
      {event.amountBasis !== 'assumed' && field === 'target' && <p className="money-meta">Intended payment · includes minimum</p>}
      {event.amountBasis === 'reported' && field === 'amount' && record?.kind === 'debt' && <p className="money-meta">Required / minimum payment</p>}
      {record?.kind === 'debt' && field === 'target' && <p className="money-meta">Required / minimum for this occurrence: {money(event.requiredPaise ?? null)} · {amountStatus[event.requiredStatus]}</p>}
      {event.amountBasis === 'assumed' && <p className="money-meta">{status} · not paid{adjustment?.kind === 'card' && ' · includes minimum'}</p>}
      {event.amountBasis === 'assumed' && factStatus(snapshot, field, record) === 'Conflicting reports' && <p className="money-warning">Underlying {field === 'target' ? 'intended payment' : 'amount'}: Conflicting reports</p>}
      {event.autoDebit && <p className="money-meta">Automatic debit reported</p>}
      <p className="money-meta">{elapsed ? 'Earlier projected balance' : 'Projected balance after'} · Calculated<br /><strong>{money(event.balancePaise)}</strong><br />Not a current bank balance</p>
    </>;
  return <li className={`money-event${event.included ? '' : ' money-event-excluded'}`} aria-label={event.label}>
    <time className="money-event-date" dateTime={event.date} title={dateLabel(event.date)}>{dateLabel(event.date).replace(/ \d{4}$/, '')}</time>
    <div className="money-event-identity"><h3>{event.label}</h3><div className="money-event-tags"><span>{category}</span>
      {event.autoDebit && <span>Auto-debit</span>}
      {event.dateAssumption ? <span className="money-warning">Assumed date</span> : !event.overdue && dateStatus !== 'Reported' && <span className="money-warning">{dateStatus === 'Conflicting reports' ? 'Date disputed' : 'Date uncertain'}</span>}
      {elapsed && <span>Status unconfirmed</span>}
      {event.amountBasis === 'requiredOnly' && <span className="money-warning">Minimum only · target unknown</span>}
      {event.amountBasis === 'requiredFloor' && <span className="money-warning">Minimum exceeds target</span>}
      {(event.amountBasis === 'assumed' && adjustment?.kind === 'card' || event.amountBasis === 'reported' && field === 'target') && <span>Includes minimum</span>}
      {event.amountBasis === 'reported' && field === 'amount' && record?.kind === 'debt' && <span>Minimum / required</span>}
      {!event.included && <span className="money-warning">Not counted</span>}
    </div>{event.overdue && !budget && <p className="money-warning">Originally due {dateLabel(event.originalDueDate).replace(/ \d{4}$/, '')} · Check status</p>}</div>
    <div className="money-event-value"><strong>{event.amountPaise === null ? 'Unknown' : `${event.kind === 'income' ? '+' : '−'}${money(event.amountPaise)}`}</strong>
      {status !== 'Reported' && <span className={event.amountStatus === 'exact' ? 'money-meta' : 'money-warning'}>{status}</span>}
      <span className="money-event-balance">Forecast {money(event.balancePaise)}</span>
    </div>
    {!expanded && <Details compact label={`Details for ${event.label} on ${dateLabel(event.date)}`} title={event.label}>{detail}</Details>}
    {expanded && <div className="money-event-detail">{detail}</div>}
  </li>;
}

/** Provides searchable upcoming and earlier requirements, including notices for undated items. */
export function MoneyUpcoming({ snapshot }: { snapshot: Snapshot }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [period, setPeriod] = useState('upcoming');
  const events = plan.events.filter(event => event.label.toLocaleLowerCase('en').includes(search.trim().toLocaleLowerCase('en'))
    && (period === 'all' || (period === 'earlier' ? event.date < plan.evaluatedOn : event.date >= plan.evaluatedOn))
    && (filter === 'all' || (filter === 'income' ? event.kind === 'income' : event.kind !== 'income')));
  const undated = plan.budgetBasis.unresolvedAmounts.filter(item => item.reason === 'missingDate');
  const elapsed = plan.events.filter(event => event.date < plan.evaluatedOn).length;
  return <section className="money-panel money-upcoming" aria-label="Upcoming money and payments">
    <div className="upcoming-toolbar"><label className="upcoming-search"><span className="sr-only">Search upcoming items</span><MoneyIcon name="search" /><input type="search" placeholder="Search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label><span className="sr-only">Time period</span><select value={period} onChange={event => setPeriod(event.target.value)}><option value="upcoming">Upcoming</option>{(elapsed > 0 || period === 'earlier') && <option value="earlier">Earlier ({elapsed})</option>}{elapsed > 0 && <option value="all">All dates</option>}</select></label>
      <label><span className="sr-only">Filter upcoming items</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All items</option><option value="income">Money in</option><option value="due">Money out</option></select></label>
      <Details compact label="About this forecast"><p>Expected money in and planned spending, not completed payments or a current bank balance.</p><p>Same-day payments come before income in this forecast. Row order is not payment priority.</p><p className="money-meta">As of {dateLabel(plan.evaluatedOn)}. Earlier items are not confirmed paid or received.</p></Details>
    </div>
    {!!undated.length && <div className="upcoming-undated"><Details label={`${undated.length} ${undated.length === 1 ? 'item needs' : 'items need'} a date`}><p className="money-meta">Not included in the dated forecast.</p><PagedList label="Items without dates" className="money-checks" pageSize={8}>{undated.map(item => {
      const record = snapshot.facts.records.find(record => record.id === item.recordId);
      const floor = plan.undatedImpact?.items.some(value => value.recordId === item.recordId && value.amountBasis === 'requiredFloor');
      return <li key={item.recordId}><h3>{record?.label ?? 'Unresolved item'}</h3><p>{record?.schedule.amounts?.length ? 'Varies by occurrence' : <>{money(item.amount.amountPaise)} · {amountStatus[item.amount.status]}</>}{record?.kind === 'debt' && (floor ? ' · Current minimum counted; chosen target retained' : record.target?.amountPaise != null ? ' · Intended, including minimum' : ' · Required / minimum')} · Date unknown, not in dated balances.</p><Link to={record?.kind === 'income' ? '/money/income' : record?.kind === 'debt' ? '/money/debts' : '/money/spending'}>View item category</Link></li>;
    })}</PagedList></Details></div>}
    <p className={search || filter !== 'all' ? 'upcoming-count' : 'sr-only'} role="status">{events.length} {events.length === 1 ? 'item' : 'items'}{search || filter !== 'all' ? ' found' : ''}</p>
    {events.length ? <PagedList key={`${search}:${filter}:${period}`} label="Upcoming events" className="money-events" ordered printable={false} pageSize={8}>{events.map(event => <MoneyEvent key={event.id} {...{ event, snapshot }} />)}</PagedList>
      : <div className="money-empty"><h2>{search || filter !== 'all' ? 'No matching items' : plan.events.length ? period === 'earlier' ? 'No earlier items' : 'Nothing upcoming' : 'No dated items yet'}</h2><p>{search || filter !== 'all' ? 'Try another name or filter.' : undated.length ? 'Add the missing dates to see those items here.' : 'Only items with dates appear here. This does not mean every cost is covered.'}</p></div>}
  </section>;
}