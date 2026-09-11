// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from './api';
import type { ReactNode } from 'react';
import { Details } from './Dialog';
import { dateLabel, money } from './money';
import { kindLabels, kinds } from './validation';
import { PagedList } from './PagedList';
import { AssessmentDetails, Assumptions, BudgetDetails, NextSteps, outcomeLabels, PlanComparison } from './ScenarioDetails';

const coverageLabels = {
  notDiscussed: 'Not checked', reported: 'Needs review', unknown: 'Not sure', reviewed: 'Reviewed', none: 'Confirmed none',
};
const amountLabels = { exact: 'Reported', estimate: 'Estimate', unknown: 'Unknown' };
const recurrenceLabels = { once: 'One time', weekly: 'Every week', fortnightly: 'Every two weeks', monthly: 'Every month' };

export function Projection({ snapshot, stale, children }: { snapshot: Snapshot; stale: boolean; children?: ReactNode }) {
  const { facts, accepted } = snapshot;
  const plan = accepted?.plan ?? snapshot.plan;
  const outcome = plan.decisionAssessment?.outcome;
  const issues = plan.issues.filter(issue => !(plan.decisionAssessment?.uncertainties ?? []).some(item =>
    item.question === issue.message || (item.recordIds.includes(issue.recordId ?? '') && (
      (issue.code === 'unknownDate' && item.field === 'schedule.date')
      || (issue.code === 'unknownAmount' && item.field === 'amount')
      || (issue.code === 'unknownTarget' && item.field === 'target')
      || (issue.code === 'uncertainIncome' && item.field === 'reliability')
      || (issue.code === 'debtBalanceConflict' && item.field === 'debtTerms')
    )) || (issue.code === 'unknownOpening' && item.field === 'opening')
    || (issue.code === 'coverageIncomplete' && item.kind === 'coverage')));
  return <div className="projection" aria-label="Financial details">
    <section className="card" aria-labelledby="overview-heading">
      <p className="eyebrow">{accepted ? 'With saved assumptions' : 'Based on what you shared'}{stale ? ' · may be out of date' : ''}</p>
      <h2 id="overview-heading">{outcome ? outcomeLabels[outcome.branch] : 'Your picture is taking shape'}{accepted ? ' · with planning assumptions' : ''}</h2>
      <p>{plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete ? 'Not all costs are included.'
        : outcome?.readiness === 'qualified' ? 'Some figures need checking.' : 'These figures reflect what you shared.'}</p>
      <BudgetDetails plan={plan} facts={facts} />
      <dl className="metrics">
        <div><dt>Available cash</dt><dd>{money(facts.opening.amountPaise)}</dd><small>{amountLabels[facts.opening.status]}</small></div>
        <div><dt>Known reliable income</dt><dd>{money(plan.reliableIncomePaise)}</dd><small>Dated receipts included</small></div>
        <div><dt>{accepted ? 'Assumed outflows' : 'Known outflows'}</dt><dd>{money(plan.outflowPaise)}</dd><small>Planned, not paid</small></div>
        <div><dt>{accepted ? 'Assumed closing cash' : 'Projected closing cash'}</dt><dd>{money(plan.closingPaise)}</dd><small>{!plan.budgetBasis.datedProjectionComplete || plan.projectionPartial ? 'Not available to spend' : 'Opening + reliable income − outflows'}</small></div>
      </dl>
      <div className={plan.peakGapPaise ? 'gap-summary warning' : 'gap-summary'}>
        <dl>
          <div><dt>First cash gap</dt><dd>{plan.firstGap ? <>{money(plan.firstGap.amountPaise)}<span className="detail">{dateLabel(plan.firstGap.date)}</span></> : plan.closingPaise === null ? 'Unknown' : 'None in dated figures'}</dd></div>
          <div><dt>Largest cash gap</dt><dd>{money(plan.peakGapPaise)}{plan.peakGapDate && <span className="detail">{dateLabel(plan.peakGapDate)}</span>}</dd></div>
          <div><dt>Lowest projected cash</dt><dd>{money(plan.troughPaise)}</dd></div>
        </dl>
        {plan.firstGap && <p className="hint">A positive closing balance does not cover an earlier gap.</p>}
        <Details label="Understanding cash gaps">
          <p>First gap is the cash needed on the first affected date. Largest gap is the deepest shortfall, not the sum of daily shortfalls.</p>
        </Details>
      </div>
      <dl className="minor-metrics">
        <div><dt>Known uncertain income · excluded</dt><dd>{money(plan.uncertainIncomePaise)}</dd></div>
        {(facts.reservePaise > 0 || (plan.reserveShortfallPaise !== null && plan.reserveShortfallPaise > 0)) && <>
          <div><dt>Reserve floor · not an expense</dt><dd>{money(facts.reservePaise)}</dd></div>
          <div><dt>Reserve shortfall</dt><dd>{money(plan.reserveShortfallPaise)}</dd></div>
        </>}
      </dl>
    </section>
    {!!plan.decisionAssessment?.actions?.length && <section className="card next-steps">
      <NextSteps plan={plan} facts={facts} />
    </section>}
    {accepted && <section className="card saved-assumptions" aria-labelledby="assumptions-heading">
      <h2 id="assumptions-heading">Saved planning assumptions</h2>
      <Assumptions scenario={accepted} />
      <PlanComparison baseline={snapshot.plan} assumed={plan} reserve={facts.reservePaise} label="After · saved assumptions" />
    </section>}
    {children}
    <section className="card attention" aria-labelledby="attention-heading">
      <h2 id="attention-heading">Needs attention</h2>
      <AssessmentDetails plan={plan} />
      {issues.length ? <PagedList className="issue-list" label="Figures and timing to check">
        {issues.map((issue, index) => <li key={`${issue.code}-${issue.recordId}-${index}`}>
          {issue.recordId && <strong>{facts.records.find((record) => record.id === issue.recordId)?.label ?? 'Item'}: </strong>}{issue.message}
        </li>)}
      </PagedList> : null}
      <p className="hint">Same-day debits come before receipts. Uncertain income is excluded from balances. No payments have been made by this service.</p>
    </section>
    <section className="card" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">{accepted ? 'Dated cash flow · saved assumptions' : 'Dated cash flow'}</h2>
      <p className="hint">{accepted ? 'Includes saved assumptions. ' : ''}Items with unknown dates are not shown.</p>
      {plan.events.length ? <PagedList className="timeline" label="Dated cash flow events" ordered>
        {plan.events.map((event) => <li key={event.id}>
          <div><time dateTime={event.date}>{dateLabel(event.date)}</time><h3>{event.label}</h3>
            <p className="hint">{kindLabels[event.kind]}{event.autoDebit ? ' · Automatic debit' : ''}{!event.included ? ' · Excluded from balance' : ''}</p>
            {event.amountBasis === 'requiredOnly' && <p className="hint">Required / minimum only · selected target unknown.</p>}
            {event.amountBasis === 'assumed' && <p className="hint">Saved assumption · not paid.</p>}
            {event.overdue && <p className="field-error">Unpaid · originally due {dateLabel(event.originalDueDate)}</p>}
          </div>
          <div className="event-amount"><strong>{event.amountPaise === null ? 'Unknown' : `${event.kind === 'income' ? '+' : '−'}${money(event.amountPaise)}`}</strong>
            <span>Balance {money(event.balancePaise)}</span></div>
        </li>)}
      </PagedList> : <p>No dated items in this period.</p>}
    </section>
    <section className="card" aria-labelledby="saved-items-heading">
      <h2 id="saved-items-heading">Saved income & commitments</h2>
      {accepted && <p className="hint">Reported amounts stay unchanged by assumptions.</p>}
      {facts.records.length ? <PagedList className="saved-items" label="Saved items">
        {facts.records.map((record) => <li key={record.id}>
          <h3>{record.label}</h3><p>{kindLabels[record.kind]} · {money(record.amount.amountPaise)} · {amountLabels[record.amount.status]}</p>
          <p className="hint">{record.schedule.date ? `Next unpaid / future: ${dateLabel(record.schedule.date)}` : 'Date unknown'} · {recurrenceLabels[record.schedule.recurrence]}
            {record.reliability ? ` · ${record.reliability} income` : ''}{record.autoDebit ? ' · Automatic debit' : ''}</p>
          {record.debtType && <p className="hint">{record.debtType === 'card' ? 'Credit card' : record.debtType === 'loan' ? 'Loan' : record.debtType === 'informal' ? 'Informal borrowing' : 'Debt type not confirmed'} · amount is required / minimum
            {record.target ? ` · Selected target: ${money(record.target.amountPaise)} (${amountLabels[record.target.status]}; includes minimum)` : ''}
            {record.outstanding ? ` · Outstanding: ${money(record.outstanding.amountPaise)} (${amountLabels[record.outstanding.status]}; unchanged)` : ''}</p>}
        </li>)}
      </PagedList> : <p>No items saved yet. Empty categories still need your confirmation.</p>}
      <dl className="coverage-status">{kinds.map((kind) => <div key={kind}><dt>{kindLabels[kind]}</dt><dd>{coverageLabels[facts.coverage[kind] ?? 'notDiscussed']}</dd></div>)}</dl>
    </section>
  </div>;
}