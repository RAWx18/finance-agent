// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import type { MoneyInput } from '../src/api';
import { cardMoney, fieldDraft, fieldError, fieldOperation, fieldSaved, sourceAmount } from '../src/cardFields';
import { planningSnapshot } from './fixtures';

const foreign = (): MoneyInput => ({ amount: '1200.25', status: 'estimate', conversion: { currency: 'USD', rate: '83.12345678', rateStatus: 'estimate', rateDate: '2026-09-12', fee: '250.50', feeStatus: 'exact' } });

it('formats Indian grouping without discarding nonzero paise or changing unknown to zero', () => {
  expect(cardMoney(60000000)).toBe('₹6,00,000'); expect(cardMoney(60000025)).toBe('₹6,00,000.25');
  expect(cardMoney(10)).toBe('₹0.10'); expect(cardMoney(0)).toBe('₹0'); expect(cardMoney(null)).toBe('Unknown');
  expect(sourceAmount(foreign())).toBe('USD 1,200.25');
  expect(sourceAmount({ amount: '90071992547409.91', status: 'exact' })).toBe('₹9,00,71,99,25,47,409.91');
});

it('edits the original foreign amount and preserves every conversion term', () => {
  const saved = planningSnapshot(); saved.facts.records[0].amount = { amountPaise: 9951035, status: 'estimate', source: foreign() };
  const target = { recordId: 'rent', field: 'amount' as const }; const draft = fieldDraft(saved, target);
  expect(draft.value).toBe('1200.25'); draft.value = '1300.50';
  const operation = fieldOperation(saved, target, draft);
  expect(operation.source).toBe('humanCardEdit');
  expect(operation.changes.records?.[0].amount).toEqual({ ...foreign(), amount: '1300.50' });
  expect(saved.facts.records[0].amount.source).toEqual(foreign());
  const receipt = structuredClone(saved); receipt.facts.records[0].amount.source = { ...foreign(), amount: '1300.50' };
  expect(fieldSaved(receipt, target, operation)).toBe(true);
  receipt.facts.records[0].amount.source.conversion!.fee = '0'; expect(fieldSaved(receipt, target, operation)).toBe(false);
});

it('replaces only the canonical occurrence index within a complete source array', () => {
  const saved = planningSnapshot();
  saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.facts.records[0].schedule.amounts = [{ amount: '4000', status: 'exact', conversion: null }, foreign(), { ...foreign(), amount: null, status: 'unknown' }];
  const target = { recordId: 'rent', field: 'amount' as const, index: 1 }; const draft = fieldDraft(saved, target); draft.value = '1250';
  const operation = fieldOperation(saved, target, draft); const patch = operation.changes.records![0];
  expect(patch.amount).toBeUndefined(); expect(patch.target).toBeUndefined();
  expect(patch.schedule?.amounts).toEqual([saved.facts.records[0].schedule.amounts[0], { ...foreign(), amount: '1250' }, saved.facts.records[0].schedule.amounts[2]]);
  expect(saved.facts.records[0].schedule.amounts[1]).toEqual(foreign());
  const receipt = structuredClone(saved); receipt.facts.records[0].schedule.amounts = structuredClone(patch.schedule!.amounts);
  expect(fieldSaved(receipt, target, operation)).toBe(true);
  receipt.facts.records[0].schedule.amounts![0].amount = '1'; expect(fieldSaved(receipt, target, operation)).toBe(false);
});

it.each(['rate', 'fee', 'rateDate'] as const)('edits %s without reconstructing net INR or unrelated conversion statuses', term => {
  const saved = planningSnapshot(); saved.facts.records[0].amount = { amountPaise: 9951035, status: 'estimate', source: foreign() };
  const target = { recordId: 'rent', field: 'amount' as const, term }; const draft = fieldDraft(saved, target);
  draft.value = term === 'rate' ? '84.12345678' : term === 'fee' ? '300.25' : '2026-09-13';
  const patch = fieldOperation(saved, target, draft).changes.records![0].amount!;
  expect(patch.amount).toBe('1200.25'); expect(patch.status).toBe('estimate');
  expect(patch.conversion).toEqual({ ...foreign().conversion, [term]: draft.value });
  expect(fieldError(draft, target)).toBeNull();
});

it('edits a repeating series start from the actual schedule, never from a computed event date', () => {
  const saved = planningSnapshot(); saved.facts.records[0].schedule = { date: '2026-08-13', recurrence: 'monthly', certainty: 'exact', count: 3 };
  const target = { recordId: 'rent', field: 'schedule.date' as const }; const draft = fieldDraft(saved, target);
  expect(draft.value).toBe('2026-08-13'); expect(saved.plan.events[0].date).toBe('2026-09-13');
  draft.value = '2026-08-14'; draft.status = 'estimate';
  expect(fieldOperation(saved, target, draft).changes.records).toEqual([{ id: 'rent', delete: false, distinct: false, schedule: { date: '2026-08-14', certainty: 'estimate' } }]);
});

it.each(['amount', 'target', 'outstanding'] as const)('keeps debt %s corrections on that source field', field => {
  const saved = planningSnapshot(); const record = saved.facts.records[0]; record.kind = 'debt'; record.target = { amountPaise: 1500000, status: 'exact' }; record.outstanding = { amountPaise: 9000000, status: 'exact' };
  const target = { recordId: record.id, field }; const draft = fieldDraft(saved, target); draft.value = '999';
  expect(fieldOperation(saved, target, draft).changes.records).toEqual([{ id: record.id, delete: false, distinct: false, [field]: { amount: '999', status: 'exact' } }]);
});