// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Command, Snapshot } from './api';
import { cardDate, cardStatus, conflictDraft, fieldConflict, fieldDraft, fieldError, fieldOperation, fieldSaved, sourceAmount } from './cardFields';
import type { CardDraft, CardTarget } from './cardFields';

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

export function CardField({ snapshot, target, label, blocked, onCommand, children, className = '' }: {
  snapshot: Snapshot; target: CardTarget; label: string; blocked: boolean;
  onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>; children: ReactNode; className?: string;
}) {
  const id = useId();
  const [edit, setEdit] = useState<{ draft: CardDraft; revision: number; sessionId: string; identity: string } | null>(null);
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
    if (open) (choice.current ?? input.current)?.focus({ preventScroll: true });
    else if (restore.current) { restore.current = false; trigger.current?.focus({ preventScroll: true }); }
  }, [open]);
  const identity = JSON.stringify(target);
  const conflict = fieldConflict(snapshot, target);
  const outdated = !!edit && (edit.sessionId !== snapshot.sessionId || edit.revision !== snapshot.revision || edit.identity !== identity);
  const disabled = blocked || saving || outdated;
  const date = target.field === 'schedule.date' || target.term === 'rateDate';
  const text = target.field === 'label';
  const close = () => { if (!saving) { restore.current = true; setEdit(null); setError(''); } };
  function update(draft: CardDraft) { if (edit) { setEdit({ ...edit, draft }); setError(''); } }
  async function save() {
    if (!edit || disabled) return;
    const error = fieldError(edit.draft, target, !!conflict);
    if (error) { setError(error); return; }
    const operation = fieldOperation(snapshot, target, edit.draft);
    setSaving(true); setError('');
    const saved = await onCommand(operation).catch(() => undefined);
    setSaving(false);
    if (saved && saved.sessionId === edit.sessionId && latest.current.sessionId === edit.sessionId && saved.revision > edit.revision
      && saved.revision >= latest.current.revision && saved.sequence >= latest.current.sequence && fieldSaved(saved, target, operation)) {
      restore.current = true; setEdit(null);
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
      {conflict && <label className="card-conflict-choice">Resolve {label}<select ref={choice} value={edit.draft.alternative} disabled={disabled} onChange={event => {
        const value = conflict.values.find(value => value.id === event.target.value);
        update(value ? conflictDraft(value) : { ...fieldDraft(snapshot, target),
          source: conflict.values.find(value => value.source?.conversion)?.source ?? edit.draft.source,
          value: '', status: 'exact', alternative: event.target.value });
      }}><option value="">Choose a report</option>{conflict.values.map((value, index) => <option key={value.id} value={value.id}>
        Report {index + 1}: {value.date ? cardDate(value.date) : sourceAmount(conflictDraft(value).source!)} · {cardStatus[value.status]}
      </option>)}<option value="custom">Enter correct value</option></select></label>}
      {(!conflict || edit.draft.alternative) && <>
        <label className="card-input-label" htmlFor={id}>{inputLabel}<input ref={input} id={id} type={date ? 'date' : 'text'} inputMode={!date && !text ? 'decimal' : undefined}
          value={edit.draft.value} disabled={disabled || edit.draft.status === 'unknown' || !!conflict && edit.draft.alternative !== 'custom'}
          maxLength={text ? 120 : undefined} aria-invalid={!!error} aria-describedby={error || outdated ? `${id}-error` : undefined}
          onChange={event => update({ ...edit.draft, value: event.target.value })} /></label>
        {!text && target.field !== 'reserve' && <label className="card-certainty-label">Certainty<select aria-label={`${label} certainty`} value={edit.draft.status}
          disabled={disabled || !!conflict && edit.draft.alternative !== 'custom'} onChange={event => {
            const status = event.target.value as CardDraft['status'];
            update({ ...edit.draft, status, value: status === 'unknown' ? '' : edit.draft.value });
          }}><option value="exact">Exact</option>{target.term !== 'rateDate' && <option value="estimate">Estimate</option>}{!conflict && <option value="unknown">Unknown</option>}</select></label>}
      </>}
      <div className="card-field-actions"><button type="submit" className="card-save" aria-label={`Save ${label}`} disabled={disabled || !!conflict && !edit.draft.alternative}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" aria-label={`Cancel ${label}`} disabled={saving} onClick={close}>Cancel</button></div>
      {(outdated || error) && <p id={`${id}-error`} className="card-field-error" role="alert">{outdated ? 'Saved figures changed. Cancel to check the latest value; your entry is kept.' : error}</p>}
    </form>}
  </div>;
}