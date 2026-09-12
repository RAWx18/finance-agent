// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from './api';
import { ChangedValue } from './CardField';
import { cardDate, cardMoney } from './cardFields';
import { lastDate, recurrenceLabels } from './money';
import { fieldLabels, reasons } from './WorkspaceDetails';
import { PlanningPossibilities } from './PlanningPossibilities';

export function FinancialStatus({ snapshot }: { snapshot: Snapshot }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const closing = snapshot.workspace?.results?.find(result => result.id === 'closing');
  if (!closing) return null;
  const unresolved = plan.budgetBasis.unresolvedAmounts;
  const dates = unresolved.filter((item, index) => item.reason === 'missingDate'
    && unresolved.findIndex(other => other.reason === 'missingDate' && other.recordId === item.recordId) === index);
  const issues = snapshot.workspace?.issues ?? [];
  const conflicting = !!snapshot.facts.conflicts?.length || closing.state === 'conflicting';
  const partial = plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete;
  const unconfirmed = ['uncertain', 'unresolved'].includes(closing.state);
  const excluded = snapshot.workspace?.contributions?.filter(item => closing.excludedIds.includes(item.id)
    && !dates.some(date => date.recordId === item.recordId)) ?? [];
  const needsAttention = partial || conflicting || unconfirmed || closing.amountPaise === null || issues.length > 0;
  const amount = (item: typeof unresolved[number]) => {
    const record = snapshot.facts.records.find(record => record.id === item.recordId);
    return `${record?.label ?? 'Commitment'} ${record?.kind === 'income' ? '+' : ''}${record?.schedule.amounts?.length ? 'Varies by occurrence' : cardMoney(item.amount.amountPaise)}${item.amount.status === 'estimate' ? ' est.' : ''}${item.recurrence !== 'once' ? ` · ${recurrenceLabels[item.recurrence]}` : ''}`;
  };
  return <section className="financial-status" aria-label="Financial status">
    <div className="card-closing" aria-label="Projected closing cash">
      <h3><span>Projected end</span> <span className="card-meta">· {cardDate(lastDate(snapshot.endDateExclusive))}</span></h3>
      <strong><ChangedValue value={cardMoney(closing.amountPaise)} /></strong>
      {closing.state === 'estimated' && <span className="card-badge" data-tone="caution">Includes estimates</span>}
    </div>
    {conflicting && <p className="card-caution">Conflicting figures · Needs checking</p>}
    {closing.amountPaise === null ? <p>Cash amount needed to project an end balance.</p>
      : !plan.events.length ? <p className="card-meta">Starting cash only · No dated forecast yet</p>
        : partial && <p className="card-meta">Based on dated items only</p>}
    {dates.length > 0 && !plan.undatedImpact && <p className="status-missing"><strong>Timing to check</strong>: {dates.slice(0, 2).map(amount).join(' · ')}{dates.length > 2 && ` · +${dates.length - 2} more`}</p>}
    {unresolved.some(item => item.reason !== 'missingDate') && <p className="status-missing">Payment amounts still need checking.</p>}
    <PlanningPossibilities snapshot={snapshot} />
    <p className="card-meta">{partial ? 'Dates and remaining costs can change this picture.' : unconfirmed ? 'Some details are still unconfirmed.' : 'Based on your reported figures.'} Not a spending allowance.</p>
    <details className="card-terms status-details"><summary>{needsAttention ? 'Needs attention' : 'Why?'}</summary>
      <div className="status-detail-body">
        <p>Starting cash plus counted income, less dated spending and payments. Undated items can still reduce what is left.</p>
        {!!unresolved.length && <ul>{unresolved.map((item, index) => <li key={`${item.recordId}:${item.reason}:${index}`}>
          <strong>{item.reason === 'missingDate' ? 'Date needed' : item.reason === 'unknownTarget' ? 'Intended payment unknown' : 'Amount needed'}:</strong> {amount(item)}
        </li>)}</ul>}
        {!!issues.length && <ul>{issues.map(issue => <li key={issue.id}>
          {issue.recordIds.map(id => snapshot.facts.records.find(record => record.id === id)?.label).filter(Boolean).join(', ') || 'Plan'} · {fieldLabels[issue.field] ?? (issue.field === 'coverage' ? 'Other income or commitments' : 'Unconfirmed detail')} · {issue.kind === 'conflict' ? 'Conflicting reports' : issue.kind === 'missing' || issue.kind === 'coverage' ? 'Needs confirming' : 'Unconfirmed'}{issue.beforeDate && ` · Before ${cardDate(issue.beforeDate)}`}
        </li>)}</ul>}
        {plan.troughPaise !== null && <p>Lowest projected balance: {cardMoney(plan.troughPaise)}</p>}
        {!!excluded.length && <><h4>Not counted</h4><ul>{excluded.map(item => {
          const record = snapshot.facts.records.find(record => record.id === item.recordId);
          const event = plan.events.find(event => event.id === item.eventId);
          return <li key={item.id}>{record?.label ?? 'Starting cash'} · {!event && record?.schedule.amounts?.length ? 'Varies by occurrence' : cardMoney(item.amountPaise)}{(event?.amountStatus ?? record?.amount.status) === 'estimate' && ' est.'}{item.date && ` · ${cardDate(item.date)}`} · {reasons[closing.excludedReasons?.[item.id] ?? item.reason] ?? 'Needs confirming'}</li>;
        })}</ul></>}
        <p>Payments may leave before income arrives on the same day.</p>
        {snapshot.accepted && <p>Saved planning assumptions included · No payments made</p>}
      </div>
    </details>
  </section>;
}