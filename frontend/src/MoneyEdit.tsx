// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { Command, Snapshot } from './api';
import type { components } from './contracts';
import type { State } from './session';
import { Dialog } from './Dialog';
import { dateLabel, decimal, parseAmount } from './money';

type Field = 'opening' | 'reserve' | 'amount' | 'target' | 'outstanding' | 'schedule.date' | 'reliability' | 'controllability' | 'label' | 'recurrence' | 'autoDebit' | 'debtType' | 'delete' | 'add' | 'coverage';
export type EditTarget = { recordId?: string; kind?: 'income' | 'essential' | 'optional' | 'debt'; field: Field };
const labels: Record<Field, string> = { opening: 'Cash at plan start', reserve: 'Cash to keep aside', amount: 'Amount', target: 'Intended payment · includes minimum', outstanding: 'Outstanding balance', 'schedule.date': 'Date', reliability: 'Receipt reliability', controllability: 'Can this spending change?', label: 'Name', recurrence: 'Repeats', autoDebit: 'Automatic debit', debtType: 'Debt type', delete: 'Remove item', add: 'Add item', coverage: 'Review category' };

export function MoneyEdit({ target, snapshot, state, active, onClose, onCommand, onRetry }: {
  target: EditTarget; snapshot: Snapshot; state: State; active: boolean; onClose: () => void;
  onCommand: (operation: Command['operation']) => void; onRetry: () => void;
}) {
  const [revision] = useState(snapshot.revision);
  const record = snapshot.facts.records.find(item => item.id === target.recordId);
  const [field, setField] = useState(target.field);
  function read(field: Field) {
    if (field === 'reserve') return { value: decimal(snapshot.facts.reservePaise), status: 'exact' };
    const amount = field === 'opening' ? snapshot.facts.opening : record?.[field as 'amount' | 'target' | 'outstanding'];
    if (['opening', 'amount', 'target', 'outstanding'].includes(field)) return { value: amount?.amountPaise == null ? '' : decimal(amount.amountPaise), status: amount?.status ?? 'absent' };
    if (field === 'schedule.date') return { value: record?.schedule.date ?? '', status: record?.schedule.certainty ?? 'unknown' };
    return { value: field === 'coverage' ? snapshot.facts.coverage[target.kind!] ?? 'notDiscussed' : field === 'recurrence' ? record?.schedule.recurrence ?? 'once'
      : field === 'autoDebit' ? String(record?.autoDebit ?? false) : field === 'add' ? '' : String(record?.[field as 'label' | 'debtType' | 'reliability' | 'controllability'] ?? 'unknown'), status: 'exact' };
  }
  const [initial, setInitial] = useState(() => read(target.field));
  const [input, setInput] = useState(initial);
  const [kind, setKind] = useState(target.kind ?? 'essential');
  const [error, setError] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const changed = input.value !== initial.value || input.status !== initial.status || kind !== target.kind && field === 'add';
  const obsolete = revision !== snapshot.revision || !!target.recordId && !record;
  const blocked = state.connection !== 'live' || state.phase !== 'ready' || state.busy || !!state.pending || obsolete;
  const disputed = (field: Field) => snapshot.facts.conflicts?.some(item => item.recordId === (target.recordId ?? null) && item.field === field);
  const fields: Field[] = record ? ['amount', 'schedule.date', 'label', 'recurrence', ...(record.kind === 'income' ? ['reliability'] as const : ['controllability', 'autoDebit'] as const), ...(record.kind === 'debt' ? ['target', 'outstanding', 'debtType'] as const : [])] : [target.field];
  const moneyField = ['opening', 'reserve', 'amount', 'target', 'outstanding'].includes(field);
  const title = target.field === 'delete' ? `Remove ${record?.label ?? 'this item'}?` : target.field === 'add' ? 'Add an item' : target.field === 'coverage' ? 'Review this category' : target.field === 'reserve' ? 'Cash to keep aside' : `Correct ${record?.label ?? `cash on ${dateLabel(snapshot.anchorDate)}`}`;
  const saved = submitted && !state.busy && !state.pending && state.messageKind === 'status'
    && (state.message.startsWith('Your corrections are saved.') || state.message.startsWith('The action was confirmed'));

  function submit() {
    if (blocked || disputed(field)) return;
    const changes: components['schemas']['FactsPatch'] = { expectedRevision: revision };
    const patch: components['schemas']['RecordPatch'] = { id: target.recordId, delete: false, distinct: false };
    if (target.field === 'delete') { patch.delete = true; changes.records = [patch]; }
    else if (field === 'coverage') changes.coverage = { [target.kind!]: input.value };
    else if (field === 'add') {
      if (!input.value.trim()) { setError('Enter a name so you can find this item again.'); return; }
      if (snapshot.facts.records.length >= state.settings!.maxRecords) { setError('This plan has reached its item limit. Remove an item before adding another.'); return; }
      changes.records = [{ kind, label: input.value.trim(), delete: false, distinct: true }];
    } else if (moneyField) {
      if (!['unknown', 'absent'].includes(input.status) && parseAmount(input.value, state.settings!.maxMoneyPaise) === null) { setError('Enter a non-negative rupee amount with up to two decimal places.'); return; }
      const amount = input.status === 'absent' ? null : { amount: input.status === 'unknown' ? null : input.value, status: input.status as 'exact' | 'estimate' | 'unknown' };
      if (field === 'reserve') changes.reserve = input.value;
      else if (field === 'opening') changes.opening = amount!;
      else { Object.assign(patch, { [field]: amount }); changes.records = [patch]; }
    } else {
      if (field === 'schedule.date') patch.schedule = { date: input.value || null, certainty: input.value ? input.status === 'estimate' ? 'estimate' : 'exact' : 'unknown' };
      else if (field === 'recurrence') patch.schedule = { recurrence: input.value as Snapshot['facts']['records'][number]['schedule']['recurrence'] };
      else if (field === 'label') {
        if (!input.value.trim()) { setError('Enter a name.'); return; }
        patch.label = input.value.trim();
      } else Object.assign(patch, { [field]: field === 'autoDebit' ? input.value === 'true' : input.value });
      changes.records = [patch];
    }
    setError(''); setSubmitted(true);
    onCommand({ type: 'updateFacts', changes });
  }

  return <Dialog open={active} title={title} onClose={() => {
    if (state.pending || state.busy) return;
    if (!saved && changed) setDiscarding(true); else onClose();
  }} actions={saved ? <button className="primary" onClick={onClose}>Done</button> : discarding ? <>
    <button onClick={() => setDiscarding(false)}>Keep editing</button><button className="danger" onClick={onClose}>Discard correction</button>
  </> : <>
    {state.pending ? <button className="primary" disabled={state.busy || state.connection !== 'live'} onClick={onRetry}>Retry same save</button>
      : <button className={target.field === 'delete' ? 'danger' : 'primary'} disabled={blocked || disputed(field)} type="submit" form="money-correction">{state.busy ? 'Saving…' : target.field === 'delete' ? 'Remove this item' : 'Save correction'}</button>}
  </>}>
    {saved ? <p role="status">{state.message.startsWith('The action was confirmed') ? 'Save confirmed. Later changes superseded it; your latest saved plan is shown.' : 'Saved. Your plan and its calculations use this correction. No payment was made.'}</p> : <>
      {discarding && <p className="notice warning">Discard this unsaved correction? Your saved plan stays unchanged.</p>}
      {obsolete && <p role="alert" className="notice warning">Saved figures changed. Your correction is kept here for reference. Close and reopen to check the latest values before saving; it cannot overwrite them.</p>}
      {state.pending && <p className="notice warning">Save not confirmed. Keep this page open and retry the same save before changing anything.</p>}
      {!state.pending && submitted && state.messageKind === 'error' && <p role="alert">{state.message}</p>}
      {target.recordId ? <p className="hint">{record?.label ?? 'Item no longer available'}{record?.schedule.date && <> · {dateLabel(record.schedule.date)}</>}. Only this detail of this exact item changes.</p>
        : target.field === 'opening' && <p>Cash at the original plan start, {dateLabel(snapshot.anchorDate)}. This does not update today’s bank balance.</p>}
      {target.field === 'reserve' && <p>A buffer within your cash, not another expense or extra money.</p>}
      {(snapshot.preview || snapshot.accepted) && <p className="hint">Saving clears the preview. Affected saved changes need fresh consent; unrelated changes remain.</p>}
      <form id="money-correction" onSubmit={event => { event.preventDefault(); submit(); }}>
        <fieldset className="money-edit-fields" disabled={blocked || discarding}>
          <legend className="sr-only">Correction</legend>
          {record && target.field !== 'delete' && <label>Detail<select value={field} disabled={changed} onChange={event => {
            const field = event.target.value as Field; const input = read(field); setField(field); setInput(input); setInitial(input); setError('');
          }}>{fields.map(field => <option key={field} value={field} disabled={disputed(field)}>{field === 'amount' && record.kind === 'debt' ? 'Required / minimum payment' : labels[field]}</option>)}</select></label>}
          {disputed(field) ? <p>Resolve conflicting reports from this item’s details instead of overwriting them.</p>
            : target.field === 'delete' ? <p>Remove this exact item and its occurrences from your plan? Other items with the same name stay unchanged.</p>
              : field === 'add' ? <><label>Item name<input value={input.value} maxLength={120} onChange={event => setInput({ ...input, value: event.target.value })} /></label>
                <label>Category<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="income">Income</option><option value="essential">Essential spending</option><option value="optional">Other spending</option><option value="debt">Loan or card</option></select></label>
                <p className="hint">Amounts and dates remain unknown until you share them. This creates a separate item, even if another has the same name.</p></>
                : moneyField || field === 'schedule.date' ? <>
                  <label>{moneyField ? 'Amount (₹)' : 'Date'}<input type={moneyField ? 'text' : 'date'} inputMode={moneyField ? 'decimal' : undefined} value={input.value} disabled={moneyField && ['unknown', 'absent'].includes(input.status)} onChange={event => setInput({ ...input, value: event.target.value, status: !moneyField ? event.target.value ? input.status === 'estimate' ? 'estimate' : 'exact' : 'unknown' : input.status })} /></label>
                  {field !== 'reserve' && <label>{moneyField ? 'Amount certainty' : 'Date certainty'}<select value={input.status} onChange={event => setInput({ ...input, status: event.target.value })}>
                    {['target', 'outstanding'].includes(field) && <option value="absent">Not supplied</option>}
                    <option value="unknown" disabled={!moneyField && !!input.value}>Unknown</option><option value="exact" disabled={!moneyField && !input.value}>{moneyField ? 'Exact amount' : 'Exact date'}</option><option value="estimate" disabled={!moneyField && !input.value}>{moneyField ? 'Estimated amount' : 'Estimated date'}</option>
                  </select></label>}
                  {record?.kind === 'income' && <p className="hint">Only exact amounts with exact dates and reliable receipts count in projected balances.</p>}
                  {field === 'target' && <p className="hint">The intended payment includes the minimum. It is not an additional payment.</p>}
                </> : field === 'label' ? <label>Item name<input value={input.value} maxLength={120} onChange={event => setInput({ ...input, value: event.target.value })} /></label>
                  : <label>{labels[field]}<select value={input.value} onChange={event => setInput({ ...input, value: event.target.value })}>
                    {field === 'coverage' ? <><option value="notDiscussed">Not checked</option><option value="reported">Some shared</option><option value="unknown">Not sure</option><option value="reviewed" disabled={!snapshot.facts.records.some(item => item.kind === target.kind)}>Reviewed all items</option><option value="none" disabled={snapshot.facts.records.some(item => item.kind === target.kind)}>None reported</option></>
                      : field === 'recurrence' ? <><option value="once">Once</option><option value="weekly">Weekly</option><option value="fortnightly">Every two weeks</option><option value="monthly">Monthly</option></>
                        : field === 'autoDebit' ? <><option value="false">Not reported</option><option value="true">Automatic debit reported</option></>
                          : field === 'debtType' ? <><option value="unknown">Not confirmed</option><option value="card">Credit card</option><option value="loan">Loan</option><option value="informal">Informal borrowing</option></>
                            : <><option value="unknown">Not confirmed</option>{field === 'reliability' ? <><option value="reliable">Reliable</option><option value="uncertain">Uncertain</option></> : <><option value="controllable">Changeable and not committed</option><option value="committed">Already committed</option></>}</>}
                  </select></label>}
        </fieldset>{error && <p role="alert" className="field-error">{error}</p>}
      </form>
    </>}
  </Dialog>;
}