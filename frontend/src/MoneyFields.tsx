// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { MoneyInput } from './api';

/** Provides amount, certainty, and optional currency-conversion inputs. */
export function MoneyFields({ value, onChange, income = false, foreign = true, valuation = false, optional = false, certainty = true, allowUnknown = true, label, certaintyLabel = 'Amount certainty' }: {
  value: MoneyInput | null; onChange: (value: MoneyInput | null) => void; income?: boolean; optional?: boolean;
  foreign?: boolean; valuation?: boolean;
  certainty?: boolean; allowUnknown?: boolean; label?: string; certaintyLabel?: string;
}) {
  const amount = value ?? { amount: null, status: 'unknown' as const };
  const conversion = amount.conversion;
  return <>
    {foreign && <label>Currency<select value={conversion ? 'foreign' : 'INR'} onChange={event => onChange({ ...amount, conversion: event.target.value === 'INR' ? null
      : { currency: '', rate: null, rateStatus: 'unknown', rateDate: null, fee: null, feeStatus: 'unknown', direction: income ? 'receipt' : valuation ? 'valuation' : 'payment' } })}>
      <option value="INR">INR · Indian rupees</option><option value="foreign">Foreign currency</option>
    </select></label>}
    {foreign && conversion && <label>Currency code<input value={conversion.currency} maxLength={3} autoCapitalize="characters" spellCheck={false} placeholder="e.g. USD" onChange={event => {
      const currency = event.target.value.toUpperCase();
      onChange({ ...amount, conversion: currency === conversion.currency ? conversion : { currency, rate: null, rateStatus: 'unknown', rateDate: null, fee: null, feeStatus: 'unknown', direction: income ? 'receipt' : valuation ? 'valuation' : 'payment' } });
    }} /></label>}
    <label>{conversion ? `Original amount (${conversion.currency || 'foreign currency'})` : label ?? 'Amount (₹)'}<input type="text" inputMode="decimal" value={amount.amount ?? ''} disabled={!value || amount.status === 'unknown'} onChange={event => onChange({ ...amount, amount: event.target.value })} /></label>
    {certainty && <label>{certaintyLabel}<select value={value?.status ?? 'absent'} onChange={event => onChange(event.target.value === 'absent' ? null : { ...amount, status: event.target.value as MoneyInput['status'] })}>
      {optional && <option value="absent">Not supplied</option>}{allowUnknown && <option value="unknown">Unknown</option>}<option value="exact">Exact amount</option><option value="estimate">Estimated amount</option>
    </select></label>}
    {foreign && conversion && <>
      <p className="hint">Enter the original currency amount, not calculated rupees. Missing rates are obtained automatically from Frankfurter by the backend, using only the currency pair. Reference rates are estimates, not actual bank rates or net quotes. An explicit rate correction uses your reported rate instead. Changing currency clears the rate and fee assumptions.</p>
      <label>Rate (INR per 1 {conversion.currency || 'currency unit'})<input inputMode="decimal" value={conversion.rate ?? ''} disabled={conversion.rateStatus === 'unknown'} onChange={event => onChange({ ...amount, conversion: { ...conversion, rate: event.target.value, provider: null, fetchedAt: null } })} /></label>
      <label>Rate certainty<select value={conversion.rateStatus} onChange={event => onChange({ ...amount, conversion: { ...conversion, rateStatus: event.target.value as MoneyInput['status'], provider: null, fetchedAt: null } })}>
        <option value="unknown">Unknown</option><option value="exact">Fixed / confirmed rate</option><option value="estimate">Estimated rate</option>
      </select></label>
      <label>Rate as of (optional)<input type="date" value={conversion.rateDate ?? ''} onChange={event => onChange({ ...amount, conversion: { ...conversion, rateDate: event.target.value || null } })} /></label>
      <label>{income ? 'INR deduction (₹)' : 'INR fee (₹)'}<input inputMode="decimal" value={conversion.fee ?? ''} disabled={conversion.feeStatus === 'unknown'} onChange={event => onChange({ ...amount, conversion: { ...conversion, fee: event.target.value } })} /></label>
      <label>{income ? 'Deduction certainty' : 'Fee certainty'}<select value={conversion.feeStatus} onChange={event => onChange({ ...amount, conversion: { ...conversion, feeStatus: event.target.value as MoneyInput['status'] } })}>
        <option value="unknown">Unknown</option><option value="exact">Exact {income ? 'deduction' : 'fee'}</option><option value="estimate">Estimated {income ? 'deduction' : 'fee'}</option>
      </select></label>
      <p className="hint">{valuation ? 'Outstanding balance is a rate-only valuation, not a payment. Any reported transaction fee is retained but does not change the balance.' : income ? 'Enter 0 explicitly if there is no deduction. Fees reduce usable cash; estimated receipts are not confirmed income.' : 'Fees are added to the converted payment, not deducted. Enter 0 explicitly if there is no fee.'} {!valuation && 'A Frankfurter planning estimate excludes unknown conversion fees; fees are not assumed to be zero. Reported-rate conversions still need a known fee.'} If an automatic rate is unavailable, INR stays unknown; automatic retry is next day, subject to the daily limit.</p>
    </>}
  </>;
}