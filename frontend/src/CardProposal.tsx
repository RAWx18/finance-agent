// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import type { Command, Plan, Snapshot } from './api';
import { cardDate, cardMoney } from './cardFields';

/** Distinguishes a plan's first timing exposure from an unfunded shortfall. */
function gapLabel(plan: Plan): string {
  const gap = plan.firstGap;
  if (!gap) return plan.closingPaise === null ? 'Unknown' : 'None in known items';
  const timing = plan.timingRisks?.find(item => item.date === gap.date);
  const label = `${timing ? 'Timing exposure' : 'Funding shortfall'} · ${cardMoney(gap.amountPaise)} · ${cardDate(gap.date)}`;
  if (!timing) return label;
  return `${label} · Needed before same-day income. ${timing.remainingGapPaise === 0 ? 'No remaining gap after included income; payment timing is not guaranteed.' : `${cardMoney(timing.remainingGapPaise)} still unfunded after included income.`}`;
}

/** Presents planning changes and consent controls in a financial card. */
export function CardProposal({ snapshot, active, blocked, onCommand }: {
  snapshot: Snapshot; active: boolean; blocked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>;
}) {
  const preview = snapshot.preview;
  const scenario = preview ?? snapshot.accepted;
  const id = useId();
  // Consent must be renewed when the proposal, snapshot, or ability to act changes.
  const key = JSON.stringify([snapshot.sessionId, snapshot.revision, snapshot.sequence, preview, active, blocked]);
  const [review, setReview] = useState({ key, expanded: false, checked: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (review.key !== key) setReview({ key, expanded: false, checked: false });
  const removals = preview?.removedAssumptionIds ?? [];
  const total = (scenario?.adjustments.length ?? 0) + removals.length;
  const expanded = review.key === key && review.expanded;
  const shown = expanded ? total : 2;
  const disabled = blocked || !active || saving || !!preview && preview.sourceRevision !== snapshot.revision;
  const ready = !!preview && preview.adjustments.every(item => item.acceptanceReady)
    && removals.every(id => snapshot.accepted?.adjustments.some(item => item.eventId === id));
  const canAccept = ready && !disabled && review.key === key && review.checked && (total <= 2 || expanded);
  /** Submits an eligible proposal decision and reports an unconfirmed result. */
  async function decide(type: 'acceptPreview' | 'rejectPreview' | 'discardPreview') {
    if (!preview || disabled || type === 'acceptPreview' && !canAccept) return;
    setSaving(true); setError(''); setReview({ ...review, checked: false });
    const saved = await onCommand(type === 'acceptPreview' ? { type, previewId: preview.id, confirmed: true, consentScope: 'unconditional' } : { type, previewId: preview.id }).catch(() => undefined);
    setSaving(false);
    if (!saved || saved.preview?.id === preview.id) setError('Decision not confirmed. Check the save status before retrying.');
  }
  return <div className="card-proposal">
    {scenario && <>
      <span className="card-badge">{preview ? 'Preview · not saved' : 'Saved assumptions · not paid'}</span>
      <ul id={id} className="card-plan-changes" aria-label="Planning changes">
        {scenario.adjustments.slice(0, shown).map(item => <li key={item.eventId}>
          <div className="card-change-heading"><strong>{item.label}</strong><span className="card-meta">{cardDate(item.date)}</span></div>
          <p><span>{cardMoney(item.originalPaise)} <span className="card-meta">Reported</span></span><span aria-hidden="true"> → </span><span className="sr-only"> to </span><strong>{cardMoney(item.amountPaise)}</strong> <span className="card-meta">{preview ? 'Proposed' : 'Saved'}</span></p>
          {item.kind === 'card' && <span className="card-meta">Includes minimum {cardMoney(item.minimumPaise)} · Not payoff</span>}
          {!item.acceptanceReady && <span className="card-meta card-caution">Changeability unconfirmed</span>}
        </li>)}
        {removals.slice(0, Math.max(0, shown - scenario.adjustments.length)).map(eventId => {
          const item = snapshot.accepted?.adjustments.find(item => item.eventId === eventId);
          return <li key={`remove:${eventId}`}>{item ? <><div className="card-change-heading"><strong>{item.label}</strong><span className="card-meta">{cardDate(item.date)}</span></div>
            <p>{cardMoney(item.amountPaise)} Saved → <strong>{cardMoney(item.originalPaise)}</strong> Reported</p><span className="card-meta">Remove saved assumption</span></> : <span className="card-caution">Removal details unavailable · cannot consent</span>}</li>;
        })}
      </ul>
      {total > 2 && <button className="card-expand" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setReview({ key, expanded: !expanded, checked: false })}>{expanded ? 'Show fewer changes' : `Show ${total - 2} more changes`}</button>}
    </>}
    {preview && <>
      <div className="card-impact" aria-label="First shortfall impact"><span className="card-caption">First shortfall · Calculated</span><p>{gapLabel(snapshot.accepted?.plan ?? snapshot.plan)} <span aria-hidden="true">→</span><span className="sr-only"> to </span> <strong>{gapLabel(preview.plan)}</strong></p></div>
      {preview.sourceRevision !== snapshot.revision && <p className="card-field-error" role="alert">Figures changed. Ask Isha for a fresh proposal.</p>}
      {!ready && <p className="card-meta card-caution">Confirm the missing terms, then ask Isha for a fresh proposal.</p>}
      {snapshot.accepted && <p className="card-meta">Replaces saved assumptions, including removals.</p>}
      <label className="card-consent"><input type="checkbox" checked={review.key === key && review.checked} disabled={disabled || !ready || total > 2 && !expanded}
        onChange={event => setReview({ ...review, key, checked: event.target.checked })} />I agree to all amounts and removals shown, unconditionally—not dependent on uncertain income or payee agreement.</label>
      <p className="card-meta">Whole proposal · Dates unchanged · No payment made</p>
      <div className="card-proposal-actions"><button type="button" className="card-save" disabled={!canAccept} onClick={() => void decide('acceptPreview')}>Accept planning assumptions</button>
        <button type="button" disabled={disabled} onClick={() => void decide('rejectPreview')}>Reject preview</button><button type="button" disabled={disabled} onClick={() => void decide('discardPreview')}>Close preview</button></div>
      <p className="card-meta">Reject saves a refusal. Close only puts the preview aside.</p>
    </>}
    {!!snapshot.invalidatedAssumptions?.length && <div className="card-invalidated"><span className="card-badge" data-tone="caution">Needs fresh consent</span><ul>{snapshot.invalidatedAssumptions.map(item => {
      const event = snapshot.plan.events.find(event => event.id === item.eventId);
      return <li key={item.eventId}><strong>{event?.label ?? 'Planning change'}</strong>{event && <> · {cardDate(event.date)}</>}<span className="card-meta">No longer applied</span></li>;
    })}</ul></div>}
    {error && <p role="alert" className="card-field-error">{error}</p>}
  </div>;
}