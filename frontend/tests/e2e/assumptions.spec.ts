// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Snapshot } from '../../src/api';
import { cardDate } from '../../src/cardFields';
import { dateLabel } from '../../src/money';
import { browse, checkClosing, cleanup, command, correct, dateAt, golden, test } from './moneySupport';

test.describe.configure({ timeout: 55000 });
test.afterEach(async ({ context }) => { await cleanup(context); });

/** Preview a custom spending amount without accepting it into the plan. */
async function preview(page: Page, amount = '0', label = 'Optional purchase') {
  await browse(page, '/money/changes');
  const custom = page.getByRole('button', { name: 'Choose custom changes', exact: true }); if (await custom.isVisible()) await custom.click();
  const edit = page.getByRole('button', { name: 'Edit selections' }); if (await edit.isVisible()) await edit.click();
  const refresh = page.getByRole('button', { name: 'Review refreshed choices' }); if (await refresh.isVisible()) await refresh.click();
  await page.getByRole('button', { name: 'Add a change', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Payment or expense' });
  await select.selectOption((await select.getByRole('option', { name: new RegExp(label) }).getAttribute('value'))!);
  await page.getByLabel('Planned amount (₹)').fill(amount); await page.getByRole('button', { name: 'Add to preview' }).click();
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Preview selected changes' }).click(); expect((await response).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Spending change preview' })).toBeVisible();
}
/** Expand the initially collapsed calculations for both sides of a preview. */
async function calculatedResults(page: Page) {
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  for (const name of ['Before · active plan', 'After · preview']) {
    const section = proposal.getByRole('region', { name, exact: true });
    const more = section.locator('details').filter({ has: page.getByText('More calculated results', { exact: true }) });
    await expect(more).not.toHaveAttribute('open', '');
    await more.locator('summary').click(); await expect(more).toHaveAttribute('open', '');
  }
}
/** Accept the preview and verify its explicit, unconditional consent command. */
async function accept(page: Page) {
  await page.getByRole('checkbox', { name: /I agree to the exact amounts/ }).check();
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept planning assumptions' }).click(); const result = await response;
  expect(result.ok()).toBe(true); const saved = await result.json() as Snapshot;
  expect(result.request().postDataJSON().operation).toEqual({ type: 'acceptPreview', previewId: saved.accepted!.id, confirmed: true, consentScope: 'unconditional' });
  await expect(page.getByRole('heading', { name: 'Spending change preview' })).toHaveCount(0); return saved;
}
test('unknown changeability permits preview but requires a focused correction and fresh consent', async ({ page }) => {
  const baseline = await golden(page); const optional = baseline.facts.records.find(item => item.kind === 'optional')!;
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: optional.id, delete: false, distinct: false, controllability: 'unknown' }] } });
  await preview(page); await expect(page.getByRole('checkbox', { name: /I agree/ })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).accepted).toBeNull();
  await browse(page, '/money/spending'); await correct(page, 'Optional purchase', 'controllability', 'controllable');
  expect((await (await page.request.get('/api/session')).json() as Snapshot).preview).toBeNull();
  await preview(page); const saved = await accept(page);
  expect(saved.accepted?.adjustments[0].acceptanceReady).toBe(true); expect(saved.facts.records.find(item => item.id === optional.id)?.amount.amountPaise).toBe(200000);
});
test('preview keeps the original dated gaps and rejection leaves exports and printing unchanged', async ({ page }) => {
  const baseline = await golden(page); await preview(page);
  const proposal = page.getByRole('region', { name: 'Spending change preview' });
  const before = proposal.getByRole('region', { name: 'Before · active plan' }); const after = proposal.getByRole('region', { name: 'After · preview' });
  await expect(before.getByText('Projected closing cash', { exact: true })).toBeHidden();
  await expect(after.getByText('Assumed closing cash', { exact: true })).toBeHidden();
  await calculatedResults(page);
  await expect(before).toContainText('₹10,000.00'); await expect(after).toContainText('₹12,000.00');
  for (const section of [before, after]) {
    await expect(section.getByLabel('First shortfall', { exact: true })).toHaveText(`₹7,000First shortfall · ${cardDate(dateAt(baseline.anchorDate, 2))}`);
    await expect(section.getByText('Largest cash gap', { exact: true }).locator('..')).toContainText('₹16,000.00'); await expect(section).toContainText(dateLabel(dateAt(baseline.anchorDate, 7)));
  }
  expect(await (await page.request.get('/api/session/export')).text()).not.toContain('reduced planned outflow');
  await page.emulateMedia({ media: 'print' }); await expect(proposal).toBeHidden(); await expect(page.getByRole('article', { name: 'Saved plan for printing' })).toContainText('₹10,000.00'); await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Reject preview' }).click(); await expect(proposal).toHaveCount(0);
  await checkClosing(page, '₹10,000.00');
  const rejected = await (await page.request.get('/api/session')).json() as Snapshot;
  expect(rejected.preview).toBeNull(); expect(rejected.accepted).toBeNull();
  expect({ ...rejected.facts, decision: baseline.facts.decision }).toEqual(baseline.facts);
  expect({ ...rejected.facts.decision, responses: baseline.facts.decision?.responses }).toEqual(baseline.facts.decision);
  expect(rejected.facts.decision?.responses).toEqual([expect.objectContaining({ response: 'declined', dependencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
});
test('accepted changes survive export and reload; restoring requires confirmation and reaches the second tab', async ({ page, context }) => {
  const baseline = await golden(page); await preview(page); const saved = await accept(page);
  expect(saved.facts).toEqual(baseline.facts); expect(saved.plan).toEqual(baseline.plan); expect(saved.accepted?.plan.closingPaise).toBe(1200000);
  await checkClosing(page, '₹12,000.00'); await page.getByRole('button', { name: 'Plan tools' }).click();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download saved plan' }).click();
  const downloaded = await downloadPromise; const text = await readFile((await downloaded.path())!, 'utf8');
  expect(text).toContain('planning assumptions'); expect(text).toContain('reduced planned outflow'); expect(text).toContain('12000.00');
  await page.keyboard.press('Escape'); await page.reload(); await checkClosing(page, '₹12,000.00');
  const second = await context.newPage(); await second.goto('/money'); await checkClosing(second, '₹12,000.00');
  await browse(page, '/money/changes'); await page.getByRole('button', { name: 'Restore reported amounts', exact: true }).click();
  const restore = page.getByRole('dialog', { name: 'Restore reported amounts?', exact: true });
  await expect(restore.getByRole('list', { name: 'Amounts to restore' })).toContainText('Optional purchase');
  await expect(restore).toContainText('₹0.00 Saved → ₹2,000.00 Reported');
  expect((await (await page.request.get('/api/session')).json() as Snapshot).accepted).toEqual(saved.accepted);
  await restore.getByRole('button', { name: 'Keep saved changes', exact: true }).click();
  await expect(restore).toBeHidden(); await checkClosing(page, '₹12,000.00');
  await browse(page, '/money/changes'); await page.getByRole('button', { name: 'Restore reported amounts', exact: true }).click();
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await restore.getByRole('button', { name: 'Restore all reported amounts', exact: true }).click();
  const restored = await response; expect(restored.ok()).toBe(true);
  expect(restored.request().postDataJSON().operation).toEqual({ type: 'clearAccepted' });
  const reported = await restored.json() as Snapshot;
  expect(reported.facts).toEqual(baseline.facts); expect(reported.accepted).toBeNull(); expect(reported.preview).toBeNull();
  await checkClosing(page, '₹10,000.00'); await checkClosing(second, '₹10,000.00');
  expect(await (await page.request.get('/api/session/export')).text()).not.toContain('reduced planned outflow');
  await second.close();
});
test('unrelated corrections retain consent while affected corrections invalidate only their saved change', async ({ page, context }) => {
  const baseline = await golden(page); await preview(page); const retained = await accept(page);
  const second = await context.newPage(); await second.goto('/money'); await checkClosing(second, '₹12,000.00');
  await browse(page, '/money/income'); const corrected = await correct(page, 'Salary', 'amount', '35000');
  expect(corrected.accepted?.adjustments).toEqual(retained.accepted!.adjustments); expect(corrected.accepted?.id).toBe(retained.accepted!.id);
  expect(corrected.accepted?.plan.closingPaise).toBe(1700000); expect(corrected.plan.closingPaise).toBe(1500000);
  expect(corrected.plan.firstGap).toEqual(baseline.plan.firstGap); expect(corrected.accepted?.plan.firstGap).toEqual(corrected.plan.firstGap);
  expect(corrected.plan.peakGapPaise).toBe(baseline.plan.peakGapPaise); expect(corrected.accepted?.plan.peakGapPaise).toBe(corrected.plan.peakGapPaise);
  expect(corrected.invalidatedAssumptions).toEqual([]); expect(corrected.preview).toBeNull();
  await checkClosing(page, '₹17,000.00'); await checkClosing(second, '₹17,000.00');
  await browse(page, '/money/spending'); const invalidated = await correct(page, 'Optional purchase', 'amount', '2500');
  expect(invalidated.accepted).toBeNull(); expect(invalidated.preview).toBeNull(); expect(invalidated.invalidatedAssumptions?.length).toBeGreaterThan(0);
  expect(invalidated.invalidatedAssumptions?.map(item => item.eventId)).toContain(retained.accepted!.adjustments[0].eventId);
  expect(invalidated.plan.closingPaise).toBe(1450000); expect(invalidated.plan.firstGap).toEqual(baseline.plan.firstGap);
  await correct(page, 'Optional purchase', 'controllability', 'committed'); await checkClosing(page, '₹14,500.00'); await checkClosing(second, '₹14,500.00');
  expect(await (await page.request.get('/api/session/export')).text()).not.toContain('reduced planned outflow'); await second.close();
});
test('same-revision replacement requires fresh consent and active sets replace rather than stack', async ({ page, context }) => {
  const baseline = await golden(page); await preview(page); await page.getByRole('checkbox', { name: /I agree/ }).check();
  await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
  const second = await context.newPage(); await second.goto('/money'); await preview(second, '500');
  await calculatedResults(page);
  await expect(page.getByRole('region', { name: 'After · preview' }).getByText('Assumed closing cash', { exact: true }).locator('..')).toContainText('₹11,500.00');
  await expect(page.getByRole('checkbox', { name: /I agree/ })).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).revision).toBe(baseline.revision);
  await accept(page); await checkClosing(page, '₹11,500.00'); await checkClosing(second, '₹11,500.00');
  await preview(second, '1000'); await expect(second.getByRole('region', { name: 'Spending change preview' })).toContainText('changes do not stack');
  await calculatedResults(second);
  await expect(second.getByRole('region', { name: 'Before · active plan' })).toContainText('₹11,500.00');
  await accept(second); await checkClosing(page, '₹11,000.00'); await second.close();
});
test('card reductions respect minimums and leave target and outstanding debt unchanged', async ({ page }) => {
  const baseline = await golden(page, true); await browse(page, '/money/changes');
  await page.getByRole('button', { name: 'Choose custom changes', exact: true }).click(); await page.getByRole('button', { name: 'Add a change', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Payment or expense' }); await expect(select.getByRole('option')).toHaveCount(3);
  await select.selectOption((await select.getByRole('option', { name: /Card/ }).getAttribute('value'))!);
  await expect(page.getByRole('dialog', { name: 'Choose a spending change', exact: true })).toContainText('The required minimum is not payoff. Interest and fees may apply; outstanding debt stays unchanged.');
  await page.getByLabel('Planned amount (₹)').fill('1999.99'); await page.getByRole('button', { name: 'Add to preview' }).click(); await expect(page.getByRole('alert')).toContainText('at least ₹2,000.00');
  await page.getByLabel('Planned amount (₹)').fill('2000'); await page.getByRole('button', { name: 'Add to preview' }).click(); await page.getByRole('button', { name: 'Preview selected changes' }).click();
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toContainText('Required minimum ₹2,000.00 · Reported. Not payoff.');
  await proposal.locator('summary').filter({ hasText: 'Terms for this change' }).click();
  await expect(proposal.getByText('Interest and fees may apply. Outstanding debt is unchanged.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  const saved = await accept(page); expect(saved.facts).toEqual(baseline.facts); await checkClosing(page, '₹10,000.00');
  await browse(page, '/money/debts'); const card = page.getByRole('listitem', { name: 'Card', exact: true });
  await expect(card).toContainText('Required / minimum₹2,000.00'); await expect(card).toContainText('Intended · includes minimum₹4,000.00'); await expect(card).toContainText('Outstanding balance₹20,000.00');
});
test('unknown card target preserves minimum, dated gap and export qualification', async ({ page }) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision, opening: { amount: '100', status: 'exact' }, coverage: { income: 'none', essential: 'none', debt: 'reviewed', optional: 'none' }, records: [{ kind: 'debt', label: 'Card', debtType: 'card', distinct: true, delete: false, amount: { amount: '500', status: 'exact' }, target: { amount: null, status: 'unknown' }, schedule: { date: dateAt(initial.anchorDate, 1), certainty: 'exact', recurrence: 'once' } }] } });
  await page.goto('/money'); await expect(page.getByRole('region', { name: 'What needs attention' })).toContainText('₹400.00');
  await browse(page, '/money/upcoming'); await expect(page.getByRole('list', { name: 'Upcoming events' })).toContainText('Required / minimum only · intended payment unknown');
  await browse(page, '/money/debts'); const card = page.getByRole('listitem', { name: 'Card', exact: true });
  await expect(card.getByText('Required / minimum', { exact: true }).locator('..')).toContainText('₹500.00');
  await expect(card.getByText('Intended · includes minimum', { exact: true }).locator('..')).toContainText('Unknown');
  await expect(card.getByText('Outstanding balance', { exact: true }).locator('..')).toContainText('Not supplied');
  await expect(card).not.toContainText('₹0.00');
  await browse(page, '/money/changes'); await page.getByRole('button', { name: 'Choose custom changes', exact: true }).click(); await expect(page.getByText(/No eligible spending changes/)).toBeVisible();
  const exported = await (await page.request.get('/api/session/export')).text(); expect(exported).toContain('required/minimum only; selected target unknown'); expect(exported).toContain('INR 400.00'); expect(exported).not.toContain('First gap: none');
});