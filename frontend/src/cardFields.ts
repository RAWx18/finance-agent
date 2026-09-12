// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { MoneyInput, Snapshot } from './api';
import type { components } from './contracts';
import { decimal, money, moneyError, moneyInput, parseAmount } from './money';

export type CardTarget = {
  recordId?: string; field: 'opening' | 'reserve' | 'label' | 'amount' | 'target' | 'outstanding' | 'schedule.date';
  index?: number; term?: 'rate' | 'fee' | 'rateDate';
};
export type CardDraft = { value: string; status: MoneyInput['status']; source: MoneyInput | null; alternative: string };

export const cardStatus = { exact: 'Reported', estimate: 'Est.', unknown: 'Unknown' };
export const cardDate = (date: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
export const cardMoney = (paise: number | null) => money(paise).replace(/\.00$/, '');

export function sourceAmount(source: MoneyInput): string {
  if (source.amount === null || source.status === 'unknown') return 'Unknown';
  const [whole, fraction = ''] = source.amount.split('.');
  return `${source.conversion ? `${source.conversion.currency} ` : '₹'}${BigInt(whole).toLocaleString('en-IN')}${fraction && /[1-9]/.test(fraction) ? `.${fraction.padEnd(2, '0')}` : ''}`;
}

export function fieldConflict(snapshot: Snapshot, target: CardTarget) {
  return snapshot.facts.conflicts?.find(item => (item.recordId ?? undefined) === target.recordId && item.field === target.field);
}

export function fieldDraft(snapshot: Snapshot, target: CardTarget): CardDraft {
  const record = snapshot.facts.records.find(item => item.id === target.recordId);
  let source: MoneyInput | null = null;
  if (target.field === 'opening') source = moneyInput(snapshot.facts.opening);
  else if (target.field === 'reserve') source = { amount: decimal(snapshot.facts.reservePaise), status: 'exact' };
  else if (target.field === 'amount' && target.index !== undefined) source = structuredClone(record?.schedule.amounts?.[target.index] ?? { amount: null, status: 'unknown' });
  else if (target.field === 'amount' || target.field === 'target' || target.field === 'outstanding') {
    const amount = record?.[target.field];
    source = amount ? moneyInput(amount) : { amount: null, status: 'unknown' };
  }
  const conversion = source?.conversion;
  const value = target.field === 'label' ? record?.label : target.field === 'schedule.date' ? record?.schedule.date
    : target.term ? conversion?.[target.term] : source?.amount;
  const status = target.field === 'schedule.date' ? record?.schedule.certainty : target.term === 'rateDate' ? value ? 'exact' : 'unknown'
    : target.term === 'rate' ? conversion?.rateStatus : target.term === 'fee' ? conversion?.feeStatus : source?.status;
  return { value: value ?? '', status: status ?? 'exact', source, alternative: '' };
}

export function conflictDraft(value: components['schemas']['ConflictValue']): CardDraft {
  const source = value.date ? null : value.source ? structuredClone(value.source) : { amount: value.amountPaise == null ? null : decimal(value.amountPaise), status: value.status };
  return { value: value.date ?? source?.amount ?? '', status: value.status, source, alternative: value.id };
}

function draftMoney(draft: CardDraft, target: CardTarget): MoneyInput {
  const source = draft.source ?? { amount: null, status: 'unknown' };
  const value = draft.status === 'unknown' ? null : draft.value.trim();
  if (target.term && source.conversion) return { ...source, conversion: { ...source.conversion, [target.term]: value,
    ...(target.term === 'rate' ? { rateStatus: draft.status } : target.term === 'fee' ? { feeStatus: draft.status } : {}) } };
  return { ...source, amount: value, status: draft.status };
}

export function fieldError(draft: CardDraft, target: CardTarget, disputed = false): string | null {
  if (disputed && (!draft.alternative || draft.status === 'unknown')) return 'Choose a report or enter the correct value.';
  if (target.field === 'label') return draft.value.trim() ? draft.value.trim().length <= 120 ? null : 'Use a name of 120 characters or fewer.' : 'Enter a name.';
  if (target.field === 'schedule.date' || target.term === 'rateDate') {
    if (draft.status === 'unknown') return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(draft.value) && Number.isFinite(Date.parse(draft.value))
      && new Date(draft.value).toISOString().slice(0, 10) === draft.value ? null : 'Enter a valid date, or choose Unknown.';
  }
  return moneyError(draftMoney(draft, target), Number.MAX_SAFE_INTEGER);
}

export function fieldOperation(snapshot: Snapshot, target: CardTarget, draft: CardDraft): components['schemas']['UpdateFacts'] {
  const changes: components['schemas']['FactsPatch'] = { expectedRevision: snapshot.revision };
  const conflict = fieldConflict(snapshot, target);
  if (conflict) {
    const status = draft.status === 'estimate' ? 'estimate' : 'exact';
    changes.resolutions = [{ conflictId: conflict.id, value: {
      ...(target.field === 'schedule.date' ? { date: draft.value } : draftMoney(draft, target)),
      status, id: draft.alternative === 'custom' ? crypto.randomUUID() : draft.alternative,
    } }];
  } else if (target.field === 'opening') changes.opening = draftMoney(draft, target);
  else if (target.field === 'reserve') changes.reserve = draft.value.trim();
  else {
    const patch: components['schemas']['RecordPatch'] = { id: target.recordId, delete: false, distinct: false };
    if (target.field === 'label') patch.label = draft.value.trim();
    else if (target.field === 'schedule.date') patch.schedule = { date: draft.status === 'unknown' ? null : draft.value, certainty: draft.status };
    else if (target.field === 'amount' && target.index !== undefined) {
      const amounts = structuredClone(snapshot.facts.records.find(item => item.id === target.recordId)!.schedule.amounts!);
      amounts[target.index] = draftMoney(draft, target);
      patch.schedule = { amounts: amounts.map(amount => ({ ...amount, conversion: amount.conversion ?? null })) };
    } else patch[target.field] = draftMoney(draft, target);
    changes.records = [patch];
  }
  return { type: 'updateFacts', source: 'humanCardEdit', changes };
}

function sameDecimal(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) => value == null ? null : value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return normalize(left) === normalize(right);
}

