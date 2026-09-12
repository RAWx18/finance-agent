// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { cleanup, command, dateAt, test } from './moneySupport';

test('daily reference conversion stays distinct from an explicit bank quote', async ({ page, context }, testInfo) => {
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    const saved = await command(page, { type: 'updateFacts', changes: {
      expectedRevision: initial.revision, opening: { amount: '18000', status: 'exact' },
      coverage: { income: 'none', essential: 'reviewed', optional: 'none', debt: 'none' },
      records: [{ delete: false, distinct: false, kind: 'essential', label: 'Work subscription', autoDebit: true,
        amount: { amount: '20', status: 'exact', conversion: { currency: 'USD', rateStatus: 'unknown', feeStatus: 'unknown', direction: 'payment' } },
        schedule: { recurrence: 'monthly', date: dateAt(initial.anchorDate, 10) },
      }],
    } });
    expect(saved.facts.records[0].amount.source!.amount).toBe('20');
    expect(saved.facts.records[0].amount.amountPaise).toBe(160000);
    expect(saved.facts.records[0].amount.source!.conversion!.provider).toBe('frankfurter');
    await page.goto('/app');
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
    if (saved.plan.decisionAssessment?.outcome?.planReady) await picture.getByRole('button', { name: 'Edit figures', exact: true }).click();
    const subscription = picture.getByRole('listitem', { name: 'Work subscription', exact: true });
    await expect(subscription).toContainText('USD 20');
    await expect(subscription.getByText(/Today’s approximate INR:/)).toContainText('₹1,600.00');
    await expect(subscription).toContainText('excludes unknown conversion fees');
    const repeated = await (await page.request.get('/api/session')).json() as Snapshot;
    expect(repeated.plan.exchangeRates).toEqual(saved.plan.exchangeRates);
    await subscription.getByText('Exchange rate details', { exact: true }).click();
    await expect(subscription).toContainText('Frankfurter reference rates are estimates');
    await subscription.screenshot({ path: testInfo.outputPath('referenceConversion.png') });
    const corrected = await command(page, { type: 'updateFacts', changes: { expectedRevision: saved.revision,
      records: [{ delete: false, distinct: false, id: saved.facts.records[0].id,
        amount: { amount: '20', status: 'exact', conversion: { currency: 'USD', rate: '80', rateStatus: 'exact', fee: '10', feeStatus: 'exact', direction: 'payment' } },
      }],
    } });
    expect(corrected.facts.records).toHaveLength(1);
    expect(corrected.facts.records[0].amount.source!.conversion!.provider).toBeNull();
    expect(corrected.plan.outflowPaise).toBe(161000);
    await expect(subscription).toContainText('USD 20');
    await expect(subscription.getByText(/Current INR:/)).toContainText('₹1,610.00');
    await expect(subscription).not.toContainText('Frankfurter');
    expect((await (await page.request.get('/api/session')).json()).revision).toBe(corrected.revision);
  } finally { await cleanup(context); }
});

test('unavailable reference rate preserves foreign money and exposes conversion retry', async ({ page, context }) => {
  try {
    const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
    const saved = await command(page, { type: 'updateFacts', changes: {
      expectedRevision: initial.revision, opening: { amount: '18000', status: 'exact' },
      records: [{ delete: false, distinct: false, kind: 'essential', label: 'Euro subscription', autoDebit: true,
        amount: { amount: '20', status: 'exact', conversion: { currency: 'EUR', rateStatus: 'unknown', feeStatus: 'unknown', direction: 'payment' } },
        schedule: { recurrence: 'monthly', date: dateAt(initial.anchorDate, 10) },
      }],
    } });
    expect(saved.facts.records[0].amount.source!.amount).toBe('20');
    expect(saved.plan.events[0].amountPaise).toBeNull();
    await page.goto('/app');
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
    const subscription = picture.getByRole('listitem', { name: 'Euro subscription', exact: true });
    await expect(subscription).toContainText('EUR 20');
    await expect(subscription.getByText(/Today’s approximate INR:/)).toContainText('Unknown');
    await expect(subscription).toContainText('Exchange rate unavailable; conversion needs retry');
    await expect(subscription).toContainText('Automatic retry is next day');
    await page.reload();
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await expect(subscription).toContainText('EUR 20');
    await expect(subscription.getByText(/Today’s approximate INR:/)).toContainText('Unknown');
    expect((await (await page.request.get('/api/session')).json()).revision).toBe(saved.revision);
  } finally { await cleanup(context); }
});