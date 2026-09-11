// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { MoneyInput } from './api';

export function MoneyField({ id, label, value, onChange, error }: {
  id: string; label: string; value: MoneyInput; onChange: (value: MoneyInput) => void; error?: string;
}) {
  return <fieldset className="money-field">
    <legend>{label}</legend>
    <div className="field-pair">
      <label htmlFor={`${id}-status`}>How certain?
        <select id={`${id}-status`} value={value.status} onChange={(event) => {
          const status = event.target.value as MoneyInput['status'];
          onChange({ status, amount: status === 'unknown' ? null : value.amount ?? '' });
        }}>
          <option value="unknown">Unknown</option>
          <option value="exact">Exact — reported by you</option>
          <option value="estimate">Estimate</option>
        </select>
      </label>
      {value.status !== 'unknown' && <label htmlFor={id}>{label} (₹)
        <input id={id} type="text" inputMode="decimal" value={value.amount ?? ''} maxLength={16}
          aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange({ ...value, amount: event.target.value })} />
      </label>}
    </div>
    {value.status === 'unknown' && <p className="hint">Not entered. This is not treated as zero.</p>}
    {error && <p id={`${id}-error`} className="field-error">{error}</p>}
  </fieldset>;
}