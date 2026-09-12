// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './authSupport';
import type { Command, Snapshot } from '../../src/api';

async function command(page: Page, operation: Command['operation']) {
  const saved = await (await page.request.get('/api/session')).json() as Snapshot;
  if (operation.type === 'updateFacts') operation.changes.expectedRevision = saved.revision;
  const response = await page.request.post('/api/session/commands', { data: { commandId: randomUUID(), expectedRevision: saved.revision, operation } });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Snapshot;
}
function day(anchor: string, offset: number) {
  const date = new Date(`${anchor}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10);
}

test.afterEach(async ({ context }) => { await context.request.delete('/api/session'); });

test('financial decisions and third-value resolutions use the same saved facts', async ({ page }) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  let saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    opening: { amount: '3000', status: 'exact' }, coverage: { income: 'none', essential: 'none', optional: 'none', debt: 'reviewed' },
    records: [{ delete: false, distinct: true, label: 'Loan', kind: 'debt', debtType: 'loan', controllability: 'controllable',
      amount: { amount: '2000', status: 'exact' }, target: { amount: '5000', status: 'exact' },
      schedule: { date: day(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact' } }],
  } });
  const loan = saved.facts.records[0].id;
  await page.goto('/money');
  await page.getByRole('button', { name: 'What to check', exact: true }).click();
  const guidance = page.getByRole('dialog', { name: 'What to check', exact: true });
  await expect(guidance).toContainText('required payment of INR 2000.00');
  await expect(guidance).toContainText('fits at that deadline');
  await expect(guidance).toContainText('does not apply a reduction');
  await page.keyboard.press('Escape');
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    conflicts: [{ recordId: loan, field: 'target', values: [{ id: 'second', amount: '5500', status: 'exact' }] }],
  } });
  await page.goto('/money/debts');
  await page.getByRole('listitem', { name: 'Loan', exact: true }).getByRole('button', { name: 'Details for Loan', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve Loan · Intended payment', exact: true }).click();
  const resolution = page.getByRole('dialog', { name: 'Resolve Loan · Intended payment', exact: true });
  await resolution.getByRole('radio', { name: 'Neither report — enter the correct value' }).check();
  await resolution.getByLabel('Correct amount (₹)').fill('4500');
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await resolution.getByRole('button', { name: 'Confirm entered value' }).click();
  expect((await response).ok()).toBe(true);
  await expect(resolution).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: 'Loan', exact: true }).getByText('Intended · includes minimum', { exact: true }).locator('..')).toContainText('₹4,500.00');
  saved = await (await page.request.get('/api/session')).json() as Snapshot;
  expect(saved.facts.conflicts).toEqual([]); expect(saved.plan.outflowPaise).toBe(450000);
  saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    opening: { amount: '100', status: 'exact' }, coverage: { essential: 'reviewed', debt: 'none' },
    records: [{ id: loan, delete: true, distinct: false }, { delete: false, distinct: true, label: 'Groceries', kind: 'essential',
      controllability: 'controllable', amount: { amount: '1000', status: 'exact' }, schedule: { date: day(initial.anchorDate, 1) } }],
  } });
  expect(saved.workspace!.actions![0].kind).toBe('seekSupport');
  await page.goto('/money'); await page.getByRole('button', { name: 'What to check', exact: true }).click();
  await expect(guidance).toContainText('Protect Groceries as an essential need');
  await expect(guidance).not.toContainText('Original dues remain');
  await page.keyboard.press('Escape');
  const need = saved.facts.records[0].id;
  saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: need, delete: false, distinct: false, controllability: 'committed' },
      { delete: false, distinct: true, label: 'Later loan', kind: 'debt', debtType: 'loan', amount: { amount: '1000', status: 'exact' },
        schedule: { date: day(initial.anchorDate, 40) }, outstanding: { amount: '50000', status: 'exact' } }],
    coverage: { debt: 'reviewed' },
  } });
  saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    conflicts: [{ recordId: saved.facts.records.find(record => record.label === 'Later loan')!.id, field: 'outstanding',
      values: [{ id: 'different', amount: '60000', status: 'exact' }] }],
  } });
  expect(saved.workspace!.actions![0].kind).toBe('contactPayee');
  expect(saved.workspace!.actions![0].recordIds).toEqual([need]);
  await page.reload();
  await expect(page.getByRole('region', { name: 'What needs attention', exact: true })).toContainText('Discuss payment options · Groceries');
});

test('financial corrections retain rejected drafts and preserve saved payment and reserve meaning', async ({ page }) => {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  let saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    opening: { amount: '3000', status: 'exact' }, reserve: '2000',
    coverage: { income: 'none', essential: 'none', optional: 'none', debt: 'reviewed' },
    records: [{ delete: false, distinct: true, kind: 'debt', label: 'Card', debtType: 'card', controllability: 'controllable',
      amount: { amount: '1000', status: 'exact' }, target: { amount: '5000', status: 'exact' },
      schedule: { date: day(initial.anchorDate, 2), certainty: 'exact', recurrence: 'once' } }],
  } });
  await page.goto('/money/debts');
  await page.getByRole('button', { name: 'Edit Card', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Correct Card', exact: true });
  await editor.getByLabel('Amount (₹)').fill('6000');
  let response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save correction' }).click();
  expect((await response).status()).toBe(422);
  await expect(editor).toBeVisible(); await expect(editor.getByLabel('Amount (₹)')).toHaveValue('6000');
  await expect(editor.getByRole('alert')).toBeVisible();
  expect((await (await page.request.get('/api/session')).json() as Snapshot).facts).toEqual(saved.facts);
  await editor.getByLabel('Amount (₹)').fill('1300');
  response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save correction' }).click();
  expect((await response).ok()).toBe(true);
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Card', exact: true })).toBeFocused();
  saved = await command(page, { type: 'previewAdjustments', adjustments: [{ eventId: saved.plan.events[0].id, amount: '2000' }] });
  await command(page, { type: 'acceptPreview', previewId: saved.preview!.id, confirmed: true, consentScope: 'unconditional' });
  await page.goto('/money');
  const attention = page.getByRole('region', { name: 'What needs attention', exact: true });
  await expect(attention).toContainText('Cash to keep aside is not covered');
  await expect(attention).toContainText('Largest reserve shortfall: ₹1,000.00');
  await expect(attention).not.toContainText('Some details still need checking');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.money-print')).toBeVisible();
  await expect(page.locator('.money-print')).toContainText('Largest reserve shortfall: ₹1,000.00');
  await page.emulateMedia({ media: 'screen' });
  await page.goto('/money/debts');
  await expect(page.getByRole('listitem', { name: 'Card', exact: true })).toContainText('Current plan: ₹2,000.00');
  await expect(page.getByRole('listitem', { name: 'Card', exact: true })).toContainText('₹5,000.00');
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0,
    coverage: { essential: 'reviewed', debt: 'none' }, records: [{ id: saved.facts.records[0].id, delete: true, distinct: false },
      { delete: false, distinct: true, kind: 'essential', label: 'Rent', amount: { amount: '6000', status: 'exact' }, schedule: { date: day(initial.anchorDate, 1) } }],
  } });
  await page.goto('/money/changes');
  await expect(page.getByRole('heading', { name: 'No suggested changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(0);
});

test('progressive HTTP and SSE workspace, corrections, conflicts, proposal decisions and accessible layouts', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const requests: string[] = []; page.on('request', request => { if (/daily\.co|openai\.azure|speech\.microsoft/.test(request.url())) requests.push(request.url()); });
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  await page.reload(); await page.getByRole('button', { name: 'Start conversation' }).click();
  const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
  await expect(picture.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
  await expect(picture.getByRole('article')).toHaveCount(0);
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, opening: { amount: '5000', status: 'exact' } } });
  await expect(picture.getByRole('article', { name: 'Available opening cash' })).toContainText('₹5,000.00');
  await expect(picture.getByRole('article', { name: 'Expected income' })).toHaveCount(0);
  const learned = await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, records: [
    { delete: false, distinct: true, label: 'Salary', kind: 'income', reliability: 'reliable', amount: { amount: '30000', status: 'estimate' }, schedule: { date: day(initial.anchorDate, 14), certainty: 'estimate', recurrence: 'once' } },
    { delete: false, distinct: true, label: 'Rent', kind: 'essential', amount: { amount: '12000', status: 'exact' }, schedule: { date: day(initial.anchorDate, 2), certainty: 'exact', recurrence: 'once' } },
    { delete: false, distinct: true, label: 'Optional purchase', kind: 'optional', controllability: 'controllable', amount: { amount: '2000', status: 'exact' }, schedule: { date: day(initial.anchorDate, 16), certainty: 'exact', recurrence: 'once' } },
    { delete: false, distinct: true, label: 'Utility bill', kind: 'essential', amount: { amount: null, status: 'unknown' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once' } },
  ] } });
  const salaryId = learned.facts.records.find(record => record.label === 'Salary')!.id;
  const purchaseId = learned.facts.records.find(record => record.label === 'Optional purchase')!.id;
  const billId = learned.facts.records.find(record => record.label === 'Utility bill')!.id;
  const income = picture.getByRole('article', { name: 'Expected income' });
  await expect(income).toContainText('Amount is estimated; Date is estimated or unconfirmed');
  await expect(picture.getByRole('listitem', { name: 'Utility bill', exact: true })).not.toContainText('₹0.00');
  await expect(picture.getByRole('article', { name: 'Cash gap and timing risk' })).toContainText('₹7,000.00');
  const correct = income.getByRole('button', { name: 'Correct Salary' }); await correct.click();
  const editor = page.getByRole('dialog', { name: 'Correct Salary' });
  await editor.getByLabel('Amount (₹)').fill('32000'); await editor.getByLabel('Amount certainty').selectOption('exact');
  let saved = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save correction' }).click(); expect((await saved).ok()).toBe(true);
  await expect(correct).toBeFocused(); await expect(income).toContainText('₹32,000.00'); await expect(income).toContainText('Date is estimated or unconfirmed');
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: salaryId, delete: false, distinct: false, schedule: { certainty: 'exact' } }] } });
  await expect(income).not.toContainText('Excluded from balances');
  await picture.getByRole('button', { name: 'Recent changes' }).click();
  const changes = page.getByRole('dialog', { name: 'Recent changes' });
  await expect(changes).toContainText('Projected closing cash'); await expect(changes).toContainText('earlier cash gap amount and date are unchanged');
  await page.keyboard.press('Escape'); await expect(changes).toBeHidden();
  const timeline = picture.getByRole('article', { name: 'Dated cash requirements' });
  await timeline.getByRole('button', { name: 'Why this result?' }).first().click();
  const explanation = page.getByRole('dialog', { name: 'Why: Projected closing cash' });
  await expect(explanation).toContainText('Opening cash'); await expect(explanation).toContainText('Utility bill'); await expect(explanation).toContainText('not spare spending money');
  await page.keyboard.press('Escape');
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, conflicts: [{ recordId: salaryId, field: 'amount', values: [{ id: 'report-a', amount: '32000', status: 'exact' }, { id: 'report-b', amount: '35000', status: 'exact' }] }] } });
  await expect(income).toContainText('Report 1: ₹32,000.00'); await expect(income).toContainText('Report 2: ₹35,000.00');
  await income.getByRole('button', { name: 'Resolve Salary · Amount' }).click();
  const resolution = page.getByRole('dialog', { name: 'Resolve Salary · Amount' });
  await expect(resolution.getByRole('button', { name: 'Confirm selected report' })).toBeDisabled();
  await resolution.getByRole('radio', { name: 'Report 2: ₹35,000.00 · Reported' }).check();
  saved = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await resolution.getByRole('button', { name: 'Confirm selected report' }).click(); expect((await saved).ok()).toBe(true);
  await expect(income.getByRole('button', { name: /^Resolve/ })).toHaveCount(0); await expect(income).toContainText('₹35,000.00');
  const current = await (await page.request.get('/api/session')).json() as Snapshot;
  const event = current.plan.events.find(event => event.recordId === purchaseId)!;
  await command(page, { type: 'previewAdjustments', adjustments: [{ eventId: event.id, amount: '0' }] });
  const proposal = picture.getByRole('region', { name: 'Spending change preview' });
  await expect(proposal.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  saved = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await proposal.getByRole('button', { name: 'Reject preview', exact: true }).click();
  expect((await saved).request().postDataJSON().operation.type).toBe('rejectPreview');
  await expect(proposal).toHaveCount(0); await expect(picture.getByRole('status')).toContainText('refusal saved');
  const rejected = await (await page.request.get('/api/session')).json() as Snapshot; expect(rejected.rejectedProposals).toHaveLength(1);
  await command(page, { type: 'previewAdjustments', adjustments: [{ eventId: event.id, amount: '500' }] });
  await proposal.getByRole('checkbox').check();
  saved = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await proposal.getByRole('button', { name: 'Accept planning assumptions' }).click(); expect((await saved).ok()).toBe(true);
  await expect(picture.getByRole('article', { name: /Accepted planning assumptions/ })).toContainText('Accepted does not mean paid');
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: purchaseId, delete: false, distinct: false, amount: { amount: '2500', status: 'exact' } }] } });
  await expect(picture.getByRole('article', { name: 'Assumptions need confirmation again' })).toBeVisible();
  await command(page, { type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: billId, delete: true, distinct: false }] } });
  await expect(picture.getByRole('listitem', { name: 'Utility bill', exact: true })).toHaveCount(0);
  await expect(picture).not.toContainText(/report-a|report-b|workspace.results|conditionalReceipt|recordIds/);
  await picture.getByRole('region', { name: 'Financial picture details' }).evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('workspace.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await picture.getByRole('button', { name: 'Correct Salary' }).click();
  await expect(editor.getByRole('button', { name: 'Save correction' })).toBeVisible();
  await page.keyboard.press('Tab'); await expect(editor.getByRole('button', { name: 'Close correct salary' })).toBeFocused();
  await page.screenshot({ path: info.outputPath('workspaceText200.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(correct).toBeFocused();
  expect(errors).toEqual([]); expect(requests).toEqual([]);
});