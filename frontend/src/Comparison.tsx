// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AdjustmentOptions, Command, Settings, Snapshot } from './api';
import { dateLabel, decimal, money, parseAmount } from './money';
import { PagedList } from './PagedList';
import { ProposalReview, RestoreReported } from './ScenarioDetails';
import { Dialog } from './Dialog';
import { dismiss, notify } from './Toast';
import { MoneyIcon } from './MoneyIcon';

type Choice = AdjustmentOptions['options'][number] & { amount: string };

/** Supports selecting spending reductions and reviewing their combined preview. */
export function Comparison({ snapshot, settings, active, locked, pending, onCommand }: {
  snapshot: Snapshot; settings: Settings; active: boolean; locked: boolean;
  pending: boolean; onCommand: (operation: Command['operation']) => void;
}) {
  const [initialized, setInitialized] = useState(active);
  const [selecting, setSelecting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value?: AdjustmentOptions; error?: string } | null>(null);
  const [choices, setChoices] = useState<Choice[]>(() => snapshot.accepted?.adjustments.map(item => ({ ...item, amount: decimal(item.amountPaise) })) ?? []);
  const [choiceRevision, setChoiceRevision] = useState(snapshot.revision);
  const [eventId, setEventId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(!snapshot.preview);
  const errorRef = useRef<HTMLDivElement>(null);
  const key = `${snapshot.sessionId}:${snapshot.revision}:${refresh}`;
  const options = result?.key === key ? result.value : undefined;
  const loadError = result?.key === key ? result.error : undefined;
  const option = options?.options.find((item) => item.eventId === eventId);
  const staleChoices = choices.length > 0 && choiceRevision !== snapshot.revision;
  const preview = snapshot.preview;
  const blocked = !active || locked || pending;

  if (active && !initialized) {
    setInitialized(true);
    setChoices(snapshot.accepted?.adjustments.map(item => ({ ...item, amount: decimal(item.amountPaise) })) ?? []);
    setChoiceRevision(snapshot.revision);
    setEditing(!snapshot.preview);
  }

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api.options(controller.signal).then((value) => {
      if (!controller.signal.aborted) setResult(value.revision === snapshot.revision ? { key, value }
        : { key, error: 'Your figures changed. Refresh choices to try again.' });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ key, error: 'Choices could not be loaded. Your selections are kept. Try again.' });
    });
    return () => controller.abort();
  }, [active, key, snapshot.revision]);

  useEffect(() => {
    let current = true;
    if (active && loadError) notify({ id: 'choices:load', title: 'Spending choices unavailable', message: loadError,
      severity: 'error', duration: null, action: { label: 'Retry', disabled: blocked, onClick: () => {
        if (!current || blocked) return;
        current = false;
        setRefresh(value => value + 1);
      } } });
    else dismiss('choices:load');
    return () => { current = false; dismiss('choices:load'); };
  }, [active, loadError, blocked]);

  /** Presents a validation message and directs focus to it. */
  function fail(message: string) {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  /** Adds a valid payment reduction to the selected changes. */
  function addChoice() {
    if (blocked || staleChoices || !options) return;
    if (!option) return fail('Choose a payment or expense.');
    const parsed = parseAmount(amount, settings.maxMoneyPaise);
    if (parsed === null) return fail('Enter an exact amount with up to two decimal places, without commas or signs.');
    if (parsed < BigInt(option.minimumPaise) || parsed >= BigInt(option.originalPaise)) return fail(`Enter at least ${money(option.minimumPaise)} and less than ${money(option.originalPaise)}.`);
    setChoices([...choices.filter((item) => item.eventId !== eventId), { ...option, amount }]);
    setChoiceRevision(snapshot.revision);
    setEventId(''); setAmount(''); setError('');
    setSelecting(false);
  }

  /** Requests a preview when all selected changes remain valid. */
  function previewChoices() {
    if (blocked) return;
    if (staleChoices || !options) return fail('Review refreshed choices before previewing.');
    if (eventId) {
      setSelecting(true);
      return fail('Add this change or cancel the selection first.');
    }
    if (!choices.length) return fail('Add at least one change to preview.');
    for (const choice of choices) {
      const current = options.options.find((item) => item.eventId === choice.eventId);
      const parsed = parseAmount(choice.amount, settings.maxMoneyPaise);
      if (!current || current.originalPaise !== choice.originalPaise || current.minimumPaise !== choice.minimumPaise || current.date !== choice.date
        || current.dependencyKey !== choice.dependencyKey || parsed === null || parsed < BigInt(current.minimumPaise) || parsed >= BigInt(current.originalPaise)) {
        return fail('A selected payment or expense needs review. Remove it and select it again.');
      }
    }
    setError(''); setEditing(false);
    onCommand({ type: 'previewAdjustments', adjustments: choices.map((choice) => ({ eventId: choice.eventId, amount: choice.amount })) });
  }

  const errorNotice = error && <div className="notice warning" role="alert" tabIndex={-1} ref={errorRef}><p>{error}</p></div>;

  return <section className="money-panel money-custom-changes no-print" aria-labelledby="compare-heading" hidden={!active}>
    <div className="money-section-head"><h2 id="compare-heading">Custom changes</h2>
      <button type="button" className="icon-button" disabled={blocked} aria-label="Refresh choices" title="Refresh choices" onClick={() => setRefresh(value => value + 1)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg></button></div>
    <p className="money-meta">Choose payments, set proposed amounts, then compare. Nothing is saved yet.</p>
    {locked && !pending && <p className="hint">Finish any open correction and wait for live updates before comparing.</p>}
    <RestoreReported {...{ snapshot, active, onCommand }} locked={blocked} />
    {!loadError && !options && <p role="status">Loading choices…</p>}
    {loadError && <p className="money-warning">Choices unavailable. Your selections are kept; refresh to retry.</p>}
    {options && !options.options.length && <p className="notice">No eligible spending changes are available. Essentials, loans, automatic debits and uncertain amounts cannot be reduced here.</p>}
    {!selecting && errorNotice}
    {staleChoices && <div className="notice warning"><p>Your figures changed. Check your selections; reselect any payment or expense whose amount or terms changed.</p>
      <button type="button" disabled={blocked || !options} onClick={() => {
        setChoiceRevision(snapshot.revision); setEditing(true);
      }}>Review refreshed choices</button></div>}
    {(editing || !preview) && <fieldset disabled={blocked || !options || staleChoices} className="choice-editor">
      <legend>Selected changes</legend>
      {snapshot.accepted && <p className="hint">Your next preview replaces the saved set. Removing a change restores that item’s original amount.</p>}
      <button type="button" className="icon-button" aria-label="Add a change" title="Add a change" aria-haspopup="dialog" disabled={!options?.options.length} onClick={() => setSelecting(true)}><MoneyIcon name="add" /></button>
      {!choices.length && <p className="money-meta">No selections. Add an eligible payment to compare.</p>}
      {!!choices.length && <PagedList className="money-choice-cards" label="Selected changes" pageSize={6}>
        {choices.map((choice) => <li key={choice.eventId}><div className="money-section-head"><h3>{choice.label}</h3><span className="money-meta">{dateLabel(choice.date)}</span></div>
          <p>{money(choice.originalPaise)} Reported → <strong>₹{choice.amount} Proposed</strong>{choice.kind === 'card' && ' · includes minimum'}</p>
          <p className="money-meta">Not saved{!choice.acceptanceReady ? ' · Changeability not confirmed' : ''}</p>
          <div className="money-row-actions"><button type="button" className="icon-button" aria-label={`Edit ${choice.label}`} title={`Edit ${choice.label}`} aria-haspopup="dialog" onClick={() => { setEventId(choice.eventId); setAmount(choice.amount); setError(''); setSelecting(true); }}><MoneyIcon name="edit" /></button>
            <button type="button" className="icon-button" aria-label={`Remove ${choice.label}`} title={`Remove ${choice.label}`} onClick={() => setChoices(choices.filter((item) => item.eventId !== choice.eventId))}><MoneyIcon name="remove" /></button></div>
        </li>)}
      </PagedList>}
      <button type="button" className="primary" onClick={previewChoices}>Preview selected changes</button>
    </fieldset>}
    {preview && <div className="actions"><button type="button" className="icon-button" disabled={blocked} aria-label={editing ? 'Review current preview' : 'Edit selections'} title={editing ? 'Review current preview' : 'Edit selections'} onClick={() => setEditing(!editing)}>
      <MoneyIcon name={editing ? 'back' : 'edit'} /></button></div>}
    <ProposalReview key={refresh} snapshot={snapshot} active={active && !editing} locked={blocked || staleChoices} onCommand={onCommand} />
    <Dialog open={active && selecting} title="Choose a spending change" onClose={() => { setSelecting(false); setError(''); }}>
      {selecting && errorNotice}
      <fieldset disabled={blocked || !options || staleChoices} className="choice-editor">
        <legend className="sr-only">Change details</legend>
        <label>Payment or expense<select id="occurrence" value={eventId} onChange={(event) => { setEventId(event.target.value); setAmount(''); setError(''); }}>
          <option value="">Choose a payment or expense</option>
          {options?.options.map((item) => <option key={item.eventId} value={item.eventId}>{item.label} · {dateLabel(item.date)} · {money(item.originalPaise)}</option>)}
        </select></label>
        {eventId && <>
          <label>Planned amount (₹)<input id="change-amount" inputMode="decimal" value={amount} aria-invalid={!!error} aria-describedby="change-guidance" onChange={(event) => setAmount(event.target.value)} /></label>
          <p className="hint" id="change-guidance">{option ? <>At least {money(option.minimumPaise)} and less than {money(option.originalPaise)}. Only {dateLabel(option.date)} changes.</> : 'This payment or expense is no longer eligible. Cancel this selection and choose another.'}</p>
          {option?.kind === 'card' && <p className="notice warning">The required minimum is not payoff. Interest and fees may apply; outstanding debt stays unchanged.</p>}
          {option && !option.acceptanceReady && <p className="notice">You can preview while unsure. To save a reduction, edit this item in Money and confirm “Can this spending change?” first.</p>}
          <div className="actions"><button type="button" onClick={addChoice}>Add to preview</button><button type="button" onClick={() => { setEventId(''); setAmount(''); setError(''); setSelecting(false); }}>Cancel selection</button></div>
        </>}
      </fieldset>
    </Dialog>
  </section>;
}