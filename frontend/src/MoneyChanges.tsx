// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { Command, Settings, Snapshot } from './api';
import { Assumptions, ProposalReview, RestoreReported } from './ScenarioDetails';
import { Comparison } from './Comparison';
import { Details } from './Dialog';
import { PagedList } from './PagedList';
import { amountLabel, dateLabel, decimal, money } from './money';
import { MoneyIcon } from './MoneyIcon';
import type { EditTarget } from './MoneyEdit';

/** Presents saved assumptions, suggested reductions, and custom planning changes. */
export function MoneyChanges({ snapshot, settings, active, blocked, pending, onCommand, onEdit }: {
  snapshot: Snapshot; settings: Settings; active: boolean; blocked: boolean; pending: boolean;
  onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined> | void;
  onEdit: (target: EditTarget) => void;
}) {
  const [custom, setCustom] = useState(false);
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const choices = snapshot.workspace?.choices?.filter(choice => choice.kind !== 'enquire') ?? [];
  const undated = snapshot.facts.records.filter(record => record.kind === 'optional'
    && snapshot.plan.budgetBasis.unresolvedAmounts.some(item => item.recordId === record.id && item.reason === 'missingDate'));
  const locked = blocked || pending || !active;
  return <div className="money-changes">
    <section className="money-panel changes-current" aria-label="Current planning changes"><div className="money-section-head"><h2>{snapshot.accepted ? 'Saved in your plan' : 'Your reported plan is active'}</h2><span className="changes-status">{snapshot.accepted ? 'Saved' : 'No changes saved'}</span></div>
      <p className="money-meta">{snapshot.accepted ? `${snapshot.accepted.adjustments.length} saved changes · no payments made.` : 'Try a lower amount. Your plan stays unchanged until you accept.'}</p>
      {snapshot.accepted && <Details label="View saved changes"><Assumptions scenario={snapshot.accepted} /></Details>}
      {!custom && <RestoreReported {...{ snapshot, active, onCommand }} locked={locked} />}
      {!!snapshot.invalidatedAssumptions?.length && <Details label={`${snapshot.invalidatedAssumptions.length} changes need fresh consent`}><p>These changes are no longer included. Unaffected saved changes remain.</p><PagedList label="Changes needing consent" className="money-checks" pageSize={6}>{snapshot.invalidatedAssumptions.map(item => <li key={item.eventId}>{item.reason}</li>)}</PagedList></Details>}
    </section>
    {!!undated.length && <section className="money-panel" aria-label="Spending dates to check"><h2>Spending needs a date</h2>
      <p className="money-meta">Confirm a payment date to check whether an item can be changed. Leave it unknown if you’re unsure.</p>
      <PagedList label="Spending dates to check" className="money-checks" pageSize={6}>{undated.map(record => <li key={record.id}>
        <h3>{record.label}</h3><p>{amountLabel(record.amount)} · Date unknown</p>
        <button disabled={locked} onClick={() => onEdit({ recordId: record.id, field: 'schedule.date' })}>Check date for {record.label}</button>
      </li>)}</PagedList>
    </section>}
    {pending && <p role="status" className="changes-pending">Waiting for confirmation. Your entries are kept; don’t submit another change yet.</p>}
    {snapshot.preview && !custom && <section className="money-panel"><ProposalReview {...{ snapshot, active, onCommand }} locked={locked} /></section>}
    {!custom && <section className="money-panel" aria-label="Suggested plan changes"><div className="money-section-head"><h2>Changes to consider</h2>
      <button disabled={locked} onClick={() => setCustom(true)}><MoneyIcon name="add" />Choose payments</button></div>
      {!choices.length && <div className="changes-empty"><h3>No suggested changes</h3><p className="money-meta">You can still check which payments are eligible, or keep your plan as it is.</p></div>}
      {choices.length > 0 && <PagedList label="Suggested changes" className="money-choice-cards" pageSize={4}>{choices.map(choice => <li key={choice.id}>
        {choice.adjustmentAmounts.map(item => {
          const event = plan.events.find(event => event.id === item.eventId);
          return <div key={item.eventId}><div className="money-section-head"><h3>{event?.label ?? 'Planned payment'}</h3>{event && <span className="money-meta">{dateLabel(event.date)}</span>}</div><p><strong>{money(item.amountPaise)}</strong> · Proposed{event?.kind === 'debt' && ' · includes minimum'}</p></div>;
        })}
        <p className="money-meta">Not saved{snapshot.accepted && ' · replaces saved changes'}</p>
        <p>First shortfall after change: {choice.metrics?.firstGap ? <><strong>{money(choice.metrics.firstGap.amountPaise)}</strong> · {dateLabel(choice.metrics.firstGap.date)}</> : choice.metrics?.closingPaise != null ? 'None in dated figures' : 'Unknown until compared'}</p>
        {choice.laterOnly && <p className="money-warning">Later spending only · does not cover the earlier gap.</p>}
        <button disabled={locked || !!snapshot.preview || !choice.adjustmentAmounts.length} onClick={() => onCommand({ type: 'previewAdjustments', adjustments: choice.adjustmentAmounts.map(item => ({ eventId: item.eventId, amount: decimal(item.amountPaise) })) })}>Compare</button>
      </li>)}</PagedList>}
    </section>}
    {custom && <button className="quiet changes-back" disabled={locked} aria-label="Back to suggested changes" onClick={() => setCustom(false)}><MoneyIcon name="back" />Suggestions</button>}
    <Comparison snapshot={snapshot} settings={settings} active={active && custom} locked={blocked} pending={pending} onCommand={onCommand} />
  </div>;
}