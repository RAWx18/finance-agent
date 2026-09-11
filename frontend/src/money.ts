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
  return { amount: value.amountPaise === null ? null : decimal(value.amountPaise), status: value.status };
}

export function draftFacts(snapshot: Snapshot): FactsInput {
  return {
    opening: moneyInput(snapshot.facts.opening),
    reserve: decimal(snapshot.facts.reservePaise),
    coverage: { ...snapshot.facts.coverage },
    decision: snapshot.facts.decision && { ...snapshot.facts.decision, focusRecordIds: [...(snapshot.facts.decision.focusRecordIds ?? [])] },
    providerResponses: snapshot.facts.providerResponses?.map(({ eventId, status, reportedOn, paymentDate, payment, cost }) => ({
      eventId, status, reportedOn, paymentDate,
      payment: payment ? moneyInput(payment) : null,
      cost: cost ? moneyInput(cost) : null,
    })),
    records: snapshot.facts.records.map(({ amount, target, outstanding, ...record }) => ({
      ...record, schedule: { ...record.schedule }, amount: moneyInput(amount),
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