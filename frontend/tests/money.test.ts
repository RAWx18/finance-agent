// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { decimal, draftFacts, financialText, lastDate, money, moneyInput, parseAmount } from '../src/money';
import { exactNumbers } from '../src/api';
import { planningSnapshot, settings, snapshot } from './fixtures';

describe('financial text formatting', () => {
  it.each([
    ['Excludes Rent (INR 33000.00): date unknown.', 'Excludes Rent (₹33,000): date unknown.'],
    ['Closing INR -123456.78 on 2026-09-14.', 'Closing -₹1,23,456.78 on 14 Sept 2026.'],
    ['INR 12500.50 and INR 0.01 remain; INR -0.01 is unfunded.', '₹12,500.50 and ₹0.01 remain; -₹0.01 is unfunded.'],
    ['INR 0.00, INR -24000.00 and INR 10000000.', '₹0, -₹24,000 and ₹1,00,00,000.'],
    ['From 2024-02-29 through 2026-10-01.', 'From 29 Feb 2024 through 1 Oct 2026.'],
    ['USD 100.50 · INR deduction unknown · no payment made.', 'USD 100.50 · INR deduction unknown · no payment made.'],
    ['', ''],
  ])('formats %j without changing its meaning', (text, expected) => {
    expect(financialText(text)).toBe(expected);
    expect(financialText(expected)).toBe(expected);
  });
});

describe('exact money boundaries', () => {
  it('preserves date certainty and isolates authoritative conflict candidates in editable drafts', () => {
    const saved = planningSnapshot();
    saved.facts.records[0].schedule.certainty = 'estimate';
    saved.facts = { ...saved.facts, conflicts: [{ id: 'rent:amount', recordId: 'rent', field: 'amount',
      values: [{ id: 'reported', amountPaise: 1200000, status: 'exact' }, { id: 'disputed', amountPaise: 1100000, status: 'estimate' }] }] };
    saved.facts.records[0].amount = { status: 'unknown', amountPaise: null };
    const original = structuredClone(saved);
    const facts = draftFacts(saved);
    expect(facts.records[0].schedule).toEqual(saved.facts.records[0].schedule);
    expect(facts.conflicts).toEqual(saved.facts.conflicts);
    facts.conflicts![0].values[0].amountPaise = 1;
    facts.records[0].schedule.certainty = 'exact';
    expect(saved).toEqual(original);
    saved.facts.records[0].schedule = { date: null, recurrence: 'once', certainty: 'unknown', basis: 'payment' };
    expect(draftFacts(saved).records[0].schedule).toEqual(saved.facts.records[0].schedule);
  });
  it('isolates ambiguous record IDs and nested decision evidence from the canonical picture and other drafts', () => {
    const saved = planningSnapshot();
    saved.facts.records.push({ ...structuredClone(saved.facts.records[0]), id: 'officeRent', label: 'Office rent' });
    saved.facts.decision = { ...saved.facts.decision!, focusRecordIds: ['rent'], ambiguousRecordIds: ['rent', 'officeRent'],
      responses: [{ actionId: 'clarify:opening', response: 'unavailable', dependencyKey: 'opening-basis' }] };
    const original = structuredClone(saved);
    const facts = draftFacts(saved);
    const other = draftFacts(saved);
    expect(facts.decision).toEqual(saved.facts.decision);
    expect(facts.decision!.ambiguousRecordIds).not.toBe(saved.facts.decision.ambiguousRecordIds);
    expect(facts.decision!.responses![0]).not.toBe(saved.facts.decision.responses![0]);
    facts.decision!.ambiguousRecordIds!.splice(0);
    facts.decision!.focusRecordIds!.push('officeRent');
    facts.decision!.responses!.splice(0);
    facts.records[0].amount.amount = '11000.00';
    facts.records[0].schedule.date = '2026-09-14';
    expect(saved).toEqual(original);
    expect(other).toEqual(draftFacts(original));
  });
  it.each([undefined, []])('preserves optional or cleared ambiguity without inventing candidates (%s)', ambiguousRecordIds => {
    const saved = snapshot();
    if (ambiguousRecordIds) saved.facts.decision!.ambiguousRecordIds = ambiguousRecordIds;
    const facts = draftFacts(saved);
    expect(facts.decision).toEqual(saved.facts.decision);
    expect(facts.decision!.ambiguousRecordIds).toEqual(ambiguousRecordIds);
    if (ambiguousRecordIds) expect(facts.decision!.ambiguousRecordIds).not.toBe(ambiguousRecordIds);
  });
  it('preserves decision and reported provider evidence when converting a saved picture to editable inputs', () => {
    const saved = snapshot();
    saved.facts.decision = { intent: 'specificDecision', concern: 'Can I cover rent before salary?', focusRecordIds: ['rent'], responsePreference: 'brief', scopeChecked: false };
    saved.facts.providerResponses = [{ eventId: 'rent:2026-09-13', status: 'reportedTerms', reportedOn: '2026-09-11', paymentDate: '2026-09-20',
      payment: { amountPaise: 123401, status: 'estimate' }, cost: { amountPaise: null, status: 'unknown' }, dependencyKey: 'server-owned' }];
    const facts = draftFacts(saved);
    expect(facts.decision).toEqual(saved.facts.decision);
    expect(facts.providerResponses).toEqual([{ eventId: 'rent:2026-09-13', status: 'reportedTerms', reportedOn: '2026-09-11', paymentDate: '2026-09-20',
      payment: { amount: '1234.01', status: 'estimate' }, cost: { amount: null, status: 'unknown' } }]);
    expect(JSON.stringify(facts)).not.toContain('dependencyKey');
    facts.decision!.focusRecordIds!.push('other');
    expect(saved.facts.decision.focusRecordIds).toEqual(['rent']);
  });
  it('keeps unknown separate from explicit zero', () => {
    expect(moneyInput({ status: 'unknown', amountPaise: null })).toEqual({ status: 'unknown', amount: null });
    expect(moneyInput({ status: 'exact', amountPaise: 0 })).toEqual({ status: 'exact', amount: '0.00' });
    expect(money(null)).toBe('Unknown');
    expect(money(0)).toBe('₹0.00');
    expect(parseAmount('0', settings.maxMoneyPaise)).toBe(0n);
  });
  it('round-trips integer and fractional paise without floating arithmetic', () => {
    for (const value of [0, 1, 101, 1000000000000]) expect(parseAmount(decimal(value), Number.MAX_SAFE_INTEGER)).toBe(BigInt(value));
    expect(decimal(9007199254740991)).toBe('90071992547409.91');
    expect(decimal(-101)).toBe('-1.01');
    expect(money(9007199254740991)).toBe('₹9,00,71,99,25,47,409.91');
    expect(() => decimal(1.1)).toThrow();
    expect(() => JSON.parse('{"amountPaise":9007199254740992}', exactNumbers)).toThrow();
  });
  it.each(['', '1.001', '01', '1e3', '1,000', '-1', '.5', '2.', ' 2', '10000000000.01'])('rejects invalid or over-limit amount %s', (value) => {
    expect(parseAmount(value, settings.maxMoneyPaise)).toBeNull();
  });
  it('converts the exclusive date using UTC components across month and leap boundaries', () => {
    expect(lastDate('2026-10-01')).toBe('2026-09-30');
    expect(lastDate('2024-03-01')).toBe('2024-02-29');
  });
});