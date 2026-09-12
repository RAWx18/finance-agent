// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from './api';
import { dateLabel, lastDate, money } from './money';
import { MoneyEvent } from './MoneyUpcoming';
import { amountStatus, coverageLabels, factStatus } from './MoneyRecords';
import { moneyIssues } from './MoneyChecks';

export function MoneyPrint({ snapshot }: { snapshot: Snapshot }) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const outcome = plan.decisionAssessment?.outcome;
  const actions = snapshot.workspace?.actions ?? [];
  const action = actions.find(item => item.id === plan.decisionAssessment?.nextActionId) ?? actions[0];
  return <article hidden className="money-print print-only" aria-label="Saved plan for printing">
    <h1>Money</h1><p>{dateLabel(snapshot.anchorDate)} – {dateLabel(lastDate(snapshot.endDateExclusive))}</p>
    <h2>{plan.firstGap ? `First funding gap: ${money(plan.firstGap.amountPaise)} on ${dateLabel(plan.firstGap.date)}` : plan.closingPaise === null ? 'Funding position unknown' : 'No gap in the dated figures'}</h2>
    <p>Calculated outlook</p>{action && <p>Next step: {action.question}</p>}
    <dl><div><dt>Cash at plan start · {dateLabel(snapshot.anchorDate)} · {factStatus(snapshot, 'opening')}</dt><dd>{money(snapshot.facts.opening.amountPaise)}</dd></div>
      <div><dt>Income included · Calculated, expected, not received</dt><dd>{money(plan.reliableIncomePaise)}</dd></div>
      <div><dt>Projected closing cash · Calculated</dt><dd>{money(plan.closingPaise)}</dd></div>
      <div><dt>Largest funding gap · Calculated</dt><dd>{money(plan.peakGapPaise)}{plan.peakGapDate && <> · {dateLabel(plan.peakGapDate)}</>}</dd></div></dl>
    <p>Calculated from reported figures, not a live bank balance. Closing cash is not available to spend. Missing amounts and dates are not zero.</p>
    {snapshot.accepted && <><h2>Saved assumptions · not completed payments</h2><ul>{snapshot.accepted.adjustments.map(item => {
      const record = snapshot.facts.records.find(record => record.id === item.recordId);
      return <li key={item.eventId}>{item.label} · {dateLabel(item.date)} · Date: {factStatus(snapshot, 'schedule.date', record)}: {money(item.originalPaise)} {factStatus(snapshot, record?.target ? 'target' : 'amount', record)} → {money(item.amountPaise)} Saved assumption{item.kind === 'card' && <> · Required minimum {money(item.minimumPaise)} {factStatus(snapshot, 'amount', record)} · intended payment includes minimum</>}</li>;
    })}</ul></>}
    <h2>Upcoming money & payments</h2><ol className="money-events">{plan.events.map(event => <MoneyEvent key={event.id} event={event} snapshot={snapshot} />)}</ol>
    <h2>Needs your check</h2><ul>{moneyIssues(snapshot).map(issue => <li key={issue.id}>{issue.question} {issue.reason}</li>)}</ul>
    {!!plan.budgetBasis.unresolvedAmounts.length && <><h3>Unresolved amounts and dates</h3><ul>{plan.budgetBasis.unresolvedAmounts.map((item, index) => {
      const record = snapshot.facts.records.find(record => record.id === item.recordId);
      return <li key={`${item.recordId}:${index}`}>{record?.label ?? 'Unresolved item'} · {money(item.amount.amountPaise)} {record ? factStatus(snapshot, record.target?.amountPaise != null ? 'target' : 'amount', record) : amountStatus[item.amount.status]} · {item.reason === 'missingDate' ? 'Date needed; not in dated balances' : item.reason === 'unknownTarget' ? 'Intended payment unknown; required amount only' : 'Amount unknown'}</li>;
    })}</ul></>}
    <h2>Reported items</h2><ul>{snapshot.facts.records.map(item => <li key={item.id}>{item.label}: {money(item.amount.amountPaise)} · {factStatus(snapshot, 'amount', item)}
      {item.kind === 'debt' && <> required / minimum · Intended, including minimum: {item.target ? money(item.target.amountPaise) : 'Not supplied'} · {factStatus(snapshot, 'target', item)} · Outstanding: {item.outstanding ? money(item.outstanding.amountPaise) : 'Not supplied'} · {factStatus(snapshot, 'outstanding', item)}</>}
      {' · '}{item.schedule.date ? dateLabel(item.schedule.date) : 'Date unknown'} · {factStatus(snapshot, 'schedule.date', item)}</li>)}</ul>
    <h2>Category coverage</h2><ul>{(['income', 'essential', 'optional', 'debt'] as const).map(kind => <li key={kind}>{kind === 'debt' ? 'Loans & cards' : kind === 'essential' ? 'Essentials' : kind === 'optional' ? 'Other spending' : 'Income'}: {coverageLabels[snapshot.facts.coverage[kind] ?? 'notDiscussed']}</li>)}</ul>
    <p>No payments are made. {outcome?.conditions}</p>
  </article>;
}