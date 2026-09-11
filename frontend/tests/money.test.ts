// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { decimal, draftFacts, lastDate, money, moneyInput, parseAmount } from '../src/money';
import { exactNumbers } from '../src/api';
import { validateFacts } from '../src/validation';
import { settings, snapshot } from './fixtures';

describe('exact money boundaries', () => {
  it('preserves decision and reported provider evidence when converting a saved picture to editable inputs', () => {
    const saved = snapshot();
    saved.facts.decision = { intent: 'specificDecision', concern: 'Can I cover rent before salary?', focusRecordIds: ['rent'], responsePreference: 'brief' };
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
  it('requires explicit none for empty reviewed categories and preserves unknown money', () => {
    const facts = draftFacts(snapshot());
    facts.coverage.income = 'reviewed';
    expect(validateFacts(facts, settings)).toHaveProperty('income');
    facts.coverage.income = 'none';
    expect(validateFacts(facts, settings)).toEqual({});
    facts.opening = { amount: '1.234', status: 'exact' };
    expect(validateFacts(facts, settings)).toHaveProperty('opening');
  });
});