function sameMoney(left: MoneyInput, right: MoneyInput): boolean {
  if (left.status !== right.status || !sameDecimal(left.amount, right.amount)) return false;
  const a = left.conversion; const b = right.conversion;
  return !a || !b ? !a && !b : a.currency === b.currency && sameDecimal(a.rate, b.rate) && sameDecimal(a.fee, b.fee)
    && a.rateStatus === b.rateStatus && a.feeStatus === b.feeStatus && (a.rateDate ?? null) === (b.rateDate ?? null);
}

export function fieldSaved(snapshot: Snapshot, target: CardTarget, operation: components['schemas']['UpdateFacts']): boolean {
  if (fieldConflict(snapshot, target)) return false;
  const changes = operation.changes;
  const record = snapshot.facts.records.find(item => item.id === target.recordId);
  if (target.recordId && !record) return false;
  const patch = changes.records?.[0];
  if (target.field === 'label') return record?.label === patch?.label;
  if (target.field === 'reserve') return BigInt(snapshot.facts.reservePaise) === parseAmount(changes.reserve ?? '', Number.MAX_SAFE_INTEGER);
  const resolution = changes.resolutions?.[0]?.value;
  if (target.field === 'schedule.date') return record?.schedule.date === (resolution?.date ?? patch?.schedule?.date)
    && record?.schedule.certainty === (resolution?.status ?? patch?.schedule?.certainty);
  if (patch?.schedule?.amounts) return record?.schedule.amounts?.length === patch.schedule.amounts.length
    && patch.schedule.amounts.every((value, index) => sameMoney(record!.schedule.amounts![index], value));
  const expected = resolution ? { amount: resolution.amount ?? null, status: resolution.status, conversion: resolution.conversion }
    : target.field === 'opening' ? changes.opening : patch?.[target.field];
  const actual = target.field === 'opening' ? snapshot.facts.opening : record?.[target.field];
  return !!actual && !!expected && sameMoney(moneyInput(actual), expected);
}