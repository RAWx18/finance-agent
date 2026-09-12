// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { moneyRoutes } from '../../src/moneyRoutes';
import type { MoneyRoute } from '../../src/moneyRoutes';
import { browse, checkClosing, cleanup, command, correct, dateAt, golden, saveCorrection, test } from './moneySupport';

test.describe.configure({ timeout: 55000 });
test.afterEach(async ({ context }) => { await cleanup(context); });
test('golden Money projection → focused correction → reload → backend export → delete', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const baseline = await golden(page);
  expect(baseline.plan).toMatchObject({ closingPaise: 1000000, peakGapPaise: 1600000, firstGap: { amountPaise: 700000, date: dateAt(baseline.anchorDate, 2) } });
  expect(baseline.plan.peakGapDate).toBe(dateAt(baseline.anchorDate, 7));
  const assessment = baseline.plan.decisionAssessment!;
  const action = assessment.actions!.find(item => item.id === assessment.nextActionId)!;
  const attention = page.getByRole('region', { name: 'What needs attention' });
  for (const id of action.recordIds) await expect(attention).toContainText(baseline.facts.records.find(item => item.id === id)!.label);
  const check = attention.getByRole('button', { name: 'What to check', exact: true }); await check.click();
  const instructions = page.getByRole('dialog', { name: 'What to check', exact: true });
  await expect(instructions).toContainText(action.question);
  await page.keyboard.press('Escape'); await expect(check).toBeFocused();
  await checkClosing(page, '₹10,000.00'); await browse(page, '/money/income');
  const corrected = await correct(page, 'Salary', 'amount', '35000');
  expect(corrected.plan.closingPaise).toBe(1500000); expect(corrected.plan.firstGap).toEqual(baseline.plan.firstGap);
  expect(corrected.plan.peakGapPaise).toBe(baseline.plan.peakGapPaise);
  expect(corrected.facts.records.filter(item => item.kind !== 'income')).toEqual(baseline.facts.records.filter(item => item.kind !== 'income'));
  expect(corrected.facts.coverage).toEqual(baseline.facts.coverage);
  await page.reload(); await expect(page).toHaveURL(/\/money\/income$/);
  await expect(page.getByRole('listitem', { name: 'Salary', exact: true })).toContainText('₹35,000.00');
  await checkClosing(page, '₹15,000.00'); await page.getByRole('button', { name: 'Plan tools' }).click();
  const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download saved plan' }).click();
  expect((await downloading).suggestedFilename()).toBe('cashflow.txt');
  const exported = await page.request.get('/api/session/export');
  expect(exported.headers()['content-disposition']).toContain('attachment'); expect(await exported.text()).toContain('INR 15000.00');
  await page.getByRole('button', { name: 'Delete plan', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete this plan?' }); await expect(deletion).toContainText('Your account will remain');
  await deletion.getByRole('button', { name: 'Delete plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No plan yet' })).toBeVisible();
  expect((await page.request.get('/api/session')).status()).toBe(404); expect(errors).toEqual([]);
});
test('manual starting cash and a new record use focused patches with unknown amounts', async ({ page }) => {
  await page.goto('/money'); await page.getByRole('button', { name: 'Start a blank plan' }).click();
  await page.getByRole('button', { name: 'Correct starting cash' }).click();
  await page.getByRole('combobox', { name: 'Amount certainty', exact: true }).selectOption('exact'); await page.getByLabel('Amount (₹)').fill('5000');
  const cash = await saveCorrection(page); expect(cash.facts.opening.amountPaise).toBe(500000);
  await browse(page, '/money/spending'); await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await page.getByLabel('Item name').fill('Groceries'); await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('essential');
  const added = await saveCorrection(page); const item = added.facts.records.find(item => item.label === 'Groceries')!;
  expect(item.amount.amountPaise).toBeNull(); expect(item.schedule.date).toBeNull();
  await expect(page.getByRole('listitem', { name: 'Groceries', exact: true })).not.toContainText('₹0.00');
  await correct(page, 'Groceries', 'amount', '1200');
  const dated = await correct(page, 'Groceries', 'schedule.date', dateAt(cash.anchorDate, 2));
  expect(dated.facts.records[0].id).toBe(item.id); expect(dated.plan.firstGap).toBeNull();
});
test('second-tab correction preserves a draft and requires close/reopen rather than overwrite', async ({ page, context }) => {
  const initial = await golden(page); await page.getByRole('button', { name: 'Correct starting cash' }).click(); await page.getByLabel('Amount (₹)').fill('100');
  const second = await context.newPage(); await second.goto('/money');
  await second.getByRole('button', { name: 'Correct starting cash' }).click(); await second.getByLabel('Amount (₹)').fill('200'); await saveCorrection(second);
  await expect(page.getByRole('alert')).toContainText('Close and reopen'); await expect(page.getByLabel('Amount (₹)')).toHaveValue('100');
  await expect(page.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  await page.getByRole('button', { name: /^Close correct cash/ }).click(); await page.getByRole('button', { name: 'Discard correction' }).click();
  await page.getByRole('button', { name: 'Correct starting cash' }).click(); await expect(page.getByLabel('Amount (₹)')).toHaveValue('200.00');
  await page.getByLabel('Amount (₹)').fill('100'); const saved = await saveCorrection(page);
  expect(saved.facts.opening.amountPaise).toBe(10000); expect(saved.anchorDate).toBe(initial.anchorDate); expect(saved.asOf).toBe(initial.asOf); await second.close();
});
test('all shallow routes, history and responsive layouts preserve the session without a microphone', async ({ page }, info) => {
  const requests: string[] = []; page.on('request', request => { if (request.url().endsWith('/api/session/call') && request.method() === 'POST' || /daily\.co|openai\.azure|speech\.microsoft/.test(request.url())) requests.push(request.url()); });
  const initial = await golden(page);
  for (const path of Object.keys(moneyRoutes) as MoneyRoute[]) {
    await browse(page, path); await expect(page).toHaveTitle(`${moneyRoutes[path]} · Cash flow`);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.goBack(); await expect(page).toHaveURL(/\/money\/upcoming$/); await page.goForward(); await expect(page).toHaveURL(/\/money\/changes$/);
  await page.reload(); await expect(page.getByRole('heading', { level: 1, name: 'Plan changes' })).toBeVisible();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).sessionId).toBe(initial.sessionId);
  await browse(page, '/money'); await page.screenshot({ path: info.outputPath('money.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('moneyText200.png'), fullPage: true });
  await page.getByRole('link', { name: 'Continue conversation' }).click(); await expect(page).toHaveURL(/\/app$/); expect(requests).toEqual([]);
});
test('estimated income, undated items and decimal conflict resolution propagate through SSE', async ({ page }) => {
  const baseline = await golden(page); const salary = baseline.facts.records.find(item => item.label === 'Salary')!;
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: salary.id, delete: false, distinct: false, amount: { amount: '30000', status: 'estimate' }, schedule: { certainty: 'estimate' } }, { kind: 'essential', label: 'Unknown utility', distinct: true, delete: false }] } });
  await browse(page, '/money/income'); const income = page.getByRole('listitem', { name: 'Salary', exact: true });
  await expect(income).toContainText('Not included in projected balances');
  await income.getByRole('button', { name: 'Details for Salary' }).click(); await expect(page.getByRole('dialog', { name: 'Details for Salary' })).toContainText('Amount is estimated'); await page.keyboard.press('Escape');
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, conflicts: [{ recordId: salary.id, field: 'amount', values: [{ id: 'a', amount: '30000', status: 'exact' }, { id: 'b', amount: '35000', status: 'exact' }] }] } });
  await income.getByRole('button', { name: 'Details for Salary' }).click(); await page.getByRole('button', { name: 'Resolve Salary · Amount' }).click();
  await page.getByRole('radio', { name: /Report \d+: ₹35,000\.00 · Reported/ }).check();
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm selected report' }).click(); const resolved = await response;
  expect(resolved.ok(), await resolved.text()).toBe(true); expect(resolved.request().postDataJSON().operation.changes.resolutions[0].value).toEqual({ id: 'b', amount: '35000.00', status: 'exact' });
  await page.keyboard.press('Escape'); await expect(income).toContainText('₹35,000.00');
  await browse(page, '/money/upcoming'); await page.getByRole('button', { name: '1 items without dates' }).click();
  await expect(page.getByRole('dialog')).toContainText('Unknown utility'); await page.keyboard.press('Escape');
  await browse(page, '/money/spending'); await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.getByText('4 of 4 items', { exact: true })).toBeVisible();
  const utility = page.getByRole('listitem', { name: 'Unknown utility', exact: true });
  await expect(utility).toContainText('Unknown'); await expect(utility).not.toContainText('₹0.00');
});

