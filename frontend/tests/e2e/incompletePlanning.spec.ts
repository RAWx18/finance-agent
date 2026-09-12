// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { browse, cleanup, command, dateAt, test } from './moneySupport';

test('missing rent date still gives a quantified plan in Money and conversation cards', async ({ page, context }, info) => {
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    let saved = await command(page, { type: 'replaceFacts', facts: {
      opening: { amount: '10000', status: 'exact' }, reserve: '0',
      coverage: { income: 'none', essential: 'reviewed', optional: 'none', debt: 'none' },
      records: [
        { id: 'food', label: 'Food', kind: 'essential', autoDebit: false, amount: { amount: '1000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once', certainty: 'exact', basis: 'payment' } },
        { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false, amount: { amount: '30000', status: 'exact' }, schedule: { date: null, recurrence: 'monthly', certainty: 'unknown', basis: 'payment' } },
      ],
    } });
    await page.goto('/money');
    const possibilities = page.getByRole('region', { name: 'Planning possibilities', exact: true });
    await expect(possibilities).toContainText('₹30,000');
    await expect(possibilities).toContainText('-₹21,000');
    await expect(possibilities).toContainText('What-if only');
    expect(saved.facts.records[1].schedule.date).toBeNull();
    expect(saved.plan.firstGap).toBeNull();
    expect(saved.plan.closingPaise).toBe(900000);
    const rent = saved.facts.records.find(record => record.id === 'rent')!;
    saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: saved.revision, records: [{ id: rent.id, delete: false, distinct: false, amount: { amount: '32000', status: 'exact' } }] } });
    await expect(possibilities).toContainText('-₹23,000');
    await page.getByRole('link', { name: 'Conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
    await expect(picture.getByRole('region', { name: 'Planning possibilities' })).toContainText('-₹23,000');
    await expect(picture).not.toContainText('Plan is incomplete');
    await expect(picture.getByRole('listitem', { name: 'Rent', exact: true })).toContainText('Payment date unknown');
    await page.screenshot({ path: info.outputPath('undated-conversation.png'), fullPage: true });
    await page.getByRole('link', { name: 'Money', exact: true }).click();
    await browse(page, '/money/spending');
    await page.getByRole('button', { name: 'Edit Rent', exact: true }).click();
    await page.getByRole('combobox', { name: 'Detail', exact: true }).selectOption('recurrence');
    await page.getByRole('combobox', { name: 'Timing basis', exact: true }).selectOption('dayOfMonth');
    await page.getByRole('spinbutton', { name: 'Day of month', exact: true }).fill('1');
    await page.getByRole('button', { name: 'Save correction', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get('/api/session')).json() as Snapshot).facts.records.find(item => item.id === rent.id)?.schedule.pattern?.kind).toBe('dayOfMonth');
    saved = await (await page.request.get('/api/session')).json() as Snapshot;
    expect(saved.facts.records.find(item => item.id === rent.id)!.schedule.date).toBeNull();
    expect(saved.plan.undatedImpact).toBeNull();
    expect(saved.plan.events.find(item => item.recordId === rent.id)!.dateAssumption).toContain('monthly day 1');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.goto('/money');
    await expect(page.getByRole('region', { name: 'Next money and payments' })).toContainText('Calculated date from your pattern');
    await expect(page.getByRole('region', { name: 'Planning possibilities' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    const rentCard = picture.getByRole('listitem', { name: 'Rent', exact: true });
    await rentCard.getByRole('button', { name: 'Edit Rent series start', exact: true }).click();
    await expect(rentCard.getByRole('button', { name: 'Save Rent series start', exact: true })).toBeDisabled();
    await expect(rentCard).toContainText('Calculated dates are not reported dates.');
    await rentCard.getByRole('combobox', { name: 'Rent series start timing change', exact: true }).selectOption('remove');
    await expect(rentCard).toContainText('whole series');
    await rentCard.getByRole('button', { name: 'Save Rent series start', exact: true }).click();
    await expect(rentCard.getByRole('form')).toHaveCount(0);
    await expect(picture.getByRole('region', { name: 'Planning possibilities' })).toContainText('-₹23,000');
    saved = await (await page.request.get('/api/session')).json() as Snapshot;
    expect(saved.facts.records.find(item => item.id === rent.id)!.schedule.pattern).toBeNull();
    expect(saved.facts.records.find(item => item.id === rent.id)!.schedule.date).toBeNull();
    expect(saved.plan.events.filter(item => item.recordId === rent.id)).toHaveLength(0);
    expect(saved.plan.undatedImpact!.outflowPaise).toBe(3200000);
    await page.getByRole('link', { name: 'Money', exact: true }).click();
    await expect(possibilities).toContainText('-₹23,000');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await cleanup(context); }
});

test('month-end salary stays conditional while its useful comparison is visible', async ({ page, context }, info) => {
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    const saved = await command(page, { type: 'replaceFacts', facts: {
      opening: { amount: '1000', status: 'exact' }, reserve: '0',
      coverage: { income: 'reviewed', essential: 'reviewed', optional: 'none', debt: 'none' },
      records: [
        { id: 'salary', label: 'Salary', kind: 'income', autoDebit: false, reliability: 'reliable', amount: { amount: '30000', status: 'exact' }, schedule: { date: null, recurrence: 'monthly', certainty: 'unknown', basis: 'payment', pattern: { kind: 'monthEnd' } } },
        { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false, amount: { amount: '20000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 20), recurrence: 'once', certainty: 'exact', basis: 'payment' } },
      ],
    } });
    await page.goto('/money');
    expect(saved.plan.reliableIncomePaise).toBe(0);
    expect(saved.plan.closingPaise).toBe(-1900000);
    await expect(page.getByRole('region', { name: 'Planning possibilities' })).toContainText('₹11,000');
    await expect(page.getByRole('region', { name: 'Planning possibilities' })).toContainText('-₹19,000');
    const exportText = await (await page.request.get('/api/session/export')).text();
    expect(exportText).toContain('month-end pattern');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'If expected income arrives' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('conditional-salary.png'), fullPage: true });
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally { await cleanup(context); }
});