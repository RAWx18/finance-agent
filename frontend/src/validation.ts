// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { FactsInput, MoneyInput, RecordInput, Settings } from './api';
import { money, parseAmount } from './money';

export const kinds = ['income', 'essential', 'debt', 'optional'] as const;
export const kindLabels: Record<RecordInput['kind'], string> = {
  income: 'Income', essential: 'Essentials', debt: 'Debt payments', optional: 'Optional spending',
};

export function validateFacts(facts: FactsInput, settings: Settings): Record<string, string> {
  const errors: Record<string, string> = {};
  function amount(id: string, value: MoneyInput) {
    if (value.status === 'unknown' && value.amount === null) return;
    if (value.amount === null || parseAmount(value.amount, settings.maxMoneyPaise) === null) {
      errors[id] = `Enter rupees without commas, up to two decimal places and no more than ${money(settings.maxMoneyPaise)}.`;
    }
  }
  amount('opening', facts.opening);
  if (parseAmount(facts.reserve ?? '0', settings.maxMoneyPaise) === null) errors.reserve = 'Enter a valid reserve in rupees, with up to two decimal places. Use 0 for no floor.';
  if (facts.records.length > settings.maxRecords) errors.records = `Keep no more than ${settings.maxRecords} items.`;
  for (const kind of kinds) {
    const present = facts.records.some((record) => record.kind === kind);
    if (facts.coverage[kind] === 'none' && present) errors[kind] = 'There are items in this category. Review them instead of confirming none.';
    if (facts.coverage[kind] === 'reviewed' && !present) errors[kind] = 'An empty category needs an explicit confirmation of none.';
  }
  for (const record of facts.records) {
    if (!record.label.trim() || Array.from(record.label).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) errors[`${record.id}-label`] = 'Give this item a short, readable name.';
    amount(`${record.id}-amount`, record.amount);
    if (record.target) amount(`${record.id}-target`, record.target);
    if (record.outstanding) amount(`${record.id}-outstanding`, record.outstanding);
    if (record.target?.amount && record.amount.amount) {
      const target = parseAmount(record.target.amount, settings.maxMoneyPaise);
      const required = parseAmount(record.amount.amount, settings.maxMoneyPaise);
      if (target !== null && required !== null && target < required) errors[`${record.id}-target`] = 'The selected target must be at least the required payment.';
    }
    if (record.schedule.date) {
      const date = new Date(`${record.schedule.date}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.schedule.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== record.schedule.date || record.schedule.date.startsWith('0000')) {
        errors[`${record.id}-date`] = 'Enter a valid date or leave it unknown.';
      }
    }
  }
  return errors;
}