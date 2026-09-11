// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './authSupport';
import type { Page } from '@playwright/test';
import type { FactsInput, Snapshot } from '../../src/api';
import { dateLabel, draftFacts } from '../../src/money';

function dateAt(anchor: string, offset: number) {
  const [year, month, day] = anchor.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

function metric(page: Page, label: string) {
  return page.getByRole('region', { name: 'Your figures', exact: true, includeHidden: true }).locator('.saved-report .metrics, .saved-report .gap-summary')
    .getByText(label, { exact: true }).locator('..');
}

async function setup(page: Page, cardTarget = false) {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  const records: FactsInput['records'] = [
    { id: 'salary', label: 'Salary', kind: 'income', autoDebit: false, amount: { status: 'exact', amount: '30000' }, schedule: { date: dateAt(initial.anchorDate, 10), recurrence: 'once' }, reliability: 'reliable' },
    { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false, amount: { status: 'exact', amount: '12000' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once' } },
    { id: 'loan', label: 'Loan', kind: 'debt', autoDebit: false, debtType: 'loan', amount: { status: 'exact', amount: '6000' }, schedule: { date: dateAt(initial.anchorDate, 5), recurrence: 'once' } },
    { id: 'food', label: 'Food', kind: 'essential', autoDebit: false, amount: { status: 'exact', amount: '3000' }, schedule: { date: dateAt(initial.anchorDate, 7), recurrence: 'once' } },
    { id: 'card', label: 'Card', kind: 'debt', autoDebit: false, debtType: 'card', controllability: 'controllable', amount: { status: 'exact', amount: '2000' }, schedule: { date: dateAt(initial.anchorDate, 15), recurrence: 'once' }, ...(cardTarget ? { target: { status: 'exact' as const, amount: '4000' }, outstanding: { status: 'exact' as const, amount: '20000' } } : {}) },
    { id: 'optional', label: 'Optional purchase', kind: 'optional', autoDebit: false, controllability: 'controllable', amount: { status: 'exact', amount: '2000' }, schedule: { date: dateAt(initial.anchorDate, 16), recurrence: 'once' } },
  ];
  const response = await page.request.post('/api/session/commands', { data: { commandId: randomUUID(), expectedRevision: initial.revision,
    operation: { type: 'replaceFacts', facts: { opening: { status: 'exact', amount: '5000' }, reserve: '0', records,
      coverage: { income: 'reviewed', essential: 'reviewed', debt: 'reviewed', optional: 'reviewed' } } } } });
  expect(response.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Your figures', exact: true }).click();
  await expect(metric(page, 'Projected closing cash')).toBeVisible();
  await expect(metric(page, 'Projected closing cash')).toContainText(cardTarget ? '₹8,000.00' : '₹10,000.00');
  return await response.json() as Snapshot;
}

async function preview(page: Page, amount = '0', label = 'Optional purchase') {
  await page.getByRole('button', { name: 'Spending changes', exact: true }).click();
  const edit = page.getByRole('button', { name: 'Edit selections', exact: true });
  if (await edit.isVisible()) await edit.click();
  const refresh = page.getByRole('button', { name: 'Review refreshed choices' });
  if (await refresh.isVisible()) await refresh.click();
  await page.getByRole('button', { name: 'Add a change', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Payment or expense' });
  const value = await select.getByRole('option', { name: new RegExp(label) }).getAttribute('value');
  await select.selectOption(value!);
  await page.getByLabel('Planned amount (₹)').fill(amount);
  await page.getByRole('button', { name: 'Add to preview' }).click();
  const response = page.waitForResponse((response) => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Preview selected changes' }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Spending change preview' })).toBeVisible();
}

async function accept(page: Page) {
  await page.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }).check();
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept planning assumptions' }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  const saved = await result.json() as Snapshot;
  expect(result.request().postDataJSON().operation).toEqual({ type: 'acceptPreview', previewId: saved.accepted!.id, confirmed: true, consentScope: 'unconditional' });
  await expect(page.getByRole('heading', { name: 'Spending change preview' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved planning assumptions', exact: true })).toBeVisible();
  return saved;
}

test.afterEach(async ({ context }) => { await context.request.delete('/api/session'); });

test('unknown changeability can be previewed but needs a saved correction before unconditional acceptance', async ({ page }) => {
  const baseline = await setup(page);
  const facts = draftFacts(baseline);
  facts.records.find(item => item.id === 'optional')!.controllability = 'unknown';
  const correction = await page.request.post('/api/session/commands', { data: { commandId: randomUUID(), expectedRevision: baseline.revision,
    operation: { type: 'replaceFacts', facts } } });
  expect(correction.ok()).toBe(true);
  await page.reload();
  await expect(page).toHaveURL(/\/figures$/);
  await expect(metric(page, 'Projected closing cash')).toBeVisible();
  await preview(page);
  await expect(page.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).accepted).toBeNull();
  await page.getByRole('button', { name: 'Edit figures' }).click();
  await page.getByRole('button', { name: 'Optional purchase Optional spending', exact: true }).click();
  await page.getByLabel('Can this spending change?').selectOption('controllable');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Optional spending', exact: true })).toHaveValue('reviewed');
  await page.getByRole('button', { name: 'Save figures' }).click();
  await expect(page.getByRole('region', { name: 'Edit your figures', exact: true })).toHaveCount(0);
  await expect(metric(page, 'Projected closing cash')).toBeVisible();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).preview).toBeNull();
  await preview(page);
  await accept(page);
  const saved = await (await page.request.get('/api/session')).json() as Snapshot;
  expect(saved.accepted?.adjustments[0].acceptanceReady).toBe(true);
  expect(saved.facts.records.find(item => item.id === 'optional')!.amount.amountPaise).toBe(200000);
});

test('undated rent remains prominent beside the canonical date question, not spendable closing cash', async ({ page }) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  const response = await page.request.post('/api/session/commands', { data: { commandId: randomUUID(), expectedRevision: initial.revision,
    operation: { type: 'replaceFacts', facts: { opening: { amount: '10000', status: 'exact' }, reserve: '0',
      coverage: { income: 'none', essential: 'reviewed', optional: 'none', debt: 'none' },
      records: [{ id: 'rent', label: 'Rent', kind: 'essential', amount: { amount: '12000', status: 'exact' }, schedule: { date: null, recurrence: 'monthly' } }] } } } });
  expect(response.ok()).toBe(true);
  const saved = await response.json() as Snapshot;
  const assessment = saved.plan.decisionAssessment!;
  const question = assessment.uncertainties!.find(item => item.id === assessment.nextQuestionId)!;
  expect(question.field).toBe('schedule.date');
  await page.goto('/');
  await page.getByRole('button', { name: /Review saved picture/ }).click();
  const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
  await expect(picture.getByRole('region', { name: 'Next steps' })).toContainText(question.question);
  await expect(picture.getByText(/These balances are not available to spend/)).toBeVisible();
  await picture.getByRole('button', { name: 'Missing amounts or dates' }).click();
  const unresolved = page.getByRole('dialog', { name: 'Missing amounts or dates' });
  await expect(unresolved.getByRole('list', { name: 'Unresolved amounts and dates' })).toContainText('Rent');
  await expect(unresolved.getByRole('list', { name: 'Unresolved amounts and dates' })).toContainText('₹12,000.00');
  await unresolved.getByRole('button', { name: 'Close missing amounts or dates' }).click();
  await expect(picture.getByRole('heading', { name: 'Known commitments look covered' })).toHaveCount(0);
});

test('reported baseline → preview/reject → accept/export/reload → clear → accept → correction', async ({ page, context }) => {
  const baseline = await setup(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const steps = page.getByRole('region', { name: 'Next steps', exact: true });
  const assessment = baseline.plan.decisionAssessment!;
  await expect(steps).toContainText(assessment.actions!.find(action => action.id === assessment.nextActionId)!.question);
  await preview(page);
  const comparison = page.getByRole('region', { name: 'Spending change preview' });
  const before = comparison.getByRole('region', { name: 'Before · reported figures', exact: true });
  const after = comparison.getByRole('region', { name: 'After · preview', exact: true });
  await expect(before.getByText('Projected closing cash', { exact: true }).locator('..')).toContainText('₹10,000.00');
  await expect(after.getByText('Assumed closing cash', { exact: true }).locator('..')).toContainText('₹12,000.00');
  for (const values of [before, after]) {
    await expect(values.getByText('First cash gap', { exact: true }).locator('..')).toContainText('₹7,000.00');
    await expect(values.getByText('First cash gap', { exact: true }).locator('..')).toContainText(dateLabel(dateAt(baseline.anchorDate, 2)));
    await expect(values.getByText('Largest cash gap', { exact: true }).locator('..')).toContainText('₹16,000.00');
    await expect(values.getByText('Largest cash gap', { exact: true }).locator('..')).toContainText(dateLabel(dateAt(baseline.anchorDate, 7)));
  }
  await expect(metric(page, 'Projected closing cash')).toBeHidden();
  await expect(comparison).toContainText('Not saved or included in downloads.');
  expect(await (await page.request.get('/api/session/export')).text()).not.toContain('reduced planned outflow');
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('region', { name: 'Spending changes', exact: true })).toBeHidden();
  await expect(metric(page, 'Projected closing cash')).toBeVisible();
  await expect(metric(page, 'Projected closing cash')).toContainText('₹10,000.00');
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Reject preview' }).click();
  await expect(comparison).toHaveCount(0);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(metric(page, 'Projected closing cash')).toContainText('₹10,000.00');
  await preview(page);
  await accept(page);
  await expect(metric(page, 'Assumed closing cash')).toContainText('₹12,000.00');
  await expect(metric(page, 'First cash gap')).toContainText('₹7,000.00');
  await expect(metric(page, 'Largest cash gap')).toContainText('₹16,000.00');
  await expect(page.getByText('With saved assumptions', { exact: true })).toBeVisible();
  const saved = await (await page.request.get('/api/session')).json() as Snapshot;
  expect(saved.facts).toEqual(baseline.facts);
  expect(saved.plan).toEqual(baseline.plan);
  expect(saved.accepted?.plan.closingPaise).toBe(1200000);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download saved projection' }).click();
  const download = await downloadPromise;
  const exported = await readFile((await download.path())!, 'utf8');
  expect(exported).toContain('planning assumptions');
  expect(exported).toContain('reduced planned outflow');
  expect(exported).toContain('12000.00');
  await page.reload();
  await expect(page).toHaveURL(/\/figures$/);
  await expect(metric(page, 'Assumed closing cash')).toContainText('₹12,000.00');
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: 'Your figures', exact: true }).click();
  await expect(metric(second, 'Assumed closing cash')).toContainText('₹12,000.00');
  await page.getByRole('link', { name: 'Back to conversation', exact: true }).click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('region', { name: 'Saved planning assumptions', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Spending changes', exact: true })).toBeHidden();
  await expect(page.getByRole('list', { name: 'Saved items', exact: true }).getByRole('listitem')).toHaveCount(baseline.facts.records.length);
  await expect(page.getByRole('list', { name: 'Dated cash flow events', exact: true }).getByRole('listitem')).toHaveCount(saved.accepted!.plan.events.length);
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Your figures', exact: true }).click();
  await page.getByRole('button', { name: 'Spending changes', exact: true }).click();
  await page.getByRole('button', { name: 'Clear saved assumptions' }).click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(metric(page, 'Projected closing cash')).toContainText('₹10,000.00');
  await expect(metric(second, 'Projected closing cash')).toContainText('₹10,000.00');
  expect(await (await page.request.get('/api/session/export')).text()).not.toContain('reduced planned outflow');
  await preview(page);
  const beforeCorrection = await accept(page);
  await page.getByRole('button', { name: 'Edit figures' }).click();
  await expect(page.getByText('Saving clears the preview. Changes affecting saved assumptions need fresh consent.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Salary Income', exact: true }).click();
  await page.getByRole('group', { name: 'Amount', exact: true }).getByRole('textbox').fill('35000');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Income', exact: true })).toHaveValue('reviewed');
  await page.getByRole('button', { name: 'Save figures' }).click();
  await expect(metric(page, 'Assumed closing cash')).toBeVisible();
  await expect(metric(page, 'Assumed closing cash')).toContainText('₹17,000.00');
  await expect(metric(second, 'Assumed closing cash')).toContainText('₹17,000.00');
  await expect(page.getByRole('region', { name: 'Saved planning assumptions', exact: true })).toBeVisible();
  const corrected = await (await page.request.get('/api/session')).json() as Snapshot;
  expect(corrected.accepted?.adjustments).toEqual(beforeCorrection.accepted!.adjustments);
  expect(corrected.accepted?.id).toBe(beforeCorrection.accepted!.id);
  expect(corrected.accepted?.plan.closingPaise).toBe(1700000);
  expect(corrected.invalidatedAssumptions).toEqual([]);
  expect(corrected.preview).toBeNull();
  expect(corrected.plan.closingPaise).toBe(1500000);
  expect(corrected.plan.firstGap).toEqual(baseline.plan.firstGap);
  expect(corrected.accepted?.plan.firstGap).toEqual(corrected.plan.firstGap);
  expect(corrected.plan.peakGapPaise).toBe(baseline.plan.peakGapPaise);
  expect(corrected.accepted?.plan.peakGapPaise).toBe(corrected.plan.peakGapPaise);
  expect(await (await page.request.get('/api/session/export')).text()).toContain('reduced planned outflow');
  await page.getByRole('button', { name: 'Edit figures' }).click();
  await page.getByRole('button', { name: 'Optional purchase Optional spending', exact: true }).click();
  await page.getByRole('group', { name: 'Amount', exact: true }).getByRole('textbox').fill('2500');
  await page.getByLabel('Can this spending change?').selectOption('committed');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('combobox', { name: 'Optional spending', exact: true }).selectOption('reviewed');
  await page.getByRole('button', { name: 'Save figures' }).click();
  await expect(metric(page, 'Projected closing cash')).toBeVisible();
  await expect(metric(page, 'Projected closing cash')).toContainText('₹14,500.00');
  await expect(metric(second, 'Projected closing cash')).toContainText('₹14,500.00');
  await expect(page.getByRole('region', { name: 'Saved planning assumptions', exact: true })).toHaveCount(0);
  const invalidated = await (await page.request.get('/api/session')).json() as Snapshot;
  expect(invalidated.accepted).toBeNull();
  expect(invalidated.preview).toBeNull();
  expect(invalidated.invalidatedAssumptions!.length).toBeGreaterThan(0);
  expect(invalidated.invalidatedAssumptions!.map(item => item.eventId)).toContain(beforeCorrection.accepted!.adjustments[0].eventId);
  expect(invalidated.plan.closingPaise).toBe(1450000);
  expect(invalidated.plan.firstGap).toEqual(baseline.plan.firstGap);
  expect(await (await page.request.get('/api/session/export')).text()).not.toContain('reduced planned outflow');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await second.close();
});

test('another tab replaces a same-revision preview; acceptance requires review of that exact replacement', async ({ page, context }) => {
  const baseline = await setup(page);
  await preview(page);
  await page.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }).check();
  await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: 'Your figures', exact: true }).click();
  await preview(second, '500');
  await expect(page.getByRole('region', { name: 'Spending change preview' })).toContainText('₹11,500.00');
  await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).revision).toBe(baseline.revision);
  await accept(page);
  await expect(metric(page, 'Assumed closing cash')).toContainText('₹11,500.00');
  await second.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(metric(second, 'Assumed closing cash')).toContainText('₹11,500.00');
  await preview(second, '1000');
  await expect(second.getByRole('region', { name: 'Spending change preview' })).toContainText('changes do not stack');
  await expect(second.getByRole('region', { name: 'Spending change preview' })).toContainText('₹11,000.00');
  await accept(second);
  await expect(metric(page, 'Assumed closing cash')).toContainText('₹11,000.00');
  await second.close();
});

