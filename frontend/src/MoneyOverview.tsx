// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from 'react-router';
import type { Command, Snapshot } from './api';
import { Details } from './Dialog';
import { dateLabel as fullDateLabel, decimal, lastDate, money as preciseMoney } from './money';
import { ResultDetails } from './WorkspaceDetails';
import { ActionDetails } from './ScenarioDetails';
import { PlanExpiry, PlanSummary, ResultQualification } from './PlanSummary';
import { Download } from './Download';
import { PlanningPossibilities } from './PlanningPossibilities';
import { MoneyChart } from './MoneyChart';
import { MoneyIcon } from './MoneyIcon';
import { ExchangeValues } from './MoneyValues';
import type { EditTarget } from './MoneyEdit';
import { moneyIssues } from './MoneyChecks';
import { factStatus } from './MoneyRecords';
import './moneyOverview.css';

/** Formats an overview amount without unnecessary fractional zeros. */
const money = (value: number | null) => preciseMoney(value).replace(/\.00$/, '');
/** Formats a concise day-and-month label for the overview. */
const dateLabel = (value: string) => fullDateLabel(value).replace(/ \d{4}$/, '');

/** Summarizes cash flow, upcoming commitments, and the plan's next steps. */
export function MoneyOverview({ snapshot, blocked, stale = false, onEdit, onChecks, onCommand }: {
  snapshot: Snapshot; blocked: boolean; stale?: boolean; onEdit: (target: EditTarget) => void; onChecks: () => void;
  onCommand: (operation: Command['operation']) => void;
}) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const opening = plan.planningFacts.opening;
  const conversion = opening.source?.conversion;
  const unknownFee = conversion?.provider === 'frankfurter' && conversion.direction !== 'valuation' && conversion.fee == null;
  const assessment = plan.decisionAssessment;
  const outcome = assessment?.outcome;
  const action = snapshot.workspace?.actions?.find(item => item.id === assessment?.nextActionId) ?? snapshot.workspace?.actions?.[0];
  const issues = moneyIssues(snapshot);
  const choice = snapshot.workspace?.choices?.find(item => item.id === action?.choiceId);
  const incomplete = plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete;
  const conflicts = !!snapshot.facts.conflicts?.length;
  const estimated = opening.status === 'estimate' || plan.events.some(event => event.included && (event.amountStatus === 'estimate' || snapshot.facts.records.find(record => record.id === event.recordId)?.schedule.certainty === 'estimate'));
  const nextIncome = plan.events.find(event => event.kind === 'income' && event.included && event.amountPaise && event.date >= plan.evaluatedOn);
  const peakTiming = plan.timingRisks?.find(item => item.date === plan.peakGapDate);
  const upcoming = plan.events.filter(event => event.date >= plan.evaluatedOn);
  const elapsed = plan.events.length - upcoming.length;
  const undated = new Set(plan.budgetBasis.unresolvedAmounts.filter(item => item.reason === 'missingDate').map(item => item.recordId)).size;
  const seen = new Set<string>();
  const nextItems = upcoming.filter(event => { if (seen.has(event.recordId)) return false; seen.add(event.recordId); return true; }).slice(0, 4);
  const hasIncome = snapshot.facts.records.some(record => record.kind === 'income') || snapshot.facts.coverage.income === 'none';
  const hasOutflow = snapshot.facts.records.some(record => record.kind !== 'income') || ['essential', 'optional', 'debt'].every(kind => snapshot.facts.coverage[kind as 'essential' | 'optional' | 'debt'] === 'none');
  // Zero subtotals do not establish zero income or spending while amounts or dates remain unresolved.
  const unknownIncome = plan.reliableIncomePaise === 0 && plan.uncertainIncomePaise === 0 && plan.budgetBasis.unresolvedAmounts.some(item => snapshot.facts.records.some(record => record.id === item.recordId && record.kind === 'income'));
  const unknownOutflow = plan.outflowPaise === 0 && plan.budgetBasis.unresolvedAmounts.some(item => snapshot.facts.records.some(record => record.id === item.recordId && record.kind !== 'income'));
  const income = hasIncome ? unknownIncome ? 'Unknown' : money(plan.reliableIncomePaise) : 'Not added';
  const outflow = hasOutflow ? unknownOutflow ? 'Unknown' : money(plan.outflowPaise) : 'Not added';
  const receipts = plan.events.filter(event => event.kind === 'income' && event.included).length;
  const payments = new Set(plan.events.filter(event => event.kind !== 'income' && event.included).map(event => event.recordId)).size;
  const actionNames = action?.recordIds.map(id => snapshot.facts.records.find(record => record.id === id)?.label).filter(Boolean).slice(0, 2).join(', ');
  const actionLabel = action ? ({ contactPayee: 'Discuss payment options', verifyTerms: 'Check payment terms', followUp: 'Follow up on payment options', seekSupport: 'Explore support options', resolveGroup: 'Review these payments together', confirmReceipt: 'Check incoming money', previewChange: 'Compare a spending change', reconcileStatus: 'Check earlier payments', clarify: 'Confirm a detail', reviewOutcome: 'Review your next step' }[action.kind] ?? 'Review next step') : '';
  /** Offers an explanation for an available calculated result. */
  const result = (id: string, label: string) => {
    const value = snapshot.workspace?.results?.find(item => item.id === id);
    return value && <ResultDetails result={value} snapshot={snapshot} label={label} />;
  };
  return <div className="money-overview">
    <PlanSummary snapshot={snapshot} stale={stale} showQualifications={false} compact>
      <div className="money-attention-action">{action ? <Details label={actionLabel} title="Your next step"><h3>{actionLabel}{actionNames && <> · {actionNames}</>}</h3><ActionDetails action={action} plan={plan} facts={snapshot.facts} />
        {action.kind === 'previewChange' && choice?.adjustmentAmounts.length ? <button disabled={blocked || !!snapshot.preview} onClick={() => onCommand({ type: 'previewAdjustments', adjustments: choice.adjustmentAmounts.map(item => ({ eventId: item.eventId, amount: decimal(item.amountPaise) })) })}>Compare change</button>
          : ['clarify', 'confirmReceipt', 'verifyTerms', 'contactPayee', 'followUp', 'seekSupport', 'resolveGroup'].includes(action.kind) && <button disabled={blocked} onClick={() => onCommand({ type: 'respondToAction', actionId: action.id, response: 'unavailable' })}>I can’t confirm or take this step now</button>}
      </Details> : <button onClick={onChecks}>Review details</button>}</div>
    </PlanSummary>
    <section className="money-summary" aria-label="Money in this plan">
      <dl className="money-metrics">
        <div className="money-metric"><dt>Opening cash<button className="money-edit-cash" disabled={blocked} aria-label="Correct starting cash" title="Correct starting cash" onClick={() => onEdit({ field: 'opening' })}><MoneyIcon name="edit" /></button></dt><dd>{money(opening.amountPaise)}</dd><span>{dateLabel(snapshot.anchorDate)}{opening.status === 'estimate' && ' · Estimated'}{factStatus(snapshot, 'opening') === 'Conflicting reports' && ' · Check amount'}</span>
          {unknownFee && <span className="money-metric-caution">Conversion fee unknown · not included</span>}
          {snapshot.facts.opening.source?.conversion && <Details label="Opening exchange details" title="Opening cash conversion"><ExchangeValues source={snapshot.facts.opening.source} capturedPaise={snapshot.facts.opening.amountPaise} currentMoney={opening} plan={plan} /></Details>}
        </div>
        <div className="money-metric is-income"><dt>Expected income included</dt><dd>{income}</dd><span>{unknownIncome ? 'Amount or date still needed' : nextIncome ? `Next ${dateLabel(nextIncome.date)} · ${receipts} ${receipts === 1 ? 'receipt' : 'receipts'}` : hasIncome ? 'During this plan' : 'Add your expected income'}</span>{plan.uncertainIncomePaise > 0 && <span className="money-metric-caution">{money(plan.uncertainIncomePaise)} uncertain · not included</span>}</div>
        <div className="money-metric"><dt>Money going out</dt><dd>{outflow}</dd><span>{unknownOutflow ? 'Amount or date still needed' : payments ? `${payments} ${payments === 1 ? 'item' : 'items'} · Payments & budgets` : hasOutflow ? 'Payments & budgeted spending' : 'Add bills and living costs'}</span></div>
        <div className="money-metric money-metric-closing"><dt>{plan.undatedImpact ? 'Dated end balance' : 'Closing forecast'}</dt><dd>{money(plan.closingPaise)}</dd><span>For {dateLabel(lastDate(snapshot.endDateExclusive))}</span><ResultQualification snapshot={snapshot} id="closing" details={false} /></div>
      </dl>
    </section>

    {opening.amountPaise === null && !snapshot.facts.opening.source?.conversion && !conflicts && <button disabled={blocked} onClick={() => onEdit({ field: 'opening' })}>Add starting cash</button>}

    <div className="money-overview-body">
      <section className="money-panel money-flow" aria-label="Cash flow forecast">
        <header className="money-section-head"><h2>Your cash flow</h2><span className={`money-status-pill${incomplete || estimated || conflicts ? ' is-caution' : ''}`}>{conflicts ? 'Check figures' : incomplete ? 'Some details missing' : estimated ? 'Includes estimates' : 'Forecast'}</span></header>
        <MoneyChart snapshot={snapshot} />
        <div className="money-flow-footer"><span>Forecast · Not a live bank balance</span><Details label="View calculation" title="Plan details">
          <dl className="money-detail-values"><div><dt>Opening cash · {dateLabel(snapshot.anchorDate)}</dt><dd>{money(opening.amountPaise)}</dd></div><div><dt>Expected income included</dt><dd>{income}</dd></div><div><dt>Payments and budgeted spending</dt><dd>{outflow}</dd></div><div><dt>Projected closing cash</dt><dd>{money(plan.closingPaise)}</dd></div><div><dt>{peakTiming ? 'Largest timing exposure' : 'Largest shortfall'}</dt><dd>{money(plan.peakGapPaise)}{plan.peakGapDate && <> · {dateLabel(plan.peakGapDate)}</>}</dd></div></dl>
          {snapshot.facts.opening.source?.conversion && <details><summary>Opening conversion details</summary><ExchangeValues source={snapshot.facts.opening.source} capturedPaise={snapshot.facts.opening.amountPaise} currentMoney={opening} plan={plan} /></details>}
          {unknownFee && <p>Opening conversion fee unknown · not included in the forecast.</p>}
          {peakTiming && <p>Needed before same-day income. {peakTiming.remainingGapPaise > 0 ? `${money(peakTiming.remainingGapPaise)} still unfunded after included income.` : 'No remaining gap after included income; payment timing is not guaranteed.'}</p>}
          <p>Opening cash + included income − planned spending = closing cash. The first and largest {peakTiming ? 'exposures' : 'shortfalls'} are not amounts to add together.</p>
          <p>Payments precede income on the same day. Unconfirmed receipts, amounts and dates are not available money.</p>
          {outcome && <p>{outcome.conditions}</p>}
          <ResultQualification snapshot={snapshot} id="closing" />
          <PlanningPossibilities snapshot={snapshot} />
          <div className="money-detail-actions">{result('closing', 'How this is calculated')}{result('firstGap', 'What causes the first shortfall')}{result('reliableIncome', 'Which income is included')}</div>
        </Details></div>
      </section>
      <section className="money-panel money-coming-up" aria-label="Next money and payments">
        <header className="money-section-head"><h2>Coming up</h2><Link to="/money/upcoming" className="money-text-link" aria-label="View all upcoming events">View all <MoneyIcon name="expand" /></Link></header>
        {nextItems.length ? <ol className="money-upcoming-compact">{nextItems.map(event => {
          const record = snapshot.facts.records.find(record => record.id === event.recordId);
          const recurring = record && record.schedule.recurrence !== 'once';
          const basis = event.amountBasis === 'requiredOnly' ? 'Minimum only · target unknown' : event.amountBasis === 'requiredFloor' ? 'Minimum counted · exceeds target' : event.amountBasis === 'assumed' ? 'Saved change · not paid' : record?.target ? 'Intended payment · includes minimum' : event.kind === 'income' ? 'Expected' : record?.kind === 'debt' ? 'Required payment' : '';
          const budget = event.amountBasis === 'budget' ? ({ once: 'Budget', daily: 'Daily budget', weekly: 'Weekly budget', fortnightly: 'Fortnightly budget', monthly: 'Monthly budget', monthlyBudget: 'Daily share · Monthly budget' })[record?.schedule.recurrence ?? 'once'] : '';
          return <li key={event.recordId} aria-label={event.label}><span className={`money-event-symbol${event.kind === 'income' ? ' is-income' : ''}`} aria-hidden="true">{event.kind === 'income' ? '↙' : '↗'}</span><div className="money-upcoming-name"><strong>{event.label}</strong><span>{dateLabel(event.date)}{budget ? ` · ${budget}` : recurring ? ' · Next payment' : ''}</span><span className="money-upcoming-status">{[basis, event.autoDebit && 'Auto-debit', !event.included && 'Not included · unconfirmed', event.amountStatus === 'estimate' && 'Estimated amount', event.dateAssumption ? 'Assumed date' : record?.schedule.certainty === 'estimate' ? 'Estimated date' : record?.schedule.certainty === 'unknown' ? 'Date uncertain' : '', event.overdue && `Overdue · originally due ${dateLabel(event.originalDueDate)}`].filter(Boolean).join(' · ')}</span></div><strong className={`money-upcoming-amount${event.kind === 'income' ? ' is-income' : ''}`}>{event.amountPaise === null ? 'Unknown' : `${event.kind === 'income' ? '+' : '−'}${money(event.amountPaise)}`}</strong></li>;
        })}</ol> : <div className="money-upcoming-empty"><p>{elapsed ? 'No later dated items' : 'No upcoming dates yet'}</p><Link to={elapsed ? '/money/upcoming' : '/money/spending'}>{elapsed ? 'Review earlier payments' : 'Add a bill or expense'}</Link></div>}
        {!!elapsed && nextItems.length > 0 && <Link className="money-text-link" to="/money/upcoming">{elapsed} earlier {elapsed === 1 ? 'item' : 'items'} · status unconfirmed</Link>}
      </section>
    </div>

    <footer className="money-overview-footnotes">
      <div>{(issues.length > 0 || undated > 0) && <button className="money-text-link" onClick={onChecks}>{undated ? `${undated} ${undated === 1 ? 'item needs' : 'items need'} a date` : `${issues.length} ${issues.length === 1 ? 'detail' : 'details'} to review`} <MoneyIcon name="expand" /></button>}</div>
      <div><button className="money-text-link" disabled={blocked} onClick={() => onEdit({ field: 'reserve' })}>{snapshot.facts.reservePaise > 0 ? `Cash buffer ${money(snapshot.facts.reservePaise)}` : 'Set a cash buffer'}<MoneyIcon name="edit" /></button>{!!(snapshot.preview || snapshot.accepted || snapshot.invalidatedAssumptions?.length) && <Link className="money-text-link" to="/money/changes">{snapshot.preview ? 'Preview not applied' : snapshot.invalidatedAssumptions?.length ? 'Review changed assumptions' : 'Saved changes included'}<MoneyIcon name="expand" /></Link>}</div>
      {!blocked && <div className="money-overview-download"><Download label="Download saved plan" /></div>}
      <PlanExpiry snapshot={snapshot} />
    </footer>
  </div>;
}