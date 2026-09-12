// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { browse, cleanup, command, correct, dateAt, golden, saveCorrection, test } from './moneySupport';

test.afterEach(async ({ context }) => { await cleanup(context); });

test('consumer overview shows timing risk and follows real corrections across category pages', async ({ page }, info) => {
  const saved = await golden(page);
  const metrics = page.getByRole('region', { name: 'Money in this plan' });
  const attention = page.getByRole('region', { name: 'What needs attention' });
  const chart = page.getByRole('img', { name: 'Projected cash over 30 days' });
  await expect(metrics).toContainText('Starting cash₹5,000');
  await expect(metrics).toContainText('Money coming in₹30,000');
  await expect(metrics).toContainText('Money going out₹25,000');
  await expect(metrics).toContainText('Left at the end₹10,000');
  await expect(attention).toContainText('Largest shortfall ₹16,000');
  await expect(chart).toHaveAccessibleDescription(/First shortfall ₹7,000.00/);
  await expect(page.getByRole('region', { name: 'Next money and payments' }).getByRole('listitem')).toHaveCount(4);
  const text = await page.locator('.money-overview').innerText();
  expect(text).not.toMatch(/category coverage|partial calculation|qualified outlook/i);
  expect(text.trim().split('\n').at(-1)).not.toBe('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info.project.name === 'desktop') {
    await expect(page.getByRole('button', { name: 'View calculation' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('listitem', { name: 'Salary', exact: true })).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({ path: info.outputPath('overview.png'), fullPage: true });
  const zero = await page.locator('.money-chart-zero').getAttribute('y1');
  const edit = page.getByRole('button', { name: 'Correct starting cash' });
  await edit.focus(); await page.keyboard.press('Enter');
  await page.getByLabel('Amount (₹)').fill('10000');
  const corrected = await saveCorrection(page);
  expect(corrected.plan.firstGap?.amountPaise).toBe(200000);
  await expect(metrics).toContainText('Starting cash₹10,000');
  await expect(metrics).toContainText('Left at the end₹15,000');
  await expect(attention).toContainText('₹2,000 short');
  await expect(chart).toHaveAccessibleDescription(/First shortfall ₹2,000.00/);
  expect(await page.locator('.money-chart-zero').getAttribute('y1')).not.toBe(zero);
  await expect(edit).toBeFocused();
  await browse(page, '/money/income');
  const earlier = await correct(page, 'Salary', 'schedule.date', dateAt(saved.anchorDate, 1));
  expect(earlier.plan.firstGap).toBeNull();
  await browse(page, '/money/spending');
  await expect(page.getByRole('heading', { name: 'Rent', exact: true })).toBeVisible();
  await browse(page, '/money/debts');
  await expect(page.getByRole('heading', { name: 'Loan', exact: true })).toBeVisible();
  await browse(page, '/money');
  await expect(chart).toHaveAccessibleDescription(/No shortfall in the dated figures/);
  await page.getByRole('button', { name: 'View calculation' }).click();
  await expect(page.getByRole('dialog', { name: 'Plan details' })).toContainText('Starting cash + included income');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'View calculation' })).toBeFocused();
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.money-flow-footer > span').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(160);
    expect(await page.locator('.money-metric dd').evaluateAll(elements => elements.every(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => rect.y)).size === 1;
    }))).toBe(true);
    await page.screenshot({ path: info.outputPath('overview-320-text200.png'), fullPage: true });
    await edit.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /^Correct cash on / });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Escape'); await expect(edit).toBeFocused();
  }
});

test('unknown cash, excluded estimates and cash-buffer-only risk remain distinct', async ({ page }, info) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  await page.goto('/money');
  await expect(page.getByRole('region', { name: 'Money in this plan' })).toContainText('Starting cashUnknown');
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add starting cash' })).toBeVisible();
  await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision,
    opening: { amount: '5000', status: 'exact' }, reserve: '4000',
    coverage: { income: 'reviewed', essential: 'reviewed', debt: 'none', optional: 'none' },
    records: [
      { label: 'Rent', kind: 'essential', distinct: true, delete: false, amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact' } },
      { label: 'Freelance income', kind: 'income', distinct: true, delete: false, reliability: 'uncertain', amount: { amount: '8000', status: 'estimate' }, schedule: { date: dateAt(initial.anchorDate, 4), recurrence: 'once', certainty: 'estimate' } },
    ],
  } });
  await expect(page.getByRole('region', { name: 'What needs attention' })).toContainText('Your cash buffer is at risk');
  await expect(page.getByRole('region', { name: 'What needs attention' })).toContainText('₹1,000 below your ₹4,000 buffer');
  await expect(page.getByRole('region', { name: 'Money in this plan' })).toContainText('Left at the end₹3,000');
  await expect(page.getByText('₹8,000 uncertain income not included')).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Freelance income' })).toContainText('Not included · unconfirmed · Estimated');
  await expect(page.getByRole('img')).toHaveAccessibleDescription(/Projected closing cash ₹3,000.00/);
  await page.screenshot({ path: info.outputPath('overview-buffer.png'), fullPage: true });
});