test('card changes respect the server minimum, active consent, and unchanged outstanding debt', async ({ page }) => {
  await setup(page, true);
  await page.getByRole('button', { name: 'Spending changes', exact: true }).click();
  await page.getByRole('button', { name: 'Add a change', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Payment or expense' });
  await expect(select.getByRole('option')).toHaveCount(3);
  const value = await select.getByRole('option', { name: /Card/ }).getAttribute('value');
  await select.selectOption(value!);
  await page.getByLabel('Planned amount (₹)').fill('1999.99');
  await page.getByRole('button', { name: 'Add to preview' }).click();
  await expect(page.getByRole('alert')).toContainText('at least ₹2,000.00');
  await page.getByLabel('Planned amount (₹)').fill('2000');
  await page.getByRole('button', { name: 'Add to preview' }).click();
  await page.getByRole('button', { name: 'Preview selected changes' }).click();
  await expect(page.getByRole('region', { name: 'Spending change preview' })).toContainText('Minimum is not payoff');
  await expect(page.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  await accept(page);
  await expect(metric(page, 'Assumed closing cash')).toContainText('₹10,000.00');
  const card = page.getByRole('list', { name: 'Saved items' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Card', exact: true }) });
  await expect(card).toContainText('Outstanding: ₹20,000.00');
  await expect(card).toContainText('Selected target: ₹4,000.00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an unknown card target keeps its reported minimum and dated shortfall visible', async ({ page }) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  const response = await page.request.post('/api/session/commands', { data: {
    commandId: randomUUID(), expectedRevision: initial.revision, operation: { type: 'replaceFacts', facts: {
      opening: { amount: '100', status: 'exact' }, reserve: '0',
      coverage: { income: 'none', essential: 'none', debt: 'reviewed', optional: 'none' },
      records: [{ id: 'card', label: 'Card', kind: 'debt', debtType: 'card', autoDebit: false,
        amount: { amount: '500', status: 'exact' }, target: { amount: null, status: 'unknown' },
        schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once' } }],
    } },
  } });
  expect(response.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Your figures', exact: true }).click();
  await expect(metric(page, 'First cash gap')).toBeVisible();
  await expect(metric(page, 'First cash gap')).toContainText('₹400.00');
  await expect(page.getByRole('list', { name: 'Dated cash flow events' })).toContainText('Required / minimum only · selected target unknown');
  await expect(page.getByRole('list', { name: 'Saved items' })).toContainText('Selected target: Unknown');
  await page.getByRole('button', { name: 'Spending changes', exact: true }).click();
  await expect(page.getByText(/No eligible spending changes are available/)).toBeVisible();
  const exported = await (await page.request.get('/api/session/export')).text();
  expect(exported).toContain('required/minimum only; selected target unknown');
  expect(exported).toContain('INR 400.00');
  expect(exported).not.toContain('First gap: none');
});