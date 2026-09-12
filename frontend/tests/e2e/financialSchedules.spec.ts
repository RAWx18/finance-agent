// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { browse, cleanup, command, dateAt, saveCorrection, test } from './moneySupport';

test.afterEach(async ({ context }) => { await cleanup(context); });

test('foreign income converts source terms and survives variable conversion and reload', async ({ page }, info) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    opening: { amount: '500', status: 'exact' }, coverage: { income: 'reviewed', essential: 'none', optional: 'none', debt: 'none' },
    records: [{ kind: 'income', label: 'Overseas contract', delete: false, distinct: true, reliability: 'reliable',
      amount: { amount: '1000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 3) } }],
  } });
  await page.goto('/money/income');
  await page.getByRole('button', { name: 'Edit Overseas contract', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Correct Overseas contract', exact: true });
  await editor.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('foreign');
  await editor.getByLabel('Currency code', { exact: true }).fill('USD');
  await editor.getByRole('combobox', { name: 'Rate certainty', exact: true }).selectOption('exact');
  await editor.getByLabel('Rate (INR per 1 USD)', { exact: true }).fill('80');
  await editor.getByRole('combobox', { name: 'Deduction certainty', exact: true }).selectOption('exact');
  await editor.getByLabel('INR deduction (₹)', { exact: true }).fill('2000');
  await page.screenshot({ path: info.outputPath('conversion-entry.png'), fullPage: true });
  let saved = await saveCorrection(page);
  expect(saved.facts.records[0].amount.amountPaise).toBe(7800000);
  expect(saved.facts.records[0].amount.source?.amount).toBe('1000.00');
  expect(saved.plan.reliableIncomePaise).toBe(7800000);
  await expect(page.getByRole('listitem', { name: 'Overseas contract', exact: true })).toContainText('USD 1000');
  await expect(page.getByRole('listitem', { name: 'Overseas contract', exact: true })).toContainText('₹78,000.00');
  await page.reload();
  await page.getByRole('button', { name: 'Edit Overseas contract', exact: true }).click();
  await editor.getByRole('combobox', { name: 'Amount pattern', exact: true }).selectOption('variable');
  saved = await saveCorrection(page);
  expect(saved.facts.records[0].amount.source).toBeNull();
  expect(saved.facts.records[0].schedule.amounts?.[0].conversion?.currency).toBe('USD');
  expect(saved.plan.events).toHaveLength(1);
  expect(saved.plan.reliableIncomePaise).toBe(7800000);
  await page.getByRole('button', { name: 'Edit Overseas contract', exact: true }).click();
  await editor.getByRole('combobox', { name: 'Rate certainty', exact: true }).selectOption('estimate');
  saved = await saveCorrection(page);
  expect(saved.plan.reliableIncomePaise).toBe(0);
  expect(saved.plan.uncertainIncomePaise).toBe(7800000);
  await browse(page, '/money/upcoming');
  await expect(page.getByRole('listitem', { name: 'Overseas contract', exact: true })).toContainText('Not counted in balances');
  await page.screenshot({ path: info.outputPath('conditional-conversion.png'), fullPage: true });
});

test('calendar spending budget reveals early shortage and finite variable amounts stay finite', async ({ page }, info) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    opening: { amount: '500', status: 'exact' }, coverage: { income: 'reviewed', essential: 'reviewed', optional: 'none', debt: 'none' },
    records: [
      { kind: 'essential', label: 'Living budget', delete: false, distinct: true, amount: { amount: '3000', status: 'exact' }, schedule: { date: initial.anchorDate, recurrence: 'once' } },
      { kind: 'income', label: 'Salary', delete: false, distinct: true, reliability: 'reliable', amount: { amount: '3000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 8) } },
    ],
  } });
  await page.goto('/money/spending');
  await page.getByRole('button', { name: 'Edit Living budget', exact: true }).click();
  await page.getByRole('combobox', { name: 'Detail', exact: true }).selectOption('recurrence');
  await page.getByRole('combobox', { name: 'Repeats', exact: true }).selectOption('monthlyBudget');
  let saved = await saveCorrection(page);
  expect(saved.plan.firstGap).not.toBeNull();
  expect(saved.plan.firstGap!.date < dateAt(initial.anchorDate, 8)).toBe(true);
  expect(saved.plan.closingPaise).toBeGreaterThan(0);
  expect(saved.plan.events.filter(item => item.amountBasis === 'budget')).toHaveLength(30);
  expect(saved.plan.events.filter(item => item.amountBasis === 'budget').every(item => item.amountStatus === 'estimate')).toBe(true);
  await expect(page.getByRole('listitem', { name: 'Living budget', exact: true })).toContainText('calendar');
  const controls = await Promise.all(['Edit Living budget', 'Remove Living budget', 'Details for Living budget'].map(name => page.getByRole('button', { name, exact: true }).boundingBox()));
  for (let index = 0; index < controls.length; index++) for (const other of controls.slice(index + 1)) {
    const control = controls[index]!;
    expect(control.x + control.width <= other!.x || other!.x + other!.width <= control.x || control.y + control.height <= other!.y || other!.y + other!.height <= control.y).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('monthly-budget.png'), fullPage: true });
  const budget = saved.facts.records.find(item => item.label === 'Living budget')!.id;
  await command(page, { type: 'updateFacts', changes: { expectedRevision: saved.revision,
    records: [{ id: budget, delete: true, distinct: false },
      { kind: 'income', label: 'Contract instalments', delete: false, distinct: true, reliability: 'reliable', schedule: {
        date: initial.anchorDate, recurrence: 'weekly', amounts: [{ amount: '1000', status: 'exact', conversion: null }, { amount: '1500', status: 'exact', conversion: null }, { amount: '800', status: 'exact', conversion: null }],
      } }], coverage: { essential: 'none', income: 'reviewed' },
  } });
  await browse(page, '/money/income');
  await page.getByRole('button', { name: 'Edit Contract instalments', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Correct Contract instalments', exact: true });
  await expect(editor.getByRole('group', { name: 'Occurrence 3', exact: true })).toBeVisible();
  await editor.getByRole('combobox', { name: 'Amount pattern', exact: true }).selectOption('same');
  await editor.getByRole('combobox', { name: 'Amount certainty', exact: true }).selectOption('exact');
  await editor.getByLabel('Amount (₹)', { exact: true }).fill('1200');
  saved = await saveCorrection(page);
  const contract = saved.facts.records.find(item => item.label === 'Contract instalments')!;
  expect(contract.schedule.count).toBe(3);
  expect(contract.schedule.amounts).toEqual([]);
  expect(saved.plan.events.filter(item => item.recordId === contract.id)).toHaveLength(3);
  expect(saved.plan.events.filter(item => item.recordId === contract.id).map(item => item.amountPaise)).toEqual([120000, 120000, 120000]);
  await page.reload();
  await expect(page.getByRole('listitem', { name: 'Contract instalments', exact: true })).toContainText('3 occurrences');
});