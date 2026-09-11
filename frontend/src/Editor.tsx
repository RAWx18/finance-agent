// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { FactsInput, RecordInput, Settings } from './api';
import { MoneyField } from './MoneyField';
import { RecordEditor } from './RecordEditor';
import { kindLabels, kinds, validateFacts } from './validation';
import { PagedList } from './PagedList';
import { Dialog } from './Dialog';

export function Editor({ facts, settings, locked, conflict, pending, onChange, onSave, onCancel, onUseSaved, onReconcile }: {
  facts: FactsInput; settings: Settings; locked: boolean; conflict: boolean; pending: boolean;
  onChange: (facts: FactsInput) => void; onSave: () => void; onCancel: () => void;
  onUseSaved: () => void; onReconcile: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const focusField = useRef<string | null>(null);
  const errors = submitted ? validateFacts(facts, settings) : {};
  const record = facts.records.find((item) => item.id === selected);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (!record || !focusField.current) return;
    const frame = requestAnimationFrame(() => {
      if (focusField.current) document.getElementById(focusField.current)?.focus();
      focusField.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [record]);

  function changeRecord(value: RecordInput) {
    const coverage = { ...facts.coverage };
    if (record && value.kind !== record.kind) {
      coverage[value.kind] = 'reported';
      coverage[record.kind] = 'reported';
    }
    onChange({ ...facts, coverage, records: facts.records.map((item) => item.id === value.id ? value : item) });
  }

  return <section className="card editor no-print" aria-labelledby="editor-heading">
    <header><h2 id="editor-heading" ref={heading} tabIndex={-1}>Edit your figures</h2>
      <p>Changes stay in your draft until you save.</p></header>
    {conflict && <div className="notice warning">
      <h3>Saved figures changed elsewhere</h3>
      <p>Your draft is kept. Check Overview before saving: your draft will replace all saved figures.</p>
      <div className="actions"><button type="button" disabled={locked || pending} onClick={onUseSaved}>Use saved figures</button>
        <button type="button" disabled={locked || pending} onClick={onReconcile}>Keep my draft</button></div>
    </div>}
    {pending && <p className="notice warning">Your save is not confirmed. Keep this page open and retry the same save before editing.</p>}
    <form noValidate onSubmit={(event) => {
      event.preventDefault();
      setSubmitted(true);
      if (Object.keys(validateFacts(facts, settings)).length) {
        requestAnimationFrame(() => summary.current?.focus());
        return;
      }
      onSave();
    }}>
      {Object.keys(errors).length > 0 && <div ref={summary} tabIndex={-1} className="notice warning" role="alert">
        <h3>Check these draft fields</h3>
        <ul>{Object.entries(errors).map(([key, message]) => <li key={key}>
          <button type="button" className="text-button" onClick={() => {
            const item = facts.records.find((item) => key.startsWith(`${item.id}-`));
            if (item) {
              focusField.current = key;
              setSelected(item.id);
            } else requestAnimationFrame(() => document.getElementById(key)?.focus());
          }}>{key === 'opening' ? 'Available cash' : key === 'reserve' ? 'Reserve floor' : facts.records.find((item) => key.startsWith(`${item.id}-`))?.label || 'Category or item'}: {message}</button>
        </li>)}</ul>
      </div>}
      <fieldset disabled={locked || pending} className="editor-fields">
        <legend className="sr-only">Your figures</legend>
        <MoneyField id="opening" label="Available cash" value={facts.opening} onChange={(opening) => onChange({ ...facts, opening })} error={errors.opening} />
        <p className="hint">Available at the start of this plan; don’t include credit.</p>
        <div>
          <label htmlFor="reserve">Reserve floor (₹)<input id="reserve" inputMode="decimal" value={facts.reserve ?? '0'} maxLength={16}
            aria-invalid={!!errors.reserve} aria-describedby="reserve-hint" onChange={(event) => onChange({ ...facts, reserve: event.target.value })} /></label>
          <p id="reserve-hint" className={errors.reserve ? 'field-error' : 'hint'}>{errors.reserve ?? 'Cash to keep aside, not an expense. Use 0 for none.'}</p>
        </div>
        <section aria-labelledby="draft-items-heading"><div className="section-heading"><h3 id="draft-items-heading">Income & commitments</h3>
          <button type="button" disabled={facts.records.length >= settings.maxRecords} onClick={() => {
            const item: RecordInput = { id: crypto.randomUUID(), kind: 'essential', label: '', autoDebit: false, amount: { status: 'unknown', amount: null }, schedule: { date: null, recurrence: 'once' } };
            onChange({ ...facts, coverage: { ...facts.coverage, essential: 'reported' }, records: [...facts.records, item] });
            focusField.current = `${item.id}-label`;
            setSelected(item.id);
          }}>Add an item</button></div>
          {!facts.records.length && <p className="hint">Add what is expected or still unpaid. You can leave amounts and dates unknown.</p>}
          <PagedList className="draft-list" label="Draft items">
            {facts.records.map((item) => <li key={item.id}>
              <button type="button" className="item-select" aria-haspopup="dialog" onClick={() => setSelected(item.id)}>{item.label || 'Unnamed item'}<span>{kindLabels[item.kind]}</span></button>
              <button type="button" aria-label={`Remove ${item.label || 'unnamed item'}`} onClick={() => {
                onChange({ ...facts, coverage: { ...facts.coverage, [item.kind]: 'reported' }, records: facts.records.filter((entry) => entry.id !== item.id) });
                if (selected === item.id) setSelected(null);
              }}>Remove</button>
            </li>)}
          </PagedList>
          <p className="hint">Check each category after adding, removing or moving items.</p>
        </section>
        <section aria-labelledby="coverage-heading"><h3 id="coverage-heading">Have you covered each category?</h3>
          <p className="hint">An empty list does not mean there is nothing due. Confirm none only when you have checked.</p>
          <div className="coverage-grid">{kinds.map((kind) => {
            const present = facts.records.some((item) => item.kind === kind);
            return <label key={kind} htmlFor={kind}>{kindLabels[kind]}
              <select id={kind} value={facts.coverage[kind] ?? 'notDiscussed'} aria-invalid={!!errors[kind]}
                onChange={(event) => onChange({ ...facts, coverage: { ...facts.coverage, [kind]: event.target.value as FactsInput['coverage'][typeof kind] } })}>
                <option value="notDiscussed">Not checked yet</option><option value="reported">Items entered; not reviewed</option>
                <option value="unknown">Not sure</option><option value="reviewed" disabled={!present}>Reviewed all items</option>
                <option value="none" disabled={present}>Confirmed none</option>
              </select>
              {errors[kind] && <span className="field-error">{errors[kind]}</span>}
            </label>;
          })}</div>
        </section>
      </fieldset>
      <div className="actions editor-actions">
        <button className="primary" disabled={locked || (conflict && !pending)} type="submit">{locked ? 'Please wait…' : pending ? 'Retry same save' : 'Save figures'}</button>
        <button type="button" disabled={locked || pending} onClick={onCancel}>Discard draft</button>
      </div>
    </form>
    <Dialog open={!!record} title="Edit item" onClose={() => setSelected(null)} actions={
      <button type="button" className="primary" onClick={() => setSelected(null)}>Done</button>
    }>
      <p className="hint">Kept in your draft. Choose Save figures when you’re ready.</p>
      <fieldset disabled={locked || pending}>
        <legend className="sr-only">Item details</legend>
        {record && <RecordEditor key={record.id} record={record} settings={settings} onChange={changeRecord} errors={errors} />}
      </fieldset>
    </Dialog>
  </section>;
}