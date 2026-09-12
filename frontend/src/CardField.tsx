// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Command, Snapshot } from './api';
import { cardDate, cardStatus, conflictDraft, fieldConflict, fieldDraft, fieldError, fieldOperation, fieldSaved, sourceAmount } from './cardFields';
import type { CardDraft, CardTarget } from './cardFields';

/** Highlights a displayed value when it changes, respecting reduced-motion preferences. */
export function ChangedValue({ value }: { value: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    if (!element.current?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const animation = element.current.animate([{ backgroundColor: '#dceee3' }, { backgroundColor: 'transparent' }], { duration: 900, easing: 'ease-out' });
    return () => animation.cancel();
  }, [value]);
  return <span ref={element}>{value}</span>;
}

/** Provides inline correction and conflict resolution for a financial card field. */
export function CardField({ snapshot, target, label, blocked, onCommand, onEditingChange, children, className = '' }: {
  snapshot: Snapshot; target: CardTarget; label: string; blocked: boolean;
  onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>; children: ReactNode; className?: string;
  onEditingChange?: (id: string, open: boolean, saved?: Snapshot) => void;
}) {
  const id = useId();
  const [edit, setEdit] = useState<{ draft: CardDraft; revision: number; sessionId: string; identity: string; timing?: 'replace' | 'remove' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const choice = useRef<HTMLSelectElement>(null);
  const restore = useRef(false);
  const latest = useRef(snapshot);
  useEffect(() => { latest.current = snapshot; }, [snapshot]);
  const open = edit !== null;
  useEffect(() => {
    if (!open) return;
    onEditingChange?.(id, true);
    return () => onEditingChange?.(id, false);
  }, [id, onEditingChange, open]);
  useEffect(() => {
    if (open) (choice.current ?? input.current)?.focus({ preventScroll: true });
    else if (restore.current) { restore.current = false; trigger.current?.focus({ preventScroll: true }); }
  }, [open]);
  const identity = JSON.stringify(target);
  const conflict = fieldConflict(snapshot, target);
  const pattern = target.field === 'schedule.date' && !conflict ? snapshot.facts.records.find(record => record.id === target.recordId)?.schedule.pattern : null;
  const outdated = !!edit && (edit.sessionId !== snapshot.sessionId || edit.revision !== snapshot.revision || edit.identity !== identity);
  const disabled = blocked || saving || outdated;
  const date = target.field === 'schedule.date' || target.term === 'rateDate';
  const text = target.field === 'label';
  /** Cancels an idle correction and restores focus to its trigger. */
  const close = () => { if (!saving) { restore.current = true; setEdit(null); setError(''); } };
  /** Revises the open correction and clears its validation error. */
  function update(draft: CardDraft) { if (edit) { setEdit({ ...edit, draft }); setError(''); } }
  /** Submits a valid correction and closes the editor only after a matching save. */
  async function save() {
    if (!edit || disabled || pattern && !edit.timing) return;
    const error = fieldError(edit.draft, target, !!conflict);
    if (error) { setError(error); return; }
    const operation = fieldOperation(snapshot, target, edit.draft);
    setSaving(true); setError('');
    const saved = await onCommand(operation).catch(() => undefined);
    setSaving(false);
    // A matching save can still be stale if a newer snapshot arrived while the request was in flight.
    if (saved && saved.sessionId === edit.sessionId && latest.current.sessionId === edit.sessionId && saved.revision > edit.revision
      && saved.revision >= latest.current.revision && saved.sequence >= latest.current.sequence && fieldSaved(saved, target, operation)) {
      restore.current = true; setEdit(null);
      onEditingChange?.(id, false, saved);
    } else setError('Save not confirmed. Your entry is kept; check the save status before retrying.');
  }
  const inputLabel = !date && !text && !target.term && edit?.draft.source?.conversion ? `${label} (${edit.draft.source.conversion.currency})` : label;
  return <div className={`card-field ${className}`}>
    <button ref={trigger} type="button" className="card-field-value" hidden={open} aria-label={`${conflict ? 'Resolve' : 'Edit'} ${label}`} aria-disabled={blocked} onClick={() => {
      if (blocked) return;
      setEdit({ draft: fieldDraft(snapshot, target), revision: snapshot.revision, sessionId: snapshot.sessionId, identity }); setError('');
    }}>{children}<span aria-hidden="true" className="card-edit-mark">{conflict ? 'Resolve' : '✎'}</span></button>
    {conflict && !open && <span className="card-meta card-alternatives">{conflict.values.map(value => `${value.date ? cardDate(value.date) : sourceAmount(conflictDraft(value).source!)} · ${cardStatus[value.status]}`).join(' / ')}</span>}
    {edit && <form aria-label={`${conflict ? 'Resolve' : 'Edit'} ${label}`} className="card-field-editor" onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      {pattern && <>
        <p className="card-meta">Current pattern: {pattern.kind === 'monthEnd' ? 'month-end' : `monthly day ${pattern.day}`}. Calculated dates are not reported dates.</p>
        <label className="card-certainty-label">Change timing<select ref={choice} aria-label={`${label} timing change`} value={edit.timing ?? ''} disabled={disabled} onChange={event => {
          const timing = event.target.value as 'replace' | 'remove' | '';
          setEdit({ ...edit, timing: timing || undefined, draft: { ...edit.draft, value: '', status: timing === 'replace' ? 'exact' : 'unknown' } }); setError('');
        }}><option value="">Keep current pattern</option><option value="replace">Replace pattern with a monthly start date</option><option value="remove">Remove pattern; leave timing unknown</option></select></label>
        {edit.timing && <p className="card-meta">{edit.timing === 'replace' ? 'This replaces the pattern for the whole series, not one occurrence. Future payments repeat on the entered day of month; unavailable month days are not moved automatically.' : 'This removes calculated dates for the whole series. The known amount remains in the payments-without-dates comparison.'}</p>}
      </>}
      {conflict && <label className="card-conflict-choice">Resolve {label}<select ref={choice} value={edit.draft.alternative} disabled={disabled} onChange={event => {
        const value = conflict.values.find(value => value.id === event.target.value);
        update(value ? conflictDraft(value) : { ...fieldDraft(snapshot, target),
          source: conflict.values.find(value => value.source?.conversion)?.source ?? edit.draft.source,
          value: '', status: 'exact', alternative: event.target.value });
      }}><option value="">Choose a report</option>{conflict.values.map((value, index) => <option key={value.id} value={value.id}>
        Report {index + 1}: {value.date ? cardDate(value.date) : sourceAmount(conflictDraft(value).source!)} · {cardStatus[value.status]}
      </option>)}<option value="custom">Enter correct value</option></select></label>}
      {(!conflict || edit.draft.alternative) && (!pattern || edit.timing === 'replace') && <>
        <label className="card-input-label" htmlFor={id}>{inputLabel}<input ref={input} id={id} type={date ? 'date' : 'text'} inputMode={!date && !text ? 'decimal' : undefined}
          value={edit.draft.value} disabled={disabled || edit.draft.status === 'unknown' || !!conflict && edit.draft.alternative !== 'custom'}
          maxLength={text ? 120 : undefined} aria-invalid={!!error} aria-describedby={error || outdated ? `${id}-error` : undefined}
          onChange={event => update({ ...edit.draft, value: event.target.value })} /></label>
        {!text && target.field !== 'reserve' && <label className="card-certainty-label">Certainty<select aria-label={`${label} certainty`} value={edit.draft.status}
          disabled={disabled || !!conflict && edit.draft.alternative !== 'custom'} onChange={event => {
            const status = event.target.value as CardDraft['status'];
            update({ ...edit.draft, status, value: status === 'unknown' ? '' : edit.draft.value });
          }}><option value="exact">Exact</option>{target.term !== 'rateDate' && <option value="estimate">Estimate</option>}{!conflict && !pattern && <option value="unknown">Unknown</option>}</select></label>}
      </>}
      <div className="card-field-actions"><button type="submit" className="card-save" aria-label={`Save ${label}`} disabled={disabled || !!conflict && !edit.draft.alternative || !!pattern && !edit.timing}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" aria-label={`Cancel ${label}`} disabled={saving} onClick={close}>Cancel</button></div>
      {(outdated || error) && <p id={`${id}-error`} className="card-field-error" role="alert">{outdated ? 'Saved figures changed. Cancel to check the latest value; your entry is kept.' : error}</p>}
    </form>}
  </div>;
}