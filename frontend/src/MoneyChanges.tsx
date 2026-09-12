// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { Command, Settings, Snapshot } from './api';
import { Assumptions, ProposalReview, RestoreReported } from './ScenarioDetails';
import { Comparison } from './Comparison';
import { Details } from './Dialog';
import { PagedList } from './PagedList';
import { dateLabel, decimal, money } from './money';
import { MoneyIcon } from './MoneyIcon';

export function MoneyChanges({ snapshot, settings, active, blocked, pending, onCommand }: {
  snapshot: Snapshot; settings: Settings; active: boolean; blocked: boolean; pending: boolean;
  onCommand: (operation: Command['operation']) => void;
}) {
  const [custom, setCustom] = useState(false);
  const plan = snapshot.accepted?.plan ?? snapshot.plan;
  const choices = snapshot.workspace?.choices?.filter(choice => choice.kind !== 'enquire') ?? [];
  const locked = blocked || pending || !active;
  return <div className="money-changes">
    <section className="money-panel" aria-label="Current planning changes"><h2>{snapshot.accepted ? 'Saved in your plan' : 'Your reported plan is active'}</h2>
      <p className="money-meta">{snapshot.accepted ? `${snapshot.accepted.adjustments.length} saved changes · not payments or provider agreements.` : 'Compare first. Nothing changes until you explicitly save.'}</p>
      {snapshot.accepted && <Assumptions scenario={snapshot.accepted} />}
      {!custom && <RestoreReported {...{ snapshot, active, onCommand }} locked={locked} />}
      {!!snapshot.invalidatedAssumptions?.length && <Details label={`${snapshot.invalidatedAssumptions.length} changes need fresh consent`}><p>These changes are no longer included. Unaffected saved changes remain.</p><PagedList label="Changes needing consent" className="money-checks" pageSize={6}>{snapshot.invalidatedAssumptions.map(item => <li key={item.eventId}>{item.reason}</li>)}</PagedList></Details>}
    </section>
    {pending && <p role="status" className="money-meta">A change is awaiting confirmation. Keep the current proposal until the action finishes or is retried.</p>}
    {snapshot.preview && !custom && <section className="money-panel"><ProposalReview {...{ snapshot, active, onCommand }} locked={locked} /></section>}
    {!custom && <section className="money-panel" aria-label="Suggested plan changes"><div className="money-section-head"><h2>Changes to consider</h2>
      <button className="icon-button" disabled={locked} aria-label="Choose custom changes" title="Choose custom changes" onClick={() => setCustom(true)}><MoneyIcon name="add" /></button></div>
      {!choices.length && <div className="money-empty"><h3>No suggested changes</h3><p>No reductions are offered in this assessment. Check eligible custom choices, or keep your current plan.</p></div>}
      {choices.length > 0 && <PagedList label="Suggested changes" className="money-choice-cards" pageSize={4}>{choices.map(choice => <li key={choice.id}>
        {choice.adjustmentAmounts.map(item => {
          const event = plan.events.find(event => event.id === item.eventId);
          return <div key={item.eventId}><div className="money-section-head"><h3>{event?.label ?? 'Planned payment'}</h3>{event && <span className="money-meta">{dateLabel(event.date)}</span>}</div><p><strong>{money(item.amountPaise)}</strong> · Proposed{event?.kind === 'debt' && ' · includes minimum'}</p></div>;
        })}
        <p className="money-meta">Not saved{snapshot.accepted && ' · comparison proposes a replacement set'}</p>
        <p>Remaining first gap · Calculated: {choice.metrics?.firstGap ? <><strong>{money(choice.metrics.firstGap.amountPaise)}</strong> · {dateLabel(choice.metrics.firstGap.date)}</> : choice.metrics?.closingPaise != null ? 'None in dated figures' : 'Unknown until compared'}</p>
        {choice.laterOnly && <p className="money-warning">Later spending only · does not cover the earlier gap.</p>}
        <button disabled={locked || !!snapshot.preview || !choice.adjustmentAmounts.length} onClick={() => onCommand({ type: 'previewAdjustments', adjustments: choice.adjustmentAmounts.map(item => ({ eventId: item.eventId, amount: decimal(item.amountPaise) })) })}>Compare</button>
      </li>)}</PagedList>}
    </section>}
    {custom && <><button className="icon-button" aria-label="Back to suggested changes" title="Back to suggested changes" onClick={() => setCustom(false)}><MoneyIcon name="back" /></button><Comparison snapshot={snapshot} settings={settings} active={active} locked={blocked} pending={pending} onCommand={onCommand} /></>}
  </div>;
}