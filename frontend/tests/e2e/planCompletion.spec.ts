// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { cleanup, command, dateAt, test } from './moneySupport';

test('qualified plan replaces working cards and recalculates after inline edits', async ({ page, context }, info) => {
  let release: (() => void) | undefined;
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    const saved = await command(page, { type: 'updateFacts', changes: {
      expectedRevision: initial.revision, opening: { amount: '20000', status: 'exact' },
      coverage: { essential: 'reviewed', income: 'none', debt: 'none', optional: 'none' },
      records: [
        { delete: false, distinct: false, kind: 'essential', label: 'Rent', amount: { amount: '8000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 3) } },
        { delete: false, distinct: false, kind: 'essential', label: 'Groceries', amount: { amount: '1000', status: 'exact' }, schedule: { recurrence: 'weekly', basis: 'allowance' } },
      ],
    } });
    expect(saved.plan.decisionAssessment!.outcome!.planReady).toBe(true);
    expect(saved.plan.events.filter(event => event.label === 'Groceries')).toHaveLength(5);
    await page.goto('/app');
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
    const plan = picture.getByRole('article', { name: 'Your 30-day plan', exact: true });
    await expect(plan).toBeVisible();
    await expect(plan.getByLabel('Projected closing cash', { exact: true })).toContainText('₹7,000');
    await expect(picture.getByRole('article', { name: 'Commitments & income' })).toHaveCount(0);
    await plan.getByRole('button', { name: 'Edit figures', exact: true }).click();
    await expect(plan).toHaveCount(0);
    await picture.getByRole('button', { name: 'Edit Groceries amount', exact: true }).click();
    await picture.getByRole('textbox', { name: 'Groceries amount', exact: true }).fill('1500');
    const held = new Promise<void>(resolve => { release = resolve; });
    let pending = true;
    await page.route('**/api/session/commands', async route => {
      if (pending) { pending = false; await held; }
      await route.continue();
    });
    const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
    await picture.getByRole('button', { name: 'Save Groceries amount', exact: true }).click();
    await expect(picture.getByRole('button', { name: 'Save Groceries amount', exact: true })).toBeDisabled();
    await expect(plan).toHaveCount(0);
    release!();
    const result = await response;
    expect(result.ok()).toBe(true);
    const corrected = await result.json() as Snapshot;
    expect(corrected.plan.closingPaise).toBe(450000);
    expect(corrected.facts.records[1].schedule.date).toBeNull();
    expect(corrected.facts.records[1].schedule.basis).toBe('allowance');
    await expect(plan.getByLabel('Projected closing cash', { exact: true })).toContainText('₹4,500');
    await expect(picture.getByRole('form')).toHaveCount(0);

    const incomplete = await command(page, { type: 'updateFacts', changes: { expectedRevision: corrected.revision,
      records: [{ delete: false, distinct: false, kind: 'essential', label: 'Electricity', schedule: { date: dateAt(initial.anchorDate, 4) } }],
    } });
    expect(incomplete.plan.decisionAssessment!.outcome!.planReady).toBe(false);
    await expect(plan).toHaveCount(0);
    await expect(picture.getByRole('article', { name: 'Commitments & income' })).toBeVisible();
    const settled = await command(page, { type: 'updateFacts', changes: { expectedRevision: incomplete.revision,
      decision: { scopeChecked: true }, records: [{ delete: false, distinct: false, id: incomplete.facts.records.at(-1)!.id, amount: { amount: '500', status: 'exact' } }],
    } });
    expect(settled.plan.decisionAssessment!.outcome!.planReady).toBe(true);
    await expect(plan.getByLabel('Projected closing cash', { exact: true })).toContainText('₹4,000');
    await expect(plan.getByRole('button', { name: 'Edit figures', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('finalPlan.png'), fullPage: true });
  } finally { release?.(); await cleanup(context); }
});