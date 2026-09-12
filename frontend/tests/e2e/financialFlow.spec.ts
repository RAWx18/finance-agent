// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { financialText } from '../../src/money';
import { cleanup, command, dateAt, test } from './moneySupport';

test('qualified cash becomes an actionable gap after a correction and survives reload', async ({ page, context }, info) => {
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    let saved = await command(page, { type: 'replaceFacts', facts: {
      opening: { amount: '10000', status: 'exact' }, reserve: '0',
      coverage: { income: 'none', essential: 'reviewed', optional: 'none', debt: 'none' },
      records: [
        { id: 'food', label: 'Groceries', kind: 'essential', autoDebit: false, amount: { amount: '1000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once', certainty: 'exact' } },
        { id: 'rent', label: 'Rent and utilities', kind: 'essential', autoDebit: false, amount: { amount: '33000', status: 'exact' }, schedule: { date: null, recurrence: 'once', certainty: 'unknown' } },
      ],
    } });
    await page.goto('/money');
    const closing = page.locator('.money-metric-closing');
    await expect(closing).toContainText('₹9,000');
    await expect(closing).toContainText('Excludes Rent and utilities (₹33,000): date unknown.');
    await expect(closing).toContainText('Not a spending allowance');
    const attention = page.getByRole('region', { name: 'What needs attention', exact: true });
    await expect(attention).toContainText(financialText(saved.plan.decisionAssessment!.outcome!.nextStep));
    await expect(attention).not.toContainText('Excludes Rent and utilities');
    await expect(page.locator('.money-overview').getByText('Excludes Rent and utilities (₹33,000): date unknown.', { exact: true })).toHaveCount(1);
    const download = await page.request.get('/api/session/export');
    expect(await download.text()).toContain('Excludes Rent and utilities (INR 33000.00): date unknown.');
    await expect(page.getByRole('link', { name: 'Download saved plan', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('qualified-forecast.png'), fullPage: true });

    saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: saved.revision,
      records: [{ id: 'rent', delete: false, distinct: false, schedule: { date: dateAt(initial.anchorDate, 2), certainty: 'exact' } }],
    } });
    expect(saved.plan.firstGap!.amountPaise).toBe(2400000);
    await expect(attention.getByLabel('First shortfall', { exact: true })).toContainText('₹24,000');
    await expect(closing).toContainText('-₹24,000');
    await expect(closing).not.toContainText('date unknown');
    await expect(attention).toContainText(financialText(saved.plan.decisionAssessment!.outcome!.nextStep));
    await page.reload();
    await expect(attention).toContainText(financialText(saved.plan.decisionAssessment!.outcome!.nextStep));
    await expect(page.locator('.plan-expiry').first()).toContainText('Saved plan available until');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('corrected-plan.png'), fullPage: true });
  } finally { await cleanup(context); }
});

test('same-day timing remains advisory and grocery support does not invent a creditor', async ({ page, context }) => {
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    let saved = await command(page, { type: 'replaceFacts', facts: {
      opening: { amount: '0', status: 'exact' }, reserve: '0',
      coverage: { income: 'reviewed', essential: 'reviewed', optional: 'none', debt: 'none' },
      records: [
        { id: 'salary', label: 'Salary', kind: 'income', autoDebit: false, reliability: 'reliable', amount: { amount: '10000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact' } },
        { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false, amount: { amount: '6000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact' } },
      ],
    } });
    await page.goto('/money');
    const attention = page.getByRole('region', { name: 'What needs attention', exact: true });
    await expect(attention.getByLabel('Timing risk', { exact: true })).toContainText('₹6,000');
    await expect(attention).toContainText('No remaining gap after included income');
    await expect(page.getByRole('img', { name: 'Projected cash over 30 days' })).toHaveAccessibleDescription(/Timing exposure ₹6,000.00.*₹0.00 remains unfunded/);
    expect(saved.workspace!.questions!.some(question => question.id.includes('sameDayTiming'))).toBe(false);
    const exported = await (await page.request.get('/api/session/export')).text();
    expect(exported).toContain('remaining funding gap after included receipts: INR 0.00');
    await page.getByRole('button', { name: 'Check incoming money', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Your next step', exact: true });
    await dialog.getByRole('button', { name: 'I can’t confirm or take this step now' }).click();
    await expect.poll(async () => (await (await page.request.get('/api/session')).json() as Snapshot).revision).toBe(saved.revision + 1);
    await page.reload();
    await expect(attention.getByLabel('Timing risk', { exact: true })).toContainText('₹6,000');

    saved = await command(page, { type: 'replaceFacts', facts: {
      opening: { amount: '100', status: 'exact' }, reserve: '0',
      coverage: { income: 'none', essential: 'reviewed', optional: 'none', debt: 'none' },
      records: [{ id: 'food', label: 'Groceries', kind: 'essential', autoDebit: false, controllability: 'controllable', amount: { amount: '1000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once', certainty: 'exact' } }],
    } });
    await expect(attention).toContainText(financialText(saved.plan.decisionAssessment!.outcome!.nextStep));
    await page.getByRole('button', { name: 'Explore support options', exact: true }).click();
    await expect(dialog).toContainText('Still needs funding; support is not confirmed.');
    await expect(dialog).not.toContainText(/payee declines|creditor|overdue bill/i);
  } finally { await cleanup(context); }
});