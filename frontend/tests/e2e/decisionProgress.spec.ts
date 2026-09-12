// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { cleanup, command, dateAt, test } from './moneySupport';

test('later relief and timing labels stay consistent through a real correction and export', async ({ page, context }, info) => {
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    let saved = await command(page, { type: 'replaceFacts', facts: {
      opening: { amount: '0', status: 'exact' }, reserve: '0',
      coverage: { income: 'reviewed', essential: 'reviewed', optional: 'reviewed', debt: 'none' },
      records: [
        { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false, controllability: 'committed', amount: { amount: '1000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact', basis: 'payment' } },
        { id: 'wages', label: 'Wages', kind: 'income', autoDebit: false, reliability: 'reliable', amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 3), recurrence: 'once', certainty: 'exact', basis: 'payment' } },
        { id: 'purchase', label: 'Purchase', kind: 'optional', autoDebit: false, controllability: 'controllable', amount: { amount: '6000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 4), recurrence: 'once', certainty: 'exact', basis: 'payment' } },
        { id: 'salary', label: 'Salary', kind: 'income', autoDebit: false, reliability: 'reliable', amount: { amount: '10000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 4), recurrence: 'once', certainty: 'exact', basis: 'payment' } },
        { id: 'food', label: 'Food', kind: 'essential', autoDebit: false, amount: { amount: '6000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 6), recurrence: 'once', certainty: 'exact', basis: 'payment' } },
      ],
    } });
    await page.goto('/app');
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
    const cash = picture.getByRole('article', { name: 'Cash & timing', exact: true });
    await expect(cash).toContainText('Largest timing exposure · ₹5,000');
    await expect(cash).toContainText('Needed before same-day income');
    await expect(cash).toContainText('No remaining gap after included income');
    await expect(cash).not.toContainText('Largest shortfall');
    await page.screenshot({ path: info.outputPath('qualifiedTiming.png'), fullPage: true });

    saved = await command(page, { type: 'respondToAction', actionId: saved.plan.decisionAssessment!.nextActionId!, response: 'unavailable' });
    expect(saved.plan.decisionAssessment!.nextActionId).toBe(`preview:purchase:${dateAt(initial.anchorDate, 4)}`);
    const choice = saved.plan.decisionAssessment!.choices!.find(item => item.kind === 'reduceOptional')!;
    expect(choice.metrics!.closingPaise).toBe(500000);
    expect(choice.metrics!.firstGap).toEqual(saved.plan.firstGap);
    expect(saved.accepted).toBeNull();

    await picture.getByRole('button', { name: 'Edit Purchase amount', exact: true }).click();
    await picture.getByRole('textbox', { name: 'Purchase amount', exact: true }).fill('0');
    const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
    await picture.getByRole('button', { name: 'Save Purchase amount', exact: true }).click();
    const correction = await response;
    expect(correction.ok()).toBe(true);
    saved = await correction.json() as Snapshot;
    expect(saved.facts.records).toHaveLength(5);
    expect(saved.plan.closingPaise).toBe(500000);
    expect(saved.plan.firstGap!.amountPaise).toBe(100000);
    await expect(cash).not.toContainText('Largest timing exposure');
    await expect(picture.getByRole('region', { name: 'Financial status', exact: true })).toContainText('₹5,000');

    await page.goto('/money');
    await expect(page.getByRole('region', { name: 'What needs attention', exact: true })).toContainText('₹1,000');
    const exported = await (await page.request.get('/api/session/export')).text();
    expect(exported).toContain('INR 5000.00');
    expect(exported).toContain('INR 1000.00');
    await page.reload();
    await expect(page.locator('.money-metric-closing')).toContainText('₹5,000');
  } finally { await cleanup(context); }
});