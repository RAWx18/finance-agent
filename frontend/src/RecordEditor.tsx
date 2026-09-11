// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { RecordInput, Settings } from './api';
import { MoneyField } from './MoneyField';
import { kindLabels, kinds } from './validation';

export function RecordEditor({ record, settings, onChange, errors }: {
  record: RecordInput; settings: Settings; onChange: (record: RecordInput) => void; errors: Record<string, string>;
}) {
  const id = record.id;
  return <div className="record-editor">
    <div className="field-pair">
      <label htmlFor={`${id}-kind`}>Category
        <select id={`${id}-kind`} value={record.kind} onChange={(event) => {
          const kind = event.target.value as RecordInput['kind'];
          onChange({ ...record, kind, reliability: kind === 'income' ? 'unknown' : null,
            debtType: kind === 'debt' ? 'unknown' : null, controllability: kind === 'income' ? null : 'unknown',
            autoDebit: false, target: null, outstanding: null });
        }}>
          {kinds.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}
        </select>
      </label>
      <div><label htmlFor={`${id}-label`}>Item name
          <input id={`${id}-label`} value={record.label} maxLength={120} aria-invalid={!!errors[`${id}-label`]}
            aria-describedby={errors[`${id}-label`] ? `${id}-label-error` : undefined}
            onChange={(event) => onChange({ ...record, label: event.target.value })} />
        </label>
        {errors[`${id}-label`] && <p id={`${id}-label-error`} className="field-error">{errors[`${id}-label`]}</p>}
      </div>
    </div>
    <MoneyField id={`${id}-amount`} label={record.kind === 'debt' ? 'Required / minimum payment' : 'Amount'}
      value={record.amount} onChange={(amount) => onChange({ ...record, amount })} error={errors[`${id}-amount`]} />
    <div className="field-pair">
      <div><label htmlFor={`${id}-date`}>Next unpaid or future date
          <input id={`${id}-date`} type="date" value={record.schedule.date ?? ''}
            aria-invalid={!!errors[`${id}-date`]} aria-describedby={`${id}-date-hint`}
            onChange={(event) => onChange({ ...record, schedule: { ...record.schedule, date: event.target.value || null } })} />
        </label>
        <p className="hint" id={`${id}-date-hint`}>{errors[`${id}-date`] ?? 'Leave blank if unknown. Do not enter already paid or received items.'}</p>
      </div>
      <label htmlFor={`${id}-recurrence`}>Repeats
        <select id={`${id}-recurrence`} value={record.schedule.recurrence ?? 'once'}
          onChange={(event) => onChange({ ...record, schedule: { ...record.schedule, recurrence: event.target.value as RecordInput['schedule']['recurrence'] } })}>
          {settings.recurrence.map((value) => <option key={value} value={value}>{({ once: 'Once', weekly: 'Weekly', fortnightly: 'Every two weeks', monthly: 'Monthly' } as Record<string, string>)[value] ?? value}</option>)}
        </select>
      </label>
    </div>
    {record.kind === 'income' ? <label htmlFor={`${id}-reliability`}>Income certainty
      <select id={`${id}-reliability`} value={record.reliability ?? 'unknown'} onChange={(event) => onChange({ ...record, reliability: event.target.value as RecordInput['reliability'] })}>
        <option value="unknown">Not confirmed — excluded from balances</option><option value="reliable">Reliable</option><option value="uncertain">Uncertain — excluded from balances</option>
      </select>
    </label> : <label className="check"><input type="checkbox" checked={record.autoDebit ?? false}
      onChange={(event) => onChange({ ...record, autoDebit: event.target.checked })} />Automatic debit</label>}
    {record.kind === 'debt' && <>
      <label htmlFor={`${id}-debtType`}>Debt type
        <select id={`${id}-debtType`} value={record.debtType ?? 'unknown'} onChange={(event) => onChange({ ...record, debtType: event.target.value as RecordInput['debtType'] })}>
          <option value="unknown">Not confirmed</option><option value="loan">Loan</option><option value="card">Credit card</option><option value="informal">Informal borrowing</option>
        </select>
      </label>
      <fieldset>
        <legend>Optional debt details</legend>
        <p className="hint">A target replaces the minimum, not an extra payment. The outstanding balance is for reference only.</p>
        {(['target', 'outstanding'] as const).map((field) => <div key={field}>
          <label className="check"><input type="checkbox" checked={!!record[field]} onChange={(event) => onChange({ ...record, [field]: event.target.checked ? { amount: null, status: 'unknown' } : null })} />
            {field === 'target' ? 'Include a selected target' : 'Include outstanding balance'}</label>
          {record[field] && <MoneyField id={`${id}-${field}`} label={field === 'target' ? 'Selected target' : 'Outstanding balance'}
            value={record[field]} onChange={(value) => onChange({ ...record, [field]: value })} error={errors[`${id}-${field}`]} />}
        </div>)}
      </fieldset>
    </>}
    {(record.kind === 'optional' || record.kind === 'debt' && record.debtType === 'card') && !record.autoDebit && <div>
      <label htmlFor={`${id}-controllability`}>Can this spending change?
        <select id={`${id}-controllability`} value={record.controllability ?? 'unknown'}
          aria-describedby={`${id}-controllability-hint`}
          onChange={event => onChange({ ...record, controllability: event.target.value as RecordInput['controllability'] })}>
          <option value="unknown">Not confirmed</option>
          <option value="controllable">Yes — changeable and not committed</option>
          <option value="committed">No — already committed</option>
        </select>
      </label>
      <p id={`${id}-controllability-hint`} className="hint">{record.kind === 'debt'
        ? 'Only the amount above the minimum can be reduced. This does not save a reduction.'
        : 'Confirm it can be reduced without cutting essentials. If unsure, you can preview but not save a reduction.'}</p>
    </div>}
  </div>;
}