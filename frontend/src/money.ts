// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { FactsInput, MoneyInput, Snapshot } from './api';
import type { components } from './contracts';

export function decimal(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error('Money must be an exact integer.');
  const value = BigInt(paise);
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

export function parseAmount(value: string, limit: number): bigint | null {
  if (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return amount <= BigInt(limit) ? amount : null;
}

export function moneyInput(value: components['schemas']['Money']): MoneyInput {
  return value.source ? structuredClone(value.source) : { amount: value.amountPaise === null ? null : decimal(value.amountPaise), status: value.status };
}

export const amountStatus = { exact: 'Reported', estimate: 'Estimated', unknown: 'Unknown' };
export const recurrenceLabels: Record<components['schemas']['Schedule']['recurrence'], string> = {
  once: 'Once', daily: 'Daily', weekly: 'Weekly', fortnightly: 'Every two weeks', monthly: 'Monthly', monthlyBudget: 'Monthly budget · spread across calendar days',
};
export const budgetDescription = 'An estimated cash budget spread evenly across each calendar month’s actual days, not a scheduled payment or lender due date. Only days within the plan and start/end dates count.';

export function sourceDescription(source: MoneyInput): string {
  const conversion = source.conversion;
  if (!conversion) return '';
  return `${conversion.currency} ${source.amount ?? 'Unknown amount'} · ${amountStatus[source.status]} original amount; `
    + `Rate: ${conversion.rate == null ? 'Unknown' : `₹${conversion.rate} per 1 ${conversion.currency}`} · ${conversion.rateStatus === 'exact' ? 'Fixed / confirmed' : amountStatus[conversion.rateStatus]}`
    + `${conversion.rateDate ? ` · as of ${dateLabel(conversion.rateDate)}` : ' · as-of date not supplied'}; `
    + `INR deduction: ${conversion.fee == null ? 'Unknown' : `₹${conversion.fee}`} · ${amountStatus[conversion.feeStatus]}`;
}

export function amountLabel(value: components['schemas']['Money']): string {
  return value.source?.conversion ? `${value.source.conversion.currency} ${value.source.amount ?? 'Unknown amount'} · Calculated INR: ${money(value.amountPaise)}` : money(value.amountPaise);
}

export function scheduleLabel(schedule: components['schemas']['Schedule']): string {
  return [recurrenceLabels[schedule.recurrence], schedule.pattern ? `Reported ${schedule.pattern.kind === 'dayOfMonth' ? `day ${schedule.pattern.day} of each month` : 'month-end pattern'} · generated dates remain estimates` : null,
    schedule.endDate ? `Through ${dateLabel(schedule.endDate)} (inclusive)` : null,
    schedule.count != null ? `${schedule.count} ${schedule.recurrence === 'monthlyBudget' ? 'calendar months' : 'occurrences'}` : null,
    schedule.amounts?.length ? `${schedule.amounts.length} ordered amounts · varies by occurrence` : null].filter(Boolean).join(' · ');
}

export function submittedMoney(value: MoneyInput): MoneyInput {
  return { ...value, amount: value.status === 'unknown' ? null : value.amount,
    ...(value.conversion ? { conversion: { ...value.conversion,
      rate: value.conversion.rateStatus === 'unknown' ? null : value.conversion.rate,
      fee: value.conversion.feeStatus === 'unknown' ? null : value.conversion.fee,
    } } : {}),
  };
}

export function moneyError(value: MoneyInput, limit: number): string | null {
  if (value.status !== 'unknown' && parseAmount(value.amount ?? '', limit) === null)
    return value.conversion ? 'Enter a non-negative original currency amount with up to two decimal places.' : 'Enter a non-negative rupee amount with up to two decimal places.';
  const conversion = value.conversion;
  if (!conversion) return null;
  if (!/^[A-Z]{3}$/.test(conversion.currency) || conversion.currency === 'INR') return 'Enter a three-letter foreign currency code, or select INR.';
  if (conversion.rateStatus !== 'unknown' && (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,8})?$/.test(conversion.rate ?? '') || !/[1-9]/.test(conversion.rate ?? '')))
    return 'Enter a rate greater than zero with up to eight decimal places, or mark it unknown.';
  if (conversion.feeStatus !== 'unknown' && parseAmount(conversion.fee ?? '', limit) === null)
    return 'Enter the INR deduction with up to two decimal places, including 0 for no deduction, or mark it unknown.';
  return null;
}

export function draftFacts(snapshot: Snapshot): FactsInput {
  return {
    opening: moneyInput(snapshot.facts.opening),
    reserve: decimal(snapshot.facts.reservePaise),
    coverage: { ...snapshot.facts.coverage },
    decision: snapshot.facts.decision && structuredClone(snapshot.facts.decision),
    conflicts: structuredClone(snapshot.facts.conflicts),
    providerResponses: snapshot.facts.providerResponses?.map(({ eventId, status, reportedOn, paymentDate, payment, cost }) => ({
      eventId, status, reportedOn, paymentDate,
      payment: payment ? moneyInput(payment) : null,
      cost: cost ? moneyInput(cost) : null,
    })),
    records: snapshot.facts.records.map(({ amount, target, outstanding, ...record }) => ({
      ...record, schedule: structuredClone(record.schedule), amount: moneyInput(amount),
      target: target ? moneyInput(target) : null,
      outstanding: outstanding ? moneyInput(outstanding) : null,
    })),
  };
}

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function money(paise: number | null): string {
  if (paise === null) return 'Unknown';
  // Intl's decimal-string input avoids precision loss even at the aggregate limit.
  return currency.format(decimal(paise) as unknown as number);
}

export function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`));
}

export function lastDate(endExclusive: string): string {
  const [year, month, day] = endExclusive.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

export function timestamp(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone,
  }).format(new Date(value));
}