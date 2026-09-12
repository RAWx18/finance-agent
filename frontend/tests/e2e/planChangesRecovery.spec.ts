// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { AdjustmentOptions, Command, Snapshot } from '../../src/api';
import { dateLabel, money } from '../../src/money';
import { browse, checkClosing, cleanup, golden, test } from './moneySupport';

test.use({ trace: 'retain-on-failure' });
test.afterEach(async ({ context }) => { await cleanup(context); });

/** Read canonical state without mutating the isolated financial session. */
async function current(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/session');
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Snapshot;
}

/** Select an eligible occurrence through the real custom-change dialog. */
async function choose(page: Page, label: string, amount: string) {
  await page.getByRole('button', { name: 'Choose a payment', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Payment or expense', exact: true });
  await select.selectOption((await select.getByRole('option', { name: new RegExp(`^${label} ·`) }).getAttribute('value'))!);
  await page.getByLabel('Planned amount (₹)', { exact: true }).fill(amount);
  await page.getByRole('button', { name: 'Add to preview', exact: true }).click();
}

/** Return a successful browser command receipt, not a separately polled approximation. */
async function submit(page: Page, label: string, type: Command['operation']['type']) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands')
    && response.request().method() === 'POST' && response.request().postDataJSON().operation.type === type);
  await page.getByRole('button', { name: label, exact: true }).click();
  const saved = await response;
  expect(saved.ok(), await saved.text()).toBe(true);
  return await saved.json() as Snapshot;
}

