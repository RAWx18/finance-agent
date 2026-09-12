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

export function MoneyEvent({ event, snapshot, compact = false }: { event: Plan['events'][number]; snapshot: Snapshot; compact?: boolean }) {
  const record = snapshot.facts.records.find(item => item.id === event.recordId);
  // Reported events use the target when supplied; requiredOnly explicitly uses the minimum.
  const field = event.amountBasis !== 'requiredOnly' && record?.target ? 'target' : 'amount';
  const adjustment = snapshot.accepted?.adjustments.find(item => item.eventId === event.id);
  const contribution = snapshot.workspace?.contributions?.find(item => item.eventId === event.id && !item.id.startsWith('proposal:'));
  const elapsed = event.date < (snapshot.accepted?.plan ?? snapshot.plan).evaluatedOn;
  const budget = event.amountBasis === 'budget';
  const status = event.amountBasis === 'assumed' ? adjustment ? 'Saved assumption' : 'Assumption'
    : factStatus(snapshot, field, record) === 'Conflicting reports' ? 'Conflicting reports' : amountStatus[event.amountStatus];
  return <li className="money-event" aria-label={event.label}>
    <div><h3>{event.label}</h3><p className="money-meta">{budget ? 'Estimated daily budget share' : event.overdue ? 'Carried to' : event.kind === 'income' ? 'Incoming' : 'Due'} · <time dateTime={event.date}>{dateLabel(event.date)}</time> · {budget || event.overdue ? 'Calculated' : `Date: ${factStatus(snapshot, 'schedule.date', record)}`}</p>
      {budget && <p className="money-meta">{budgetDescription}</p>}
      {event.source?.conversion && <p className="money-meta">{sourceDescription(event.source)} · Calculated INR shown alongside.</p>}
      {event.scheduleIndex != null && !!record?.schedule.amounts?.length && <p className="money-meta">Occurrence {event.scheduleIndex + 1} of {record.schedule.amounts.length}</p>}
      {elapsed && <p className="money-meta">Earlier requirement · status not confirmed</p>}
      {event.overdue && !budget && <p className="money-warning">Originally due {dateLabel(event.originalDueDate)} · Date: {factStatus(snapshot, 'schedule.date', record)} · status needs checking</p>}
      {!event.included && <p className="money-warning">Not counted in balances{contribution && reasons[contribution.reason] ? ` · ${reasons[contribution.reason]}` : ''}</p>}
      {event.amountBasis === 'requiredOnly' && <p className="money-warning">Required / minimum only · intended payment unknown</p>}
      {event.amountBasis !== 'assumed' && field === 'target' && <p className="money-meta">Intended payment · includes minimum</p>}
      {event.amountBasis === 'reported' && field === 'amount' && record?.kind === 'debt' && <p className="money-meta">Required / minimum payment</p>}
      {record?.kind === 'debt' && field === 'target' && <p className="money-meta">Required / minimum for this occurrence: {money(event.requiredPaise ?? null)} · {amountStatus[event.requiredStatus]}</p>}
      {event.amountBasis === 'assumed' && <p className="money-meta">{status} · not paid{adjustment?.kind === 'card' && ' · includes minimum'}</p>}
      {event.amountBasis === 'assumed' && factStatus(snapshot, field, record) === 'Conflicting reports' && <p className="money-warning">Underlying {field === 'target' ? 'intended payment' : 'amount'}: Conflicting reports</p>}
      {event.autoDebit && <p className="money-meta">Automatic debit reported</p>}
    </div><div className="money-event-value"><strong>{event.amountPaise === null ? 'Unknown' : `${event.kind === 'income' ? '+' : '−'}${money(event.amountPaise)}`}</strong>
      <span className="money-meta">{status}</span>
      {!compact && <p className="money-meta">{elapsed ? 'Earlier projected balance' : 'Projected balance after'} · Calculated<br /><strong>{money(event.balancePaise)}</strong><br />Not a current bank balance</p>}
    </div>
  </li>;
}

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
  return <section className="money-panel" aria-label="Upcoming money and payments">
    <p className="money-meta">Calculated requirements, not completed payments. Same-day payments come before income; row order is not payment priority.</p>
    <p className="money-meta">Evaluated {dateLabel(plan.evaluatedOn)} · {elapsed} earlier requirements, status not confirmed.</p>
    {!!undated.length && <Details label={`${undated.length} items without dates`}><PagedList label="Items without dates" className="money-checks" pageSize={8}>{undated.map(item => {
      const record = snapshot.facts.records.find(record => record.id === item.recordId);
      return <li key={item.recordId}><h3>{record?.label ?? 'Unresolved item'}</h3><p>{record?.schedule.amounts?.length ? 'Varies by occurrence' : <>{money(item.amount.amountPaise)} · {record ? factStatus(snapshot, record.target?.amountPaise != null ? 'target' : 'amount', record) : amountStatus[item.amount.status]}</>}{record?.kind === 'debt' && (record.target?.amountPaise != null ? ' · Intended, including minimum' : ' · Required / minimum')} · Date unknown, not in dated balances.</p><Link to={record?.kind === 'income' ? '/money/income' : record?.kind === 'debt' ? '/money/debts' : '/money/spending'}>View item category</Link></li>;
    })}</PagedList></Details>}
    <div className="money-list-tools" role="group" aria-label="Requirement period">{[['upcoming', 'Upcoming'], ['earlier', `Earlier (${elapsed})`], ['all', 'All']].map(([value, label]) => <button key={value} className="detail-button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div>
    <div className="money-list-tools"><label className="money-search"><span className="sr-only">Search upcoming items</span><MoneyIcon name="search" /><input type="search" placeholder="Find an item" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label className="money-filter"><span className="sr-only">Filter upcoming items</span><MoneyIcon name="filter" /><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All events</option><option value="income">Incoming</option><option value="due">Payments & budgeted spending</option></select></label></div>
    <p className="money-meta" role="status">{events.length} of {plan.events.length} events</p>
    {events.length ? <PagedList key={`${search}:${filter}:${period}`} label="Upcoming events" className="money-events" ordered pageSize={8}>{events.map(event => <MoneyEvent key={event.id} {...{ event, snapshot }} />)}</PagedList>
      : <div className="money-empty"><h2>{plan.events.length ? 'No matching events' : 'No dated events in this plan'}</h2><p>{search || filter !== 'all' ? 'Try another name or filter.' : 'Check the other periods, category coverage and unresolved details before drawing a conclusion.'}</p></div>}
  </section>;
}