test('debt corrections keep minimum, intended payment and outstanding balance distinct, including unknowns', async ({ page }) => {
  const baseline = await golden(page, true); await browse(page, '/money/debts');
  const card = page.getByRole('listitem', { name: 'Card', exact: true });
  const minimum = card.getByText('Required / minimum', { exact: true }).locator('..');
  const target = card.getByText('Intended · includes minimum', { exact: true }).locator('..');
  const outstanding = card.getByText('Outstanding balance', { exact: true }).locator('..');
  await expect(minimum).toContainText('₹2,000.00'); await expect(target).toContainText('₹4,000.00'); await expect(outstanding).toContainText('₹20,000.00');
  const details = card.getByRole('button', { name: 'Details for Card', exact: true }); await details.click();
  await expect(page.getByRole('dialog', { name: 'Details for Card', exact: true })).toContainText('The intended payment includes the minimum, not an extra payment.');
  await page.keyboard.press('Escape'); await expect(details).toBeFocused();
  const intended = await correct(page, 'Card', 'target', '4500.25');
  expect(intended.plan.closingPaise).toBe(749975); expect(intended.plan.firstGap).toEqual(baseline.plan.firstGap);
  expect(intended.facts.records.find(record => record.label === 'Card')).toMatchObject({
    amount: { status: 'exact', amountPaise: 200000 }, target: { status: 'exact', amountPaise: 450025 }, outstanding: { status: 'exact', amountPaise: 2000000 },
  });
  const balance = await correct(page, 'Card', 'outstanding', '25000.75');
  expect(balance.plan.events).toEqual(intended.plan.events); expect(balance.plan.closingPaise).toBe(749975);
  await expect(minimum).toContainText('₹2,000.00'); await expect(target).toContainText('₹4,500.25'); await expect(outstanding).toContainText('₹25,000.75');
  const edit = card.getByRole('button', { name: 'Edit Card', exact: true }); await edit.click();
  await page.getByRole('combobox', { name: 'Detail', exact: true }).selectOption('outstanding');
  await page.getByRole('combobox', { name: 'Amount certainty', exact: true }).selectOption('unknown');
  await expect(page.getByLabel('Amount (₹)')).toBeDisabled(); const unknown = await saveCorrection(page); await expect(edit).toBeFocused();
  expect(unknown.facts.records.find(record => record.label === 'Card')?.outstanding).toEqual({ status: 'unknown', amountPaise: null });
  expect(unknown.plan.closingPaise).toBe(749975); await expect(outstanding).toContainText('Unknown'); await expect(outstanding).not.toContainText('₹0.00');
  expect(unknown.facts.records.filter(record => record.label !== 'Card')).toEqual(baseline.facts.records.filter(record => record.label !== 'Card'));
  await page.reload(); await expect(outstanding).toContainText('Unknown'); await expect(target).toContainText('₹4,500.25');
  const exported = await page.request.get('/api/session/export'); expect(exported.ok()).toBe(true); expect(await exported.text()).toContain('INR 7499.75');
});