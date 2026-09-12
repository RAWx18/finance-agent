// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from 'react-router';
import type { Command, Snapshot } from './api';
import { Details } from './Dialog';
import { dateLabel, decimal, money } from './money';
import { ResultDetails } from './WorkspaceDetails';
import { ActionDetails, actionLabels } from './ScenarioDetails';
import { MoneyEvent } from './MoneyUpcoming';
import { MoneyIcon } from './MoneyIcon';
import type { EditTarget } from './MoneyEdit';
import { moneyIssues } from './MoneyChecks';
import { factStatus } from './MoneyRecords';

export function MoneyOverview({ snapshot, blocked, onEdit, onChecks, onCommand }: {
  snapshot: Snapshot; blocked: boolean; onEdit: (target: EditTarget) => void; onChecks: () => void;
  onCommand: (operation: Command['operation']) => void;
}) {
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const assessment = plan.decisionAssessment;
  const outcome = assessment?.outcome;
  const actions = snapshot.workspace?.actions ?? [];
  const action = actions.find(item => item.id === assessment?.nextActionId) ?? actions[0];
  const issues = moneyIssues(snapshot);
  const questions = snapshot.workspace?.questions ?? [];
  const selectedQuestion = questions.find(item => item.id === assessment?.nextQuestionId) ?? questions[0];
  const question = issues.find(item => item.id === selectedQuestion?.id);
  const check = question ?? issues[0];
  const checkNames = check?.recordIds.map(id => snapshot.facts.records.find(record => record.id === id)?.label).filter(Boolean).join(', ');
  const checkLabels: Record<string, string> = { opening: 'Starting cash', amount: 'Amount', target: 'Intended payment', outstanding: 'Outstanding balance', 'schedule.date': 'Expected or due date', coverage: 'Category review', reliability: 'Income reliability', controllability: 'Whether spending can change', providerResponses: 'Payment terms', ambiguousRecordIds: 'Which item was meant' };
  const actionNames = action?.recordIds.map(id => snapshot.facts.records.find(record => record.id === id)?.label).filter(Boolean).join(', ');
  const choice = snapshot.workspace?.choices?.find(item => item.id === action?.choiceId);
  const undated = new Set(plan.budgetBasis.unresolvedAmounts.filter(item => item.reason === 'missingDate').map(item => item.recordId)).size;
  const excludedIncome = new Set(snapshot.workspace?.contributions?.filter(item => !item.id.startsWith('proposal:') && !item.included && item.reason === 'conditionalReceipt'
    && snapshot.facts.records.some(record => record.id === item.recordId && record.kind === 'income')).map(item => item.recordId)).size;
  const upcoming = plan.events.filter(event => event.date >= plan.evaluatedOn);
  const elapsed = plan.events.length - upcoming.length;
  const conflicts = snapshot.facts.conflicts?.length ?? 0;
  const headline = plan.firstGap ? 'First funding gap' : plan.closingPaise === null ? 'Your picture needs a check' : outcome?.branch === 'fits' && outcome.readiness === 'ready' ? 'Known dated payments fit' : 'What needs attention';
  const result = (id: string) => {
    const value = snapshot.workspace?.results?.find(item => item.id === id);
    const labels: Record<string, string> = { firstGap: 'Why the shortfall?', reliableIncome: 'Income calculation', closing: 'Closing calculation', peakGap: 'Largest gap calculation' };
    return value && <ResultDetails result={value} snapshot={snapshot} label={labels[id]} />;
  };
  return <div className="money-overview">
    <section className={`money-panel money-attention${plan.firstGap || conflicts ? ' has-risk' : ''}`} aria-label="What needs attention">
      <div className="money-section-head"><h2>{headline}</h2>{issues.length > 0 && <button className="detail-button money-check-count" onClick={onChecks}>{issues.length} {issues.length === 1 ? 'check' : 'checks'}</button>}</div>
      {plan.firstGap && <p className="money-gap"><strong>{money(plan.firstGap.amountPaise)}</strong><span>short on {dateLabel(plan.firstGap.date)} · Calculated</span></p>}
      {!plan.firstGap && <p className="money-meta">{plan.closingPaise === null ? 'A starting amount is needed to calculate the balance.' : outcome?.readiness === 'ready' && outcome.branch === 'fits' ? 'Based on the dates and amounts in this plan.' : 'Some details still need checking before relying on the result.'}</p>}
      {!!conflicts && <p className="money-warning">Conflicting reports · no amount chosen for you</p>}
      {(plan.projectionPartial || !plan.budgetBasis.datedProjectionComplete) && <p className="money-warning">Partial calculation · some amounts or dates are missing</p>}
      {action && <div className="money-next"><h3>Next step</h3><p><strong>{action.kind === 'contactPayee' ? 'Discuss payment options' : actionLabels[action.kind] ?? 'Review the next step'}</strong>{actionNames && <> · {actionNames}</>}</p>
        {action?.beforeDate && <p className="money-meta">Before {dateLabel(action.beforeDate)}</p>}
        <div className="money-detail-actions"><Details label="What to check"><ActionDetails action={action} plan={plan} facts={snapshot.facts} /></Details>
          {action.kind === 'previewChange' && choice?.adjustmentAmounts.length ? <button disabled={blocked || !!snapshot.preview} onClick={() => onCommand({ type: 'previewAdjustments', adjustments: choice.adjustmentAmounts.map(item => ({ eventId: item.eventId, amount: decimal(item.amountPaise) })) })}>Compare change</button>
            : ['clarify', 'confirmReceipt', 'verifyTerms', 'contactPayee', 'followUp', 'seekSupport', 'resolveGroup'].includes(action.kind) && <button className="detail-button" disabled={blocked} title="Skip this step; payment dates and amounts stay unchanged" aria-label={['clarify', 'confirmReceipt', 'verifyTerms'].includes(action.kind) ? 'I cannot confirm this now' : 'I cannot take this step now'} onClick={() => onCommand({ type: 'respondToAction', actionId: action.id, response: 'unavailable' })}>Skip this step</button>}</div>
      </div>}
      <div className="money-detail-actions">{result('firstGap')}<Details label="Plan details">
        <dl className="money-detail-values"><div><dt>Cash at plan start · {factStatus(snapshot, 'opening')}</dt><dd>{money(snapshot.facts.opening.amountPaise)}</dd></div>
          <div><dt>Included income · Calculated</dt><dd>{money(plan.reliableIncomePaise)}</dd></div>
          <div><dt>Dated payments · Calculated</dt><dd>{money(plan.outflowPaise)}</dd></div>
          <div><dt>Projected closing cash · Calculated</dt><dd>{money(plan.closingPaise)}</dd></div>
          <div><dt>Largest funding gap · Calculated</dt><dd>{money(plan.peakGapPaise)}{plan.peakGapDate && <> · {dateLabel(plan.peakGapDate)}</>}</dd></div>
          {snapshot.facts.reservePaise > 0 && <><div><dt>Cash to keep aside · Reported, not spending</dt><dd>{money(snapshot.facts.reservePaise)}</dd></div><div><dt>Reserve shortfall · Calculated, separate from funding gap</dt><dd>{money(plan.reserveShortfallPaise)}</dd></div></>}
        </dl><p>Starting cash + included income − dated payments = closing cash.</p>
        <p>Closing cash is not spare spending money. Later receipts cannot cover an earlier deadline; the first and largest gaps are not amounts to add together.</p>
        <div className="money-detail-actions">{result('closing')}{result('peakGap')}
          {outcome && <Details label="Conditions & open questions"><p>{outcome.summary}</p><p>{outcome.covered}</p><p>{outcome.notCovered}</p><p>{outcome.conditions}</p></Details>}</div>
      </Details></div>
    </section>
    <section className="money-panel" aria-label="Money in this plan"><h2>Money in this plan</h2>
      <dl className="money-start-values"><div><dt>Cash at plan start · {dateLabel(snapshot.anchorDate)}</dt><dd><strong>{money(snapshot.facts.opening.amountPaise)}</strong><button className="icon-button" disabled={blocked} aria-label="Correct starting cash" title="Correct starting cash" onClick={() => onEdit({ field: 'opening' })}><MoneyIcon name="edit" /></button></dd><span className="money-meta">{factStatus(snapshot, 'opening')}</span></div>
        <div><dt>Income included during this plan · Calculated</dt><dd><strong>{money(plan.reliableIncomePaise)}</strong></dd><span className="money-meta">Expected, not marked received</span></div></dl>
      {!!excludedIncome && <p className="money-warning">{excludedIncome} conditional income {excludedIncome === 1 ? 'item is' : 'items are'} not counted on.</p>}
      <div className="money-detail-actions"><Link to="/money/income">View income</Link>{result('reliableIncome')}<button className="detail-button" disabled={blocked} onClick={() => onEdit({ field: 'reserve' })}>Cash to keep aside{snapshot.facts.reservePaise > 0 && <> · {money(snapshot.facts.reservePaise)}</>}</button></div>
    </section>
    <section className="money-panel" aria-label="Next money and payments"><div className="money-section-head"><h2>Next money & payments</h2><Link className="button icon-button" to="/money/upcoming" aria-label="View all upcoming events" title="View all upcoming events"><MoneyIcon name="expand" /></Link></div>
      {upcoming.length ? <ol className="money-events money-next-events">{upcoming.slice(0, 3).map(event => <MoneyEvent key={event.id} {...{ event, snapshot }} compact />)}</ol> : <p>{plan.events.length ? 'No later dated requirements in this plan.' : 'No dated events in this plan.'} See category coverage and checks before drawing a conclusion.</p>}
      {!!elapsed && <p className="money-meta"><Link to="/money/upcoming">{elapsed} earlier {elapsed === 1 ? 'requirement' : 'requirements'}</Link> · status not confirmed</p>}
      {!!undated && <p className="money-warning"><Link to="/money/upcoming">{undated} {undated === 1 ? 'item needs' : 'items need'} a date</Link> · not in dated balances.</p>}
    </section>
    <section className="money-panel" aria-label="Needs your check"><h2>Needs your check</h2>
      <p>{check ? <>{checkNames && <strong>{checkNames} · </strong>}{checkLabels[check.field ?? ''] ?? 'An unconfirmed detail'}</> : conflicts ? 'Conflicting reports' : 'No open checks in this assessment.'}</p>
      {!question && issues.length > 0 && <p className="money-meta">Still unresolved · you can return to these later</p>}
      {(issues.length > 0 || conflicts > 0) && <button className="detail-button" onClick={onChecks}>{issues.length > 1 ? `Review ${issues.length} checks` : 'Review checks'}</button>}
      {(snapshot.preview || snapshot.accepted || snapshot.invalidatedAssumptions?.length) ? <div className="money-change-notice">
        <p>{snapshot.preview ? 'Proposed changes · not in your plan' : snapshot.accepted ? 'Saved changes are active · not payment confirmations' : 'Some changes need fresh consent'}</p>
        {!!snapshot.invalidatedAssumptions?.length && <p className="money-warning">{snapshot.invalidatedAssumptions.length} saved changes are no longer included.</p>}
        <Link to="/money/changes">Review plan changes</Link>
      </div> : null}
    </section>
  </div>;
}