/** Check scrollable controls individually so below-fold content is not mistaken for clipping. */
async function bounds(page: Page, scope: Locator) {
  const layout = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
  expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportWidth);
  const controls = scope.locator('button, input, select, summary');
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue;
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box, await control.getAttribute('aria-label') ?? await control.textContent() ?? 'control').not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** Retain the actual selection/preview at device size and at a narrow, doubled-text size. */
async function evidence(page: Page, scope: Locator, info: TestInfo, name: string) {
  await bounds(page, scope);
  await scope.getByRole('heading').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 700 });
  const font = await page.evaluate(() => {
    const font = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = '200%';
    return font;
  });
  try {
    await page.screenshot({ path: info.outputPath(`${name}320Text200.png`), fullPage: true });
    expect(await page.evaluate(() => innerWidth)).toBe(320);
    await bounds(page, scope);
    await scope.getByRole('heading').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${name}320Text200.png`), fullPage: true });
  } finally {
    await page.evaluate(font => { document.documentElement.style.fontSize = font; }, font);
    await page.setViewportSize(viewport);
  }
}

test('options loading and 503 retries preserve exact choices and unsaved input', async ({ page }, info) => {
  const initial = await golden(page, true);
  const optionsResponse = await page.request.get('/api/session/options');
  expect(optionsResponse.ok()).toBe(true);
  const options = await optionsResponse.json() as AdjustmentOptions;
  expect(options.options.map(item => item.label).sort()).toEqual(['Card', 'Optional purchase']);
  const exported = await (await page.request.get('/api/session/export')).text();
  const writes: Command[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/session/commands') && request.method() === 'POST') writes.push(request.postDataJSON() as Command);
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let loads = 0;
  await page.route('**/api/session/options', async route => {
    loads++;
    if (loads === 1) await gate;
    if (loads === 1 || loads === 3) await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Options temporarily unavailable.' } });
    else await route.continue();
  });
  try {
    await browse(page, '/money/changes');
    await page.getByRole('button', { name: 'Choose payments', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Loading choices…' })).toBeVisible();
    await expect(page.getByText('No eligible spending changes', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose a payment', exact: true })).toBeDisabled();
    release();
    await expect(page.getByText('Choices unavailable. Your selections are kept; refresh to retry.', { exact: true })).toBeVisible();
    await expect(page.getByText('No eligible spending changes', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Choose a payment', exact: true }).click();
    const select = page.getByRole('combobox', { name: 'Payment or expense', exact: true });
    await expect(select.locator('option')).toHaveText(['Choose a payment or expense',
      ...options.options.map(item => `${item.label} · ${dateLabel(item.date)} · ${money(item.originalPaise)}`)]);
    expect(await select.locator('option').evaluateAll(items => items.map(item => (item as HTMLOptionElement).value)))
      .toEqual(['', ...options.options.map(item => item.eventId)]);
    await select.selectOption(options.options.find(item => item.label === 'Optional purchase')!.eventId);
    await page.getByLabel('Planned amount (₹)', { exact: true }).fill('750.25');
    await page.getByRole('button', { name: 'Close choose a spending change', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh choices', exact: true }).click();
    await expect(page.getByText('Choices unavailable. Your selections are kept; refresh to retry.', { exact: true })).toBeVisible();
    await expect(page.getByText('No eligible spending changes', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Choose a payment', exact: true }).click();
    await expect(select).toHaveValue(options.options.find(item => item.label === 'Optional purchase')!.eventId);
    await expect(page.getByLabel('Planned amount (₹)', { exact: true })).toHaveValue('750.25');
    expect(writes).toEqual([]);
    expect(await current(page)).toEqual(initial);
    await evidence(page, page.getByRole('dialog', { name: 'Choose a spending change', exact: true }), info, 'selection');
    await page.getByRole('button', { name: 'Add to preview', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Selected changes', exact: true }).locator('dl')).toHaveText('Reported₹2,000.00Proposed₹750.25');
    expect(writes).toEqual([]);
    expect(await current(page)).toEqual(initial);
    const preview = await submit(page, 'Preview selected changes', 'previewAdjustments');
    expect(writes).toHaveLength(1);
    expect(preview.facts).toEqual(initial.facts);
    expect(preview.plan).toEqual(initial.plan);
    expect(preview.accepted).toBeNull();
    expect(preview.preview!.adjustments).toHaveLength(1);
    expect(preview.preview!.adjustments[0].amountPaise).toBe(75025);
    expect(preview.preview!.plan.closingPaise).toBe(initial.plan.closingPaise! + 124975);
    expect(await (await page.request.get('/api/session/export')).text()).toBe(exported);
    const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
    await expect(proposal).toContainText('₹1,249.75 less planned spending');
    await expect(proposal.getByRole('button', { name: 'Accept changes', exact: true })).toBeDisabled();
    await evidence(page, proposal, info, 'preview');
    await submit(page, 'Discard preview', 'discardPreview');
  } finally { release(); }
});

test('replacement failure keeps the editor and lost acceptance receipt retries exactly once', async ({ page, context }, info) => {
  const initial = await golden(page);
  const conversation = await context.newPage();
  await conversation.goto('/app');
  await conversation.getByRole('button', { name: 'Start conversation', exact: true }).click();
  const picture = conversation.getByRole('region', { name: 'Your financial picture', exact: true });
  await expect(picture).toBeVisible();
  await browse(page, '/money/changes');
  await page.getByRole('button', { name: 'Choose payments', exact: true }).click();
  await choose(page, 'Optional purchase', '500');
  const prior = await submit(page, 'Preview selected changes', 'previewAdjustments');
  await page.getByRole('button', { name: 'Edit selections', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Optional purchase', exact: true }).click();
  await page.getByLabel('Planned amount (₹)', { exact: true }).fill('750.25');
  await page.getByRole('button', { name: 'Add to preview', exact: true }).click();
  const replacements: Command[] = [];
  const acceptances: string[] = [];
  let committed: Snapshot | undefined;
  await page.route('**/api/session/commands', async route => {
    const payload = route.request().postDataJSON() as Command;
    if (payload.operation.type === 'previewAdjustments') {
      replacements.push(payload);
      if (replacements.length === 1) {
        await route.fulfill({ status: 422, json: { code: 'invalidAdjustments', message: 'Replacement rejected.', snapshot: prior } });
        return;
      }
    }
    if (payload.operation.type === 'acceptPreview') {
      acceptances.push(route.request().postData()!);
      if (acceptances.length === 1) {
        const response = await route.fetch({ maxRetries: 0 });
        expect(response.ok(), await response.text()).toBe(true);
        committed = await response.json() as Snapshot;
        await route.abort('connectionfailed');
        return;
      }
    }
    await route.continue();
  });
  const failed = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.status() === 422);
  await page.getByRole('button', { name: 'Preview selected changes', exact: true }).click();
  await failed;
  await expect(page.getByText('Preview not confirmed. Your amounts are kept. Check the message before trying again.', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Selected changes', exact: true }).locator('dl')).toHaveText('Reported₹2,000.00Proposed₹750.25');
  await expect(page.getByRole('region', { name: 'Spending change preview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept changes', exact: true })).toHaveCount(0);
  expect(await current(page)).toEqual(prior);
  const preview = await submit(page, 'Preview selected changes', 'previewAdjustments');
  expect(replacements).toHaveLength(2);
  expect(replacements[1].operation).toEqual(replacements[0].operation);
  expect(replacements[1].commandId).not.toBe(replacements[0].commandId);
  expect(preview.preview!.id).not.toBe(prior.preview!.id);
  expect(preview.preview!.adjustments.map(item => item.amountPaise)).toEqual([75025]);
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toContainText('₹750.25 Proposed');
  await page.screenshot({ path: info.outputPath('replacementPreview.png'), fullPage: true });
  await proposal.getByRole('checkbox', { name: /I agree to the exact amounts/ }).check();
  await proposal.getByRole('button', { name: 'Accept changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same action', exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for confirmation. Your entries are kept; don’t submit another change yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a payment', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh choices', exact: true })).toBeDisabled();
  expect(committed).toBeDefined();
  expect(await current(page)).toEqual(committed);
  expect(committed!.revision).toBe(initial.revision + 1);
  expect(committed!.accepted!.adjustments).toHaveLength(1);
  const receipt = await submit(page, 'Retry same action', 'acceptPreview');
  expect(acceptances).toHaveLength(2);
  expect(acceptances[1]).toBe(acceptances[0]);
  expect(receipt).toEqual(committed);
  expect(await current(page)).toEqual(committed);
  expect(receipt.facts).toEqual(initial.facts);
  expect(receipt.accepted!.adjustments[0].amountPaise).toBe(75025);
  await expect(page.getByRole('button', { name: 'Retry same action', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a payment', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'View saved changes', exact: true }).click();
  const saved = page.getByRole('dialog', { name: 'View saved changes', exact: true });
  await expect(saved.getByRole('listitem')).toHaveCount(1);
  await expect(saved).toContainText('₹750.25 Saved');
  await page.getByRole('button', { name: 'Close view saved changes', exact: true }).click();
  await checkClosing(page, '₹11,249.75');
  await expect(picture).toContainText('₹11,249.75');
  await expect(picture.getByRole('article', { name: 'Your 30-day plan', exact: true })).toContainText('Saved assumptions included · No payments made');
  await picture.getByRole('button', { name: 'Edit figures', exact: true }).click();
  await expect(picture.getByRole('list', { name: 'Planning changes', exact: true })).toContainText('₹750.25');
  await expect(picture.getByRole('list', { name: 'Planning changes', exact: true }).getByRole('listitem')).toHaveCount(1);
  await conversation.screenshot({ path: info.outputPath('acceptedConversation.png'), fullPage: true });
  await page.reload();
  expect(await current(page)).toEqual(committed);
});

test('same-revision tab replacements require review and delayed previews hit the server stale guard', async ({ page, context }) => {
  const initial = await golden(page, true);
  await browse(page, '/money/changes');
  await page.getByRole('button', { name: 'Choose payments', exact: true }).click();
  await choose(page, 'Optional purchase', '500');
  const prior = await submit(page, 'Preview selected changes', 'previewAdjustments');
  const other = await context.newPage();
  await other.goto('/money/changes');
  await other.getByRole('button', { name: 'Choose payments', exact: true }).click();
  await page.getByRole('button', { name: 'Edit selections', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Optional purchase', exact: true }).click();
  await page.getByLabel('Planned amount (₹)', { exact: true }).fill('750.25');
  await page.getByRole('button', { name: 'Add to preview', exact: true }).click();
  await other.getByRole('button', { name: 'Edit selections', exact: true }).click();
  await other.getByRole('button', { name: 'Edit Optional purchase', exact: true }).click();
  await other.getByLabel('Planned amount (₹)', { exact: true }).fill('1000');
  await other.getByRole('button', { name: 'Add to preview', exact: true }).click();
  await choose(other, 'Card', '3000');
  const elsewhere = await submit(other, 'Preview selected changes', 'previewAdjustments');
  expect(elsewhere.revision).toBe(prior.revision);
  expect(elsewhere.sequence).toBeGreaterThan(prior.sequence);
  expect(elsewhere.preview!.id).not.toBe(prior.preview!.id);
  await expect(page.getByText('Your plan changed elsewhere. Your draft is kept. Review the latest plan before replacing its changes.', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Selected changes', exact: true }).locator('dl')).toHaveText('Reported₹2,000.00Proposed₹750.25');
  await expect(page.getByRole('button', { name: 'Preview selected changes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Review refreshed choices', exact: true }).click();
  const replacement = await submit(page, 'Preview selected changes', 'previewAdjustments');
  expect(replacement.preview!.adjustments.map(item => [item.label, item.amountPaise])).toEqual([['Optional purchase', 75025]]);
  expect(replacement.facts).toEqual(initial.facts);
  expect(replacement.accepted).toBeNull();

  await page.getByRole('button', { name: 'Edit selections', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Optional purchase', exact: true }).click();
  await page.getByLabel('Planned amount (₹)', { exact: true }).fill('900');
  await page.getByRole('button', { name: 'Add to preview', exact: true }).click();
  let release!: () => void;
  let intercepted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrival = new Promise<void>(resolve => { intercepted = resolve; });
  let delayed: Command | undefined;
  await page.route('**/api/session/commands', async route => {
    delayed = route.request().postDataJSON() as Command;
    intercepted();
    await gate;
    await route.continue();
  }, { times: 1 });
  try {
    const stale = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.status() === 409);
    await page.getByRole('button', { name: 'Preview selected changes', exact: true }).click();
    await arrival;
    await other.getByRole('region', { name: 'Spending change preview', exact: true }).getByText('₹750.25 Proposed', { exact: false }).waitFor();
    await other.getByRole('button', { name: 'Edit selections', exact: true }).click();
    await other.getByRole('button', { name: 'Edit Optional purchase', exact: true }).click();
    await other.getByLabel('Planned amount (₹)', { exact: true }).fill('1200');
    await other.getByRole('button', { name: 'Add to preview', exact: true }).click();
    const competing = await submit(other, 'Preview selected changes', 'previewAdjustments');
    expect(competing.revision).toBe(delayed!.expectedRevision);
    expect(competing.sequence).toBeGreaterThan(delayed!.expectedSequence!);
    release();
    expect((await (await stale).json()).code).toBe('stalePreview');
    await expect(page.getByText('Another preview changed while you were choosing amounts. Review the current preview before replacing it.', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Selected changes', exact: true }).locator('dl')).toHaveText('Reported₹2,000.00Proposed₹900');
    await expect(page.getByRole('button', { name: 'Preview selected changes', exact: true })).toBeDisabled();
    expect(await current(page)).toEqual(competing);
    await page.getByRole('button', { name: 'Review refreshed choices', exact: true }).click();
    const reviewed = await submit(page, 'Preview selected changes', 'previewAdjustments');
    expect(reviewed.preview!.adjustments.map(item => item.amountPaise)).toEqual([90000]);
    expect(reviewed.revision).toBe(initial.revision);
    expect(reviewed.accepted).toBeNull();
    await submit(page, 'Discard preview', 'discardPreview');
  } finally { release(); }
});

test('rejection blocks the exact set but a different amount can be previewed and discarded', async ({ page }) => {
  const initial = await golden(page, true);
  await browse(page, '/money/changes');
  await page.getByRole('button', { name: 'Choose payments', exact: true }).click();
  await choose(page, 'Optional purchase', '500');
  await choose(page, 'Card', '3000');
  await submit(page, 'Preview selected changes', 'previewAdjustments');
  const rejected = await submit(page, 'Reject preview', 'rejectPreview');
  expect(rejected.preview).toBeNull();
  expect(rejected.accepted).toBeNull();
  expect(rejected.rejectedProposals).toHaveLength(1);
  await choose(page, 'Card', '3000');
  await choose(page, 'Optional purchase', '500');
  const failure = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.status() === 422);
  await page.getByRole('button', { name: 'Preview selected changes', exact: true }).click();
  expect((await (await failure).json()).code).toBe('proposalRejected');
  await expect(page.getByText('This exact set of proposed changes was previously declined. Choose another amount or a different set of changes to preview.', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Selected changes', exact: true }).locator('dl')).toHaveText(['Reported₹4,000.00Proposed₹3000', 'Reported₹2,000.00Proposed₹500']);
  await expect(page.getByRole('button', { name: 'Accept changes', exact: true })).toHaveCount(0);
  expect(await current(page)).toEqual(rejected);
  await page.getByRole('button', { name: 'Edit Optional purchase', exact: true }).click();
  await page.getByLabel('Planned amount (₹)', { exact: true }).fill('600');
  await page.getByRole('button', { name: 'Add to preview', exact: true }).click();
  const preview = await submit(page, 'Preview selected changes', 'previewAdjustments');
  expect(preview.preview!.adjustments.map(item => [item.label, item.amountPaise]).sort()).toEqual([['Card', 300000], ['Optional purchase', 60000]]);
  expect(preview.accepted).toBeNull();
  const discarded = await submit(page, 'Discard preview', 'discardPreview');
  expect(discarded.preview).toBeNull();
  expect(discarded.accepted).toBeNull();
  expect(discarded.rejectedProposals).toEqual(rejected.rejectedProposals);
  expect(discarded.facts.records).toEqual(initial.facts.records);
  expect(discarded.plan.closingPaise).toBe(initial.plan.closingPaise);
  await expect(page.getByRole('region', { name: 'Current planning changes', exact: true })).toContainText('Your reported plan is active');
  await checkClosing(page, '₹8,000.00');
  await page.reload();
  expect(await current(page)).toEqual(discarded);
});