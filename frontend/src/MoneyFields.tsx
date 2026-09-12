// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { MoneyInput } from './api';

/** Provides amount, certainty, and optional currency-conversion inputs. */
export function MoneyFields({ value, onChange, income = false, optional = false, certainty = true, allowUnknown = true, label, certaintyLabel = 'Amount certainty' }: {
  value: MoneyInput | null; onChange: (value: MoneyInput | null) => void; income?: boolean; optional?: boolean;
  certainty?: boolean; allowUnknown?: boolean; label?: string; certaintyLabel?: string;
}) {
  const amount = value ?? { amount: null, status: 'unknown' as const };
  const conversion = amount.conversion;
  return <>
    {income && <label>Currency<select value={conversion ? 'foreign' : 'INR'} onChange={event => onChange({ ...amount, conversion: event.target.value === 'INR' ? null
      : { currency: '', rate: null, rateStatus: 'unknown', rateDate: null, fee: null, feeStatus: 'unknown' } })}>
      <option value="INR">INR · Indian rupees</option><option value="foreign">Foreign currency</option>
    </select></label>}
    {income && conversion && <label>Currency code<input value={conversion.currency} maxLength={3} autoCapitalize="characters" spellCheck={false} placeholder="e.g. USD" onChange={event => {
      const currency = event.target.value.toUpperCase();
      onChange({ ...amount, conversion: currency === conversion.currency ? conversion : { currency, rate: null, rateStatus: 'unknown', rateDate: null, fee: null, feeStatus: 'unknown' } });
    }} /></label>}
    <label>{conversion ? `Original amount (${conversion.currency || 'foreign currency'})` : label ?? 'Amount (₹)'}<input type="text" inputMode="decimal" value={amount.amount ?? ''} disabled={!value || amount.status === 'unknown'} onChange={event => onChange({ ...amount, amount: event.target.value })} /></label>
    {certainty && <label>{certaintyLabel}<select value={value?.status ?? 'absent'} onChange={event => onChange(event.target.value === 'absent' ? null : { ...amount, status: event.target.value as MoneyInput['status'] })}>
      {optional && <option value="absent">Not supplied</option>}{allowUnknown && <option value="unknown">Unknown</option>}<option value="exact">Exact amount</option><option value="estimate">Estimated amount</option>
    </select></label>}
    {income && conversion && <>
      <p className="hint">Enter the original currency amount, not net rupees. You supply the rate and deduction; the plan calculates INR after saving. No live exchange rate is fetched. Changing currency clears the rate and deduction assumptions so you can supply the applicable terms.</p>
      <label>Rate (INR per 1 {conversion.currency || 'currency unit'})<input inputMode="decimal" value={conversion.rate ?? ''} disabled={conversion.rateStatus === 'unknown'} onChange={event => onChange({ ...amount, conversion: { ...conversion, rate: event.target.value } })} /></label>
      <label>Rate certainty<select value={conversion.rateStatus} onChange={event => onChange({ ...amount, conversion: { ...conversion, rateStatus: event.target.value as MoneyInput['status'] } })}>
        <option value="unknown">Unknown</option><option value="exact">Fixed / confirmed rate</option><option value="estimate">Estimated rate</option>
      </select></label>
      <label>Rate as of (optional)<input type="date" value={conversion.rateDate ?? ''} onChange={event => onChange({ ...amount, conversion: { ...conversion, rateDate: event.target.value || null } })} /></label>
      <label>INR deduction (₹)<input inputMode="decimal" value={conversion.fee ?? ''} disabled={conversion.feeStatus === 'unknown'} onChange={event => onChange({ ...amount, conversion: { ...conversion, fee: event.target.value } })} /></label>
      <label>Deduction certainty<select value={conversion.feeStatus} onChange={event => onChange({ ...amount, conversion: { ...conversion, feeStatus: event.target.value as MoneyInput['status'] } })}>
        <option value="unknown">Unknown</option><option value="exact">Exact deduction</option><option value="estimate">Estimated deduction</option>
      </select></label>
      <p className="hint">Enter 0 explicitly if there is no deduction. Missing rates or deductions stay unknown, not zero. Estimated conversion assumptions are not counted on as confirmed income.</p>
    </>}
  </>;
}