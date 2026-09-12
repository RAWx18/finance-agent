// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { AdjustmentOptions, Snapshot } from '../../src/api';
import { browse, checkClosing, cleanup, command, dateAt, golden, saveCorrection, test } from './moneySupport';

test.afterEach(async ({ context }) => { await cleanup(context); });

test('eligible discretionary payments can be selected, edited, previewed and explicitly accepted', async ({ page }) => {
  const initial = await golden(page, true);
  const saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision,
    records: [
      { kind: 'optional', label: 'Cinema', distinct: true, delete: false, amount: { amount: '300', status: 'exact' }, controllability: 'controllable', schedule: { date: dateAt(initial.anchorDate, 17), certainty: 'exact' } },
      { kind: 'optional', label: 'Automatic subscription', distinct: true, delete: false, amount: { amount: '100', status: 'exact' }, autoDebit: true, schedule: { date: dateAt(initial.anchorDate, 18), certainty: 'exact' } },
      { kind: 'optional', label: 'Uncertain outing', distinct: true, delete: false, amount: { amount: '200', status: 'estimate' }, schedule: { date: dateAt(initial.anchorDate, 19), certainty: 'exact' } },
      { kind: 'optional', label: 'Disputed purchase', distinct: true, delete: false, schedule: { date: dateAt(initial.anchorDate, 20), certainty: 'exact' }, conflicts: [{ field: 'amount', values: [
        { id: 'purchase400', amount: '400', status: 'exact' }, { id: 'purchase500', amount: '500', status: 'exact' },
      ] }] },
    ],
  } });
  const options = await (await page.request.get('/api/session/options')).json() as AdjustmentOptions;
  expect(options.revision).toBe(saved.revision);
  expect(options.options.map(item => item.label).sort()).toEqual(['Card', 'Cinema', 'Optional purchase']);
  const exported = await (await page.request.get('/api/session/export')).text();
  await browse(page, '/money/changes');
  await page.getByRole('button', { name: 'Choose payments', exact: true }).click();
  await expect(page.getByText(/No eligible spending changes/)).toHaveCount(0);
  for (const [label, amount] of [['Optional purchase', '500'], ['Cinema', '100']]) {
    await page.getByRole('button', { name: 'Choose a payment', exact: true }).click();
    const select = page.getByRole('combobox', { name: 'Payment or expense' });
    await expect(select.getByRole('option')).toHaveCount(4);
    await select.selectOption(options.options.find(item => item.label === label)!.eventId);
    await page.getByLabel('Planned amount (₹)').fill(amount);
    await page.getByRole('button', { name: 'Add to preview' }).click();
  }
  await page.getByRole('button', { name: 'Edit Optional purchase', exact: true }).click();
  await page.getByLabel('Planned amount (₹)').fill('750.25');
  await page.getByRole('button', { name: 'Add to preview' }).click();
  await expect(page.getByRole('list', { name: 'Selected changes' })).toContainText('Proposed₹750.25');
  expect(await (await page.request.get('/api/session')).json()).toEqual(saved);
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Preview selected changes' }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  const preview = await result.json() as Snapshot;
  expect(preview.revision).toBe(saved.revision);
  expect(preview.facts).toEqual(saved.facts);
  expect(preview.plan).toEqual(saved.plan);
  expect(preview.accepted).toBeNull();
  expect(preview.preview!.adjustments).toHaveLength(2);
  expect(preview.preview!.reducedOutflowPaise).toBe(144975);
  expect(preview.preview!.plan.closingPaise).toBe(saved.plan.closingPaise! + 144975);
  expect(preview.preview!.plan.outflowPaise).toBe(saved.plan.outflowPaise - 144975);
  expect(preview.preview!.plan.firstGap).toEqual(saved.plan.firstGap);
  expect(await (await page.request.get('/api/session/export')).text()).toBe(exported);
  await page.reload();
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toContainText('₹1,449.75 less planned spending');
  await expect(page.getByRole('button', { name: 'Accept changes' })).toBeDisabled();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).accepted).toBeNull();
  await proposal.getByRole('checkbox', { name: /I agree to the exact amounts/ }).check();
  const acceptance = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept changes' }).click();
  const accepted = await acceptance;
  expect(accepted.ok(), await accepted.text()).toBe(true);
  expect(accepted.request().postDataJSON().operation).toEqual({ type: 'acceptPreview', previewId: preview.preview!.id, confirmed: true, consentScope: 'unconditional' });
  const active = await accepted.json() as Snapshot;
  expect(active.revision).toBe(saved.revision + 1);
  expect(active.facts).toEqual(saved.facts);
  expect(active.plan).toEqual(saved.plan);
  expect(active.preview).toBeNull();
  expect(active.accepted!.plan).toEqual(preview.preview!.plan);
  await page.reload();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).accepted).toEqual(active.accepted);
});

test('undated discretionary spending explains the blocker and becomes selectable after an explicit date correction', async ({ page }) => {
  const initial = await golden(page);
  const optional = initial.facts.records.find(item => item.kind === 'optional')!;
  const saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision,
    records: [{ id: optional.id, distinct: false, delete: false, schedule: { date: null, certainty: 'unknown' } }],
  } });
  await page.goto('/money/changes');
  const dates = page.getByRole('region', { name: 'Spending dates to check', exact: true });
  await expect(dates).toContainText('Optional purchase');
  await expect(dates).toContainText('₹2,000.00 · Date unknown');
  await page.getByRole('button', { name: 'Choose payments', exact: true }).click();
  await expect(page.getByText(/No eligible spending changes/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a payment' })).toBeDisabled();
  await dates.getByRole('button', { name: 'Check date for Optional purchase' }).click();
  await page.getByLabel('Date', { exact: true }).fill(dateAt(initial.anchorDate, 16));
  expect(await (await page.request.get('/api/session')).json()).toEqual(saved);
  const corrected = await saveCorrection(page);
  expect(corrected.accepted).toBeNull();
  expect(corrected.facts.records.find(item => item.id === optional.id)!.amount).toEqual(optional.amount);
  await expect(dates).toHaveCount(0);
  await expect(page.getByText(/No eligible spending changes/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose a payment' }).click();
  const select = page.getByRole('combobox', { name: 'Payment or expense' });
  const option = select.getByRole('option', { name: /Optional purchase/ });
  await select.selectOption((await option.getAttribute('value'))!);
  await page.getByLabel('Planned amount (₹)').fill('500');
  await page.getByRole('button', { name: 'Add to preview' }).click();
  await page.getByRole('button', { name: 'Preview selected changes' }).click();
  await expect(page.getByRole('region', { name: 'Spending change preview', exact: true })).toContainText('₹1,500.00 less planned spending');
  await checkClosing(page, '₹10,000.00');
});

test('a plan containing only protected payments has a genuine empty eligible list', async ({ page }) => {
  const initial = await golden(page);
  const optional = initial.facts.records.find(item => item.kind === 'optional')!;
  const saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision,
    records: [{ id: optional.id, distinct: false, delete: false, autoDebit: true }],
  } });
  expect((await (await page.request.get('/api/session/options')).json() as AdjustmentOptions).options).toEqual([]);
  await page.goto('/money/changes');
  await page.getByRole('button', { name: 'Choose payments', exact: true }).click();
  await expect(page.getByText(/No eligible spending changes/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a payment' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Spending dates to check', exact: true })).toHaveCount(0);
  expect(await (await page.request.get('/api/session')).json()).toEqual(saved);
});