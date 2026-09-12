// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { Command, Snapshot } from '../../src/api';
import { dateLabel, financialText, money } from '../../src/money';
import { browse, cleanup, command, correct, dateAt, golden, saveCorrection, test } from './moneySupport';

test.use({ permissions: [] });
test.beforeEach(() => { expect(process.env.E2E_DATA_DIR, 'Use the isolated provider-free browser backend').toBeTruthy(); });
test.afterEach(async ({ context }) => { await cleanup(context); });

/** Read canonical state independently of the browser snapshot stream. */
async function current(page: Page) {
  const response = await page.request.get('/api/session');
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Snapshot;
}

/** Compare displayed totals with the server plan, without projecting cash locally. */
async function overview(page: Page, saved: Snapshot) {
  await browse(page, '/money');
  const metrics = page.getByRole('region', { name: 'Money in this plan', exact: true });
  for (const [label, amount] of [
    ['Opening cash', saved.facts.opening.amountPaise],
    ['Expected income included', saved.plan.reliableIncomePaise],
    ['Money going out', saved.plan.outflowPaise],
    ['Closing forecast', saved.plan.closingPaise],
  ] as const) {
    await expect(metrics.locator('.money-metric').filter({ has: page.locator('dt').filter({ hasText: label }) }).locator('dd')).toHaveText(money(amount).replace(/\.00$/, ''));
  }
  const attention = page.getByRole('region', { name: 'What needs attention', exact: true });
  await expect(attention.getByRole('heading', { level: 3 })).toHaveText(financialText(saved.plan.decisionAssessment!.outcome!.headline));
  await expect(attention.getByRole('button', { name: 'Plan conditions', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Projected cash over 30 days', exact: true })).toHaveAccessibleDescription(new RegExp(`Projected closing cash ${money(saved.plan.closingPaise).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
}

/** Retain screenshots and measured row bounds, checking text and independent scroll owners. */
async function evidence(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('.money-context:visible, .money-update:visible')).toHaveCount(0);
  await page.locator('.money-views').evaluate(element => { element.scrollTop = 0; });
  await page.evaluate(() => { window.scrollTo(0, 0); });
  const layout = await page.evaluate(() => {
    const header = document.querySelector('.money-heading')!;
    const title = header.querySelector('.money-title')!.getBoundingClientRect();
    const actions = header.querySelector('.money-heading-actions')!.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.money-record')].map(element => {
      const rect = element.getBoundingClientRect();
      const parts = [...element.querySelectorAll('.money-record-main > *')].map(part => part.getBoundingClientRect());
      return { label: element.getAttribute('aria-label'), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        overlapping: parts.some((a, index) => parts.slice(index + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)) };
    });
    const clipped = [...document.querySelectorAll('.money-title h1, .money-title .money-meta, .money-record h3, .record-value strong, .record-timing')].filter(element => {
      if (!element.getClientRects().length) return false;
      const box = element.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      return [...range.getClientRects()].some(rect => rect.left < box.left - 1 || rect.right > box.right + 1 || rect.left < -1 || rect.right > innerWidth + 1);
    }).map(element => element.textContent);
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, rows, clipped,
      headerCollision: Math.min(title.right, actions.right) - Math.max(title.left, actions.left) > 1 && Math.min(title.bottom, actions.bottom) - Math.max(title.top, actions.top) > 1 };
  });
  await info.attach(`${name}-bounds`, { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
  expect(layout.headerCollision, 'Heading and actions must not collide').toBe(false);
  expect(layout.clipped, 'Text must stay inside its control and the viewport').toEqual([]);
  for (const row of layout.rows) {
    expect(row.height, row.label!).toBeGreaterThan(0);
    expect(row.overlapping, row.label!).toBe(false);
    expect(row.x).toBeGreaterThanOrEqual(-1);
    expect(row.x + row.width).toBeLessThanOrEqual(layout.width + 1);
  }
  const list = page.getByRole('list', { name: 'Money items', exact: true });
  if (await list.count()) {
    await expect(list).toHaveCSS('overflow-y', 'visible');
    expect(await list.evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'The record list must not add a nested scrollbar').toBe(true);
  }
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

test('four Money pages distinguish reported amounts, forecast dates, budgets and secondary details', async ({ page }, info) => {
  const initial = await golden(page, true);
  const saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision, records: [
    { id: initial.facts.records.find(record => record.label === 'Salary')!.id, delete: false, distinct: false, amount: { status: 'estimate', amount: '30000' }, schedule: { recurrence: 'monthly' } },
    { id: initial.facts.records.find(record => record.label === 'Card')!.id, delete: false, distinct: false, schedule: { recurrence: 'monthly' } },
    { label: 'Weekly groceries', kind: 'essential', delete: false, distinct: true, controllability: 'controllable', amount: { status: 'exact', amount: '1000' }, schedule: { date: null, certainty: 'unknown', recurrence: 'weekly', basis: 'allowance' } },
    { label: 'Daily coffee', kind: 'optional', delete: false, distinct: true, controllability: 'controllable', amount: { status: 'exact', amount: '50' }, schedule: { date: null, certainty: 'unknown', recurrence: 'daily', basis: 'allowance' } },
    { label: 'Freelance', kind: 'income', delete: false, distinct: true, reliability: 'uncertain', amount: { status: 'estimate', amount: '4000' }, schedule: { date: dateAt(initial.anchorDate, 12), certainty: 'estimate', recurrence: 'once' } },
    ...Array.from({ length: 5 }, (_, index) => ({ label: `Small purchase ${index + 1}`, kind: 'optional' as const, delete: false, distinct: true, controllability: 'controllable' as const,
      amount: { status: 'exact' as const, amount: '10' }, schedule: { date: dateAt(initial.anchorDate, 20 + index), certainty: 'exact' as const, recurrence: 'once' as const } })),
  ] } });
  expect(saved.facts.records).toHaveLength(14);
  expect(Object.keys(saved.plan.exchangeRates ?? {})).toEqual([]);
  await overview(page, saved);
  await expect(page.getByText('₹4,000 uncertain · not included', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next money and payments', exact: true }).getByRole('listitem')).toHaveCount(4);
  await evidence(page, info, 'overview');

  for (const route of ['/money/income', '/money/spending', '/money/debts'] as const) {
    await browse(page, route);
    const records = saved.facts.records.filter(record => route === '/money/income' ? record.kind === 'income' : route === '/money/debts' ? record.kind === 'debt' : ['essential', 'optional'].includes(record.kind));
    if (route === '/money/spending') records.sort((a, b) => Number(a.kind === 'optional') - Number(b.kind === 'optional'));
    const region = page.getByRole('region', { name: 'Money items', exact: true });
    const list = region.getByRole('list', { name: 'Money items', exact: true });
    const pages = region.getByRole('navigation', { name: 'Money items pages', exact: true });
    const search = region.getByRole('searchbox', { name: 'Search item names', exact: true });
    const filter = region.getByRole('combobox', { name: 'Filter items', exact: true });
    const count = region.locator(':scope > [role="status"]');
    await expect(count).toHaveText(`${records.length} of ${records.length} items`);
    await expect(list.getByRole('listitem')).toHaveCount(Math.min(8, records.length));
    await expect(filter.getByRole('option')).toHaveText(route === '/money/spending' ? ['All items', 'Needs check', 'Essentials', 'Other spending'] : ['All items', 'Needs check']);
    await expect(region.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expect(region.getByRole('button', { name: /coverage$/ })).toHaveCount(0);
    if (records.length > 8) {
      await expect(pages).toContainText('Page 1 of 2');
      await expect(pages.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
      await pages.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(pages).toContainText('Page 2 of 2');
      await expect(pages.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list.getByRole('heading')).toHaveText(records.slice(8).map(record => record.label));
      await pages.getByRole('button', { name: 'Previous', exact: true }).click();
    } else await expect(pages).toHaveCount(0);
    await evidence(page, info, route.split('/').at(-1)!);
    for (const record of records) {
      await search.fill(record.label);
      await expect(count).toHaveText(`1 of ${records.length} items`);
      const row = list.getByRole('listitem', { name: record.label, exact: true });
      const amount = row.getByRole('button', { name: `Edit ${record.label} ${record.kind === 'debt' ? 'required payment' : 'amount'}`, exact: true });
      await expect(amount).toHaveText(money(record.amount.amountPaise));
      const event = saved.plan.events.find(event => event.recordId === record.id && event.date >= saved.plan.evaluatedOn)!;
      expect(event).toBeDefined();
      const timing = row.getByRole('button', { name: `Edit ${record.label} date`, exact: true });
      await expect(timing).toContainText(dateLabel(event.overdue ? event.originalDueDate : event.date).replace(/ \d{4}$/, ''));
      if (record.schedule.basis === 'allowance') {
        expect(record.schedule.date).toBeNull();
        expect(event.dateAssumption).toBeTruthy();
        await expect(timing).toContainText('Budget timing');
        await expect(row).toContainText('Budget estimate · not a bill');
        await expect(row).toContainText(record.schedule.recurrence === 'weekly' ? 'per week' : 'per day');
        expect(saved.plan.events.filter(event => event.recordId === record.id)).toHaveLength(record.schedule.recurrence === 'weekly' ? 5 : 30);
        await timing.click();
        await expect(page.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue('schedule.date');
        await expect(page.getByLabel('Date', { exact: true })).toHaveValue('');
        await page.keyboard.press('Escape');
      }
      if (record.kind === 'income') {
        await expect(row).toContainText('Estimated');
        await expect(row).toContainText(record.reliability === 'reliable' ? 'Included in forecast' : 'Not counted in forecast');
        expect(saved.plan.events.filter(event => event.recordId === record.id).every(event => event.included)).toBe(record.reliability === 'reliable');
      }
      if (record.label === 'Card') {
        await expect(row.getByText('Required / minimum', { exact: true })).toBeVisible();
        await expect(row.getByText('Intended · includes minimum', { exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Edit Card intended payment', exact: true })).toHaveText(money(record.target!.amountPaise));
        await expect(row.getByText('Outstanding balance', { exact: true })).not.toBeVisible();
        for (const [label, field] of [['required payment', 'amount'], ['intended payment', 'target']] as const) {
          await row.getByRole('button', { name: `Edit Card ${label}`, exact: true }).click();
          await expect(page.getByRole('dialog')).toHaveCount(1);
          await expect(page.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue(field);
          await page.keyboard.press('Escape');
        }
        await row.getByRole('button', { name: 'Details for Card', exact: true }).click();
        const details = page.getByRole('dialog', { name: 'Details for Card', exact: true });
        await expect(details.getByRole('button', { name: 'Edit Card outstanding', exact: true })).toHaveText(money(record.outstanding!.amountPaise));
        await details.getByRole('button', { name: 'Edit Card outstanding', exact: true }).click();
        await expect(details).toHaveCount(0);
        await expect(page.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue('outstanding');
        await page.keyboard.press('Escape');
        await row.getByRole('button', { name: 'Details for Card', exact: true }).click();
        await details.getByRole('button', { name: 'Remove Card', exact: true }).click();
        await expect(details).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: 'Remove Card?', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
    await search.fill('No matching nickname');
    await expect(count).toHaveText(`0 of ${records.length} items`);
    await expect(region.getByRole('heading', { name: 'No matching items', exact: true })).toBeVisible();
    await search.fill('');
    if (route === '/money/income') {
      await filter.selectOption('check');
      await expect(count).toHaveText('2 of 2 items');
    } else if (route === '/money/spending') {
      for (const [kind, total] of [['essential', 3], ['optional', 7]] as const) {
        await filter.selectOption(kind);
        await expect(count).toHaveText(`${total} of 10 items`);
        await expect(list.getByRole('listitem')).toHaveCount(total);
        await expect(list.locator(`:scope > li:not([data-kind="${kind}"])`)).toHaveCount(0);
      }
    }
    await filter.selectOption('all');
    await region.getByRole('button', { name: 'Review included items', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Review included items', exact: true });
    const coverage = saved.facts.coverage[route === '/money/income' ? 'income' : route === '/money/debts' ? 'debt' : 'essential'];
    await expect(review).toContainText(coverage === 'reviewed' ? 'Reviewed' : 'Some shared');
    await review.getByRole('button', { name: /coverage$/ }).first().click();
    await expect(review).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Review this category', exact: true }).getByRole('combobox', { name: 'Review category', exact: true })).toHaveValue(coverage);
    await page.keyboard.press('Escape');
  }
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    for (const route of ['/money', '/money/income', '/money/spending', '/money/debts'] as const) {
      await browse(page, route);
      await evidence(page, info, `${route.split('/').at(-1)}-320-text200`);
    }
  }
  expect(await current(page)).toEqual(saved);
});

test('direct corrections save exact fields and reach Overview and idle Conversation through SSE', async ({ page, context }, info) => {
  const initial = await golden(page);
  const salaryId = initial.facts.records.find(record => record.label === 'Salary')!.id;
  const baseline = await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision, records: [
    { id: salaryId, delete: false, distinct: false, amount: { amount: '30000', status: 'estimate' }, schedule: { certainty: 'estimate', recurrence: 'monthly', count: 3, endDate: dateAt(initial.anchorDate, 80) } },
  ] } });
  const conversation = await context.newPage();
  await conversation.goto('/app');
  await conversation.getByRole('button', { name: 'Start conversation', exact: true }).click();
  const picture = conversation.getByRole('region', { name: 'Your financial picture', exact: true });
  await expect(picture).toBeVisible();
  await picture.getByRole('button', { name: 'Edit figures', exact: true }).click();
  const rentCard = picture.getByRole('button', { name: 'Edit Rent amount', exact: true });
  await expect(rentCard).toContainText('₹12,000');
  await browse(page, '/money/spending');
  const edit = page.getByRole('button', { name: 'Edit Rent amount', exact: true });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Correct Rent', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue('amount');
  await dialog.getByLabel('Amount (₹)', { exact: true }).fill('12500.10');
  expect(await current(page)).toEqual(baseline);
  await expect(rentCard).toContainText('₹12,000');
  const saved = await saveCorrection(page);
  await expect(edit).toBeFocused();
  await expect(edit).toHaveText('₹12,500.10');
  await expect(rentCard).toContainText('₹12,500.10');
  const rentId = baseline.facts.records.find(record => record.label === 'Rent')!.id;
  expect(saved.facts.records.find(record => record.id === rentId)!.amount.amountPaise).toBe(1250010);
  expect(saved.facts.records.filter(record => record.id !== rentId)).toEqual(baseline.facts.records.filter(record => record.id !== rentId));
  expect(saved.plan.closingPaise).not.toBe(baseline.plan.closingPaise);
  await overview(page, saved);
  await evidence(page, info, 'rent-corrected-overview');
  await browse(page, '/money/income');
  await page.getByRole('button', { name: 'Edit Salary amount', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Amount certainty', exact: true })).toHaveValue('estimate');
  await page.getByLabel('Amount (₹)', { exact: true }).fill('31000.25');
  expect(await current(page)).toEqual(saved);
  const amount = await saveCorrection(page);
  expect(amount.facts.records.find(record => record.id === salaryId)!.schedule).toEqual(saved.facts.records.find(record => record.id === salaryId)!.schedule);
  expect(amount.facts.records.find(record => record.id === salaryId)!.amount).toMatchObject({ amountPaise: 3100025, status: 'estimate' });
  await page.getByRole('button', { name: 'Edit Salary date', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue('schedule.date');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(dateAt(initial.anchorDate, 10));
  await page.keyboard.press('Escape');
  const dated = await correct(page, 'Salary', 'schedule.date', dateAt(initial.anchorDate, 1));
  const salary = dated.facts.records.find(record => record.id === salaryId)!;
  expect(salary.amount).toEqual(amount.facts.records.find(record => record.id === salaryId)!.amount);
  expect(salary.schedule).toEqual({ ...amount.facts.records.find(record => record.id === salaryId)!.schedule, date: dateAt(initial.anchorDate, 1) });
  await page.getByRole('button', { name: 'Edit Salary', exact: true }).click();
  await page.getByRole('combobox', { name: 'Detail', exact: true }).selectOption('recurrence');
  await expect(page.getByRole('combobox', { name: 'Repeats', exact: true })).toHaveValue('monthly');
  await expect(page.getByLabel('Number of occurrences (optional)', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('End date (inclusive, optional)', { exact: true })).toHaveValue(salary.schedule.endDate!);
  await page.getByRole('combobox', { name: 'Repeats', exact: true }).selectOption('weekly');
  const repeated = await saveCorrection(page);
  expect(repeated.facts.records.find(record => record.id === salaryId)).toEqual({ ...salary, schedule: { ...salary.schedule, recurrence: 'weekly' } });
  expect(repeated.facts.records.filter(record => record.id !== salaryId)).toEqual(saved.facts.records.filter(record => record.id !== salaryId));
  expect(repeated.plan.events.filter(event => event.recordId === salaryId)).toHaveLength(3);
  await overview(page, repeated);
  await expect(picture).toContainText(money(repeated.plan.closingPaise).replace(/\.00$/, ''));
  await expect(conversation.getByRole('region', { name: 'Your conversation', exact: true })).toHaveAttribute('data-phase', 'idle');
  await expect(conversation.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  await conversation.screenshot({ path: info.outputPath('corrected-conversation.png'), fullPage: true });
  await page.reload();
  await overview(page, repeated);
  expect(await current(page)).toEqual(repeated);
});

test('a committed correction with a lost acknowledgement permits only an identical save retry', async ({ page }, info) => {
  const initial = await golden(page);
  await browse(page, '/money/spending');
  const writes: string[] = [];
  let committed: Snapshot | undefined;
  await page.route('**/api/session/commands', async route => {
    writes.push(route.request().postData()!);
    if (writes.length === 1) {
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.ok(), await response.text()).toBe(true);
      committed = await response.json() as Snapshot;
      await route.abort('connectionfailed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Edit Rent amount', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Correct Rent', exact: true });
  const amount = dialog.getByLabel('Amount (₹)', { exact: true });
  await amount.fill('12500.10');
  await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
  const retry = dialog.getByRole('button', { name: 'Retry same save', exact: true });
  await expect(retry).toBeEnabled();
  await expect(dialog).toContainText('Save not confirmed');
  await expect(amount).toHaveValue('12500.10');
  await expect(amount).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Save correction', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(committed).toBeDefined();
  expect(committed!.revision).toBe(initial.revision + 1);
  expect(committed!.facts.records.find(record => record.label === 'Rent')!.amount.amountPaise).toBe(1250010);
  expect(await current(page)).toEqual(committed);
  await page.screenshot({ path: info.outputPath('correction-lost-ack.png'), fullPage: true });
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await retry.click();
  const receipt = await response;
  expect(receipt.ok(), await receipt.text()).toBe(true);
  expect(await receipt.json()).toEqual(committed);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toBe(writes[0]);
  const payload = JSON.parse(writes[0]) as Command;
  expect(payload).toMatchObject({ expectedRevision: initial.revision, operation: { type: 'updateFacts', changes: { expectedRevision: initial.revision, records: [{ id: initial.facts.records.find(record => record.label === 'Rent')!.id, amount: { amount: '12500.10', status: 'exact' } }] } } });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await overview(page, committed!);
  await page.reload();
  expect(await current(page)).toEqual(committed);
  expect(writes).toHaveLength(2);
});

test('an external correction preserves the open draft but cannot be overwritten before cancel and reopen', async ({ page, context }, info) => {
  await golden(page);
  await browse(page, '/money/spending');
  const edit = page.getByRole('button', { name: 'Edit Rent amount', exact: true });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Correct Rent', exact: true });
  const amount = dialog.getByLabel('Amount (₹)', { exact: true });
  await amount.fill('12500.10');
  const writes: Command[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session/commands' && request.method() === 'POST') writes.push(request.postDataJSON() as Command); });
  const other = await context.newPage();
  await other.goto('/money/spending');
  const corrected = await correct(other, 'Rent', 'amount', '13000.20');
  await expect(dialog.getByRole('alert')).toContainText('Saved figures changed. Your correction is kept here for reference.');
  await expect(amount).toHaveValue('12500.10');
  await expect(amount).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Save correction', exact: true })).toBeDisabled();
  expect(await current(page)).toEqual(corrected);
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath('correction-stale-draft.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(amount).toHaveValue('12500.10');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Discard correction', exact: true }).click();
  await expect(edit).toBeFocused();
  await edit.click();
  await expect(amount).toHaveValue('13000.20');
  await expect(amount).toBeEditable();
  await expect(dialog.getByRole('button', { name: 'Save correction', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(edit).toHaveText('₹13,000.20');
  expect(writes).toEqual([]);
  expect(await current(page)).toEqual(corrected);
});