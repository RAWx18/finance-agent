// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import { test } from './authSupport';
import type { Page } from '@playwright/test';
import type { Snapshot, RecordInput } from '../../src/api';
import { kindLabels, kinds } from '../../src/validation';

function dateAt(anchor: string, offset: number) {
  const [year, month, day] = anchor.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

async function addItem(page: Page, kind: RecordInput['kind'], label: string, amount: string, date: string) {
  await page.getByRole('button', { name: 'Add an item' }).click();
  const item = page.getByRole('dialog', { name: 'Edit item', exact: true });
  await expect(item).toBeVisible();
  await item.getByRole('combobox', { name: 'Category', exact: true }).selectOption(kind);
  await item.getByLabel('Item name').fill(label);
  const group = item.getByRole('group', { name: kind === 'debt' ? 'Required / minimum payment' : 'Amount', exact: true });
  await group.getByLabel('How certain?').selectOption('exact');
  await group.getByRole('textbox').fill(amount);
  await item.getByLabel('Next unpaid or future date').fill(date);
}

test.afterEach(async ({ context }) => {
  await context.request.delete('/api/session');
});

test('manual figures → reviewed golden projection → correction → reload → export → delete', async ({ page }) => {
  const request = page.request;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start conversation' })).toBeVisible();
  await page.getByRole('button', { name: 'Prefer typing?' }).click();
  const figures = page.getByRole('region', { name: 'Your figures', exact: true });
  const report = figures.locator('.saved-report');
  await expect(figures).toBeVisible();
  await page.getByRole('button', { name: 'Add figures' }).click();
  await expect(page.getByRole('button', { name: 'Edit figures' })).toBeVisible();
  const initial = await (await request.get('/api/session')).json() as Snapshot;
  await page.getByRole('button', { name: 'Edit figures' }).click();
  const cash = page.getByRole('group', { name: 'Available cash', exact: true });
  await cash.getByLabel('How certain?').selectOption('exact');
  await cash.getByRole('textbox').fill('5000');
  await addItem(page, 'income', 'Salary', '30000', dateAt(initial.anchorDate, 10));
  await page.getByLabel('Income certainty').selectOption('reliable');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await addItem(page, 'essential', 'Rent', '12000', dateAt(initial.anchorDate, 2));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await addItem(page, 'debt', 'Loan', '6000', dateAt(initial.anchorDate, 5));
  await page.getByLabel('Debt type').selectOption('loan');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await addItem(page, 'essential', 'Food', '3000', dateAt(initial.anchorDate, 7));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await addItem(page, 'debt', 'Card', '2000', dateAt(initial.anchorDate, 15));
  await page.getByLabel('Debt type').selectOption('card');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await addItem(page, 'optional', 'Optional purchase', '2000', dateAt(initial.anchorDate, 16));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (const kind of kinds) await page.getByRole('combobox', { name: kindLabels[kind], exact: true }).selectOption('reviewed');
  await page.getByRole('button', { name: 'Save figures' }).click();
  await expect(page.getByRole('region', { name: 'Edit your figures', exact: true })).toHaveCount(0);
  await expect(report).toBeVisible();
  const saved = await (await request.get('/api/session')).json() as Snapshot;
  expect(saved.anchorDate).toBe(initial.anchorDate);
  expect(saved.endDateExclusive).toBe(initial.endDateExclusive);
  expect(saved.plan).toMatchObject({ decisionAssessment: { outcome: { branch: 'gap' } }, closingPaise: 1000000, peakGapPaise: 1600000, firstGap: { date: dateAt(initial.anchorDate, 2), amountPaise: 700000 } });
  expect(saved.plan.peakGapDate).toBe(dateAt(initial.anchorDate, 7));
  expect(saved.facts.records.find(item => item.label === 'Salary')?.reliability).toBe('reliable');
  expect(saved.facts.records.find(item => item.label === 'Loan')?.debtType).toBe('loan');
  expect(saved.facts.records.find(item => item.label === 'Card')?.debtType).toBe('card');
  const action = saved.plan.decisionAssessment!.actions!.find(item => item.id === saved.plan.decisionAssessment!.nextActionId)!;
  await expect(report.getByRole('region', { name: 'Next steps', exact: true })).toContainText(action.question);
  await expect(report.getByText('First cash gap', { exact: true }).locator('..')).toContainText('₹7,000.00');
  await expect(report.getByText('Largest cash gap', { exact: true }).locator('..')).toContainText('₹16,000.00');
  await expect(report.getByText('Projected closing cash', { exact: true }).locator('..')).toContainText('₹10,000.00');
  await report.getByRole('button', { name: 'Understanding cash gaps', exact: true }).click();
  const gaps = page.getByRole('dialog', { name: 'Understanding cash gaps', exact: true });
  await expect(gaps).toContainText('not the sum of daily shortfalls');
  await gaps.getByRole('button', { name: 'Close understanding cash gaps', exact: true }).click();
  await page.getByRole('button', { name: 'Edit figures' }).click();
  await page.getByRole('button', { name: 'Salary Income', exact: true }).click();
  await page.getByRole('group', { name: 'Amount', exact: true }).getByRole('textbox').fill('35000');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Income', exact: true })).toHaveValue('reviewed');
  await page.getByRole('button', { name: 'Overview' }).click();
  await expect(report.getByText('Projected closing cash', { exact: true }).locator('..')).toContainText('₹10,000.00');
  await page.getByRole('button', { name: 'Edit figures' }).click();
  await page.getByRole('button', { name: 'Save figures' }).click();
  await expect(report).toBeVisible();
  await expect(report.getByText('Projected closing cash', { exact: true }).locator('..')).toContainText('₹15,000.00');
  const corrected = await (await request.get('/api/session')).json() as Snapshot;
  expect(corrected.plan.firstGap).toEqual(saved.plan.firstGap);
  expect(corrected.plan.peakGapPaise).toBe(saved.plan.peakGapPaise);
  await page.reload();
  await expect(page).toHaveURL(/\/figures$/);
  await expect(report.getByText('Projected closing cash', { exact: true }).locator('..')).toContainText('₹15,000.00');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download saved projection' }).click();
  expect((await download).suggestedFilename()).toBe('cashflow.txt');
  const exported = await request.get('/api/session/export');
  expect(exported.headers()['content-disposition']).toContain('attachment');
  expect(await exported.text()).toContain('INR 15000.00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Delete plan', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete this plan?', exact: true });
  await expect(deletion).toBeVisible();
  await deletion.getByRole('button', { name: 'Delete saved figures and draft' }).click();
  await expect(page.getByRole('button', { name: 'Add figures' })).toBeVisible();
  expect((await request.get('/api/session')).status()).toBe(404);
  expect(errors).toEqual([]);
});

test('live correction preserves a second-tab draft and requires explicit reconciliation', async ({ page, context }) => {
  const request = context.request;
  await page.goto('/');
  await page.getByRole('button', { name: 'Prefer typing?' }).click();
  await page.getByRole('button', { name: 'Add figures' }).click();
  const figures = page.getByRole('region', { name: 'Your figures', exact: true });
  const report = figures.locator('.saved-report');
  await page.getByRole('button', { name: 'Edit figures' }).click();
  const cash = page.getByRole('group', { name: 'Available cash', exact: true });
  await cash.getByLabel('How certain?').selectOption('exact');
  await cash.getByRole('textbox').fill('100');
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: 'Your figures', exact: true }).click();
  await second.getByRole('button', { name: 'Edit figures' }).click();
  const otherCash = second.getByRole('group', { name: 'Available cash', exact: true });
  await otherCash.getByLabel('How certain?').selectOption('exact');
  await otherCash.getByRole('textbox').fill('200');
  await second.getByRole('button', { name: 'Save figures' }).click();
  await expect(page.getByRole('heading', { name: 'Saved figures changed elsewhere' })).toBeVisible();
  await expect(cash.getByRole('textbox')).toHaveValue('100');
  await expect(page.getByRole('button', { name: 'Save figures' })).toBeDisabled();
  await page.getByRole('button', { name: 'Overview' }).click();
  await expect(report.getByText('Available cash', { exact: true }).locator('..')).toContainText('₹200.00');
  await page.getByRole('button', { name: 'Edit figures' }).click();
  await page.getByRole('button', { name: 'Keep my draft' }).click();
  await page.getByRole('button', { name: 'Save figures' }).click();
  await expect(page.getByRole('region', { name: 'Edit your figures', exact: true })).toHaveCount(0);
  await expect(report).toBeVisible();
  await expect(report.getByText('Available cash', { exact: true }).locator('..')).toContainText('₹100.00');
  const saved = await (await request.get('/api/session')).json() as Snapshot;
  expect(saved.facts.opening.amountPaise).toBe(10000);
  await second.close();
});