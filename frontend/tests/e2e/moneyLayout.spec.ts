// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AdjustmentOptions, Command, Snapshot } from '../../src/api';
import { moneyRoutes } from '../../src/moneyRoutes';
import { browse, cleanup, command, dateAt, saveCorrection, test } from './moneySupport';

test.describe.configure({ timeout: 45000 });
test.afterEach(async ({ context }) => { await cleanup(context); });

/** Seed a large, varied plan for pagination, long-label and layout checks. */
async function seed(page: Page, count: 105 | 120) {
  const response = await page.request.post('/api/session', { data: {} }); expect(response.ok()).toBe(true);
  const initial = await response.json() as Snapshot;
  const records: NonNullable<Extract<Command['operation'], { type: 'updateFacts' }>['changes']['records']> = Array.from({ length: count }, (_, index) => {
    const group = index % 3; const ordinal = Math.floor(index / 3);
    return {
      label: `${['Income', 'Spending', 'Card'][group]} ${String(ordinal + 1).padStart(3, '0')} ${index < 3 ? 'W'.repeat(108) : index >= count - 3 ? 'Seabird' : 'household plan item'}`.slice(0, 120),
      kind: group === 0 ? 'income' : group === 1 ? ordinal % 2 ? 'optional' : 'essential' : 'debt',
      distinct: true, delete: false,
      amount: { status: 'exact', amount: group === 0 ? '1000.25' : '100.25' },
      schedule: { date: dateAt(initial.anchorDate, 1 + ordinal % 28), certainty: 'exact', recurrence: 'once' },
      ...(group === 0 ? { reliability: 'reliable' as const } : { controllability: 'controllable' as const }),
      ...(group === 2 ? { debtType: 'card' as const, target: { status: 'exact' as const, amount: '200.50' }, outstanding: { status: 'exact' as const, amount: '2000.75' } } : {}),
    };
  });
  const saved = await command(page, { type: 'updateFacts', changes: {
    expectedRevision: initial.revision, opening: { status: 'exact', amount: '10000' },
    coverage: { income: 'reviewed', essential: 'reviewed', optional: 'reviewed', debt: 'reviewed' }, records,
  } });
  expect(saved.facts.records).toHaveLength(count); expect(saved.plan.events).toHaveLength(count);
  expect(saved.plan.events.every(event => event.included && event.amountPaise !== null)).toBe(true);
  expect(saved.plan.closingPaise).toBe(count === 120 ? 3798000 : 3448250);
  await page.goto('/money'); await expect(page.getByRole('heading', { level: 1, name: 'Money', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct starting cash', exact: true })).toBeEnabled();
  return saved;
}

/** Verify Money's responsive scrolling, overflow and minimum button target sizes. */
async function fits(page: Page, natural = false) {
  const size = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight, overflow: getComputedStyle(document.body).overflowY, modal: !!document.querySelector('dialog:modal'),
  }));
  expect(size.scrollWidth, 'No horizontal document overflow').toBeLessThanOrEqual(size.width + 1);
  if (natural || size.width <= 700) {
    expect(size.scrollHeight, 'Enlarged narrow layouts permit natural vertical scrolling').toBeGreaterThan(size.height);
    if (size.modal) expect(size.overflow, 'A modal locks the background document').toBe('hidden');
    else expect(['hidden', 'clip']).not.toContain(size.overflow);
  } else {
    expect(size.scrollHeight, 'Normal viewports use bounded content, not a growing document').toBeLessThanOrEqual(size.height + 1);
    expect(await page.locator('#money-heading').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(24);
  }
  const small = await page.locator('.money-page button:visible, .money-page a.button:visible').evaluateAll(elements => elements.flatMap(element => {
    const rect = element.getBoundingClientRect();
    return rect.width < 24 || rect.height < 24 ? [{ name: element.getAttribute('aria-label') ?? element.textContent, width: rect.width, height: rect.height }] : [];
  }));
  expect(small, 'Compact Money buttons meet the 24 × 24 CSS-pixel minimum target size').toEqual([]);
}

/** Verify an eight-item list remains bounded and scrollable from the keyboard. */
async function bounded(list: Locator) {
  await expect(list.getByRole('listitem')).toHaveCount(8);
  const size = await list.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
  expect(size.height).toBeGreaterThan(0); expect(size.content).toBeGreaterThan(size.height);
  expect(['auto', 'scroll']).toContain(size.overflow); await expect(list).toHaveAttribute('tabindex', '0');
  await list.focus(); await list.press('PageDown');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
}

/** Verify long item names wrap onto multiple lines without clipping. */
async function wraps(heading: Locator) {
  const layout = await heading.evaluate(element => {
    const bounds = element.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(element);
    return { fits: element.scrollWidth <= element.clientWidth + 1,
      lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.y))).size,
      clipped: [...range.getClientRects()].some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1) };
  });
  expect(layout.fits).toBe(true); expect(layout.clipped, 'Full nickname remains within its row').toBe(false);
  expect(layout.lines, 'Long unbroken nicknames wrap rather than truncate').toBeGreaterThan(1);
}

test('105 real records keep the overview compact and preserve the complete backend export', async ({ page }, info) => {
  const saved = await seed(page, 105); await fits(page);
  await expect(page.getByRole('region', { name: 'Next money and payments' }).getByRole('listitem')).toHaveCount(4);
  await expect(page.getByRole('region', { name: 'Money in this plan' })).toContainText('₹35,008.75');
  await page.screenshot({ path: info.outputPath('money-overview-105.png'), fullPage: true });
  const details = page.getByRole('button', { name: 'View calculation', exact: true }); await details.click();
  const dialog = page.getByRole('dialog', { name: 'Plan details', exact: true });
  await expect(dialog).toContainText('₹34,482.50'); await fits(page);
  await page.screenshot({ path: info.outputPath('money-plan-details.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(details).toBeFocused();
  const exported = await page.request.get('/api/session/export'); expect(exported.ok()).toBe(true);
  const text = await exported.text(); expect(text).toContain('INR 34482.50');
  for (const record of saved.facts.records) expect(text).toContain(record.label);
  expect((await (await page.request.get('/api/session')).json() as Snapshot).facts).toEqual(saved.facts);
});

for (const route of ['/money/income', '/money/spending', '/money/debts'] as const) {
  test(`120 real records: ${moneyRoutes[route]} has bounded pages, nickname search and readable details`, async ({ page }, info) => {
    const saved = await seed(page, 120); await browse(page, route);
    const records = saved.facts.records.filter(record => route === '/money/income' ? record.kind === 'income' : route === '/money/debts' ? record.kind === 'debt' : ['essential', 'optional'].includes(record.kind));
    const first = records[0]; const last = records.at(-1)!;
    const list = page.getByRole('list', { name: 'Money items', exact: true });
    const pages = page.getByRole('navigation', { name: 'Money items pages', exact: true });
    const search = page.getByRole('searchbox', { name: 'Search item names', exact: true });
    const filter = page.getByRole('combobox', { name: 'Filter items', exact: true });
    await expect(page.getByText('40 of 40 items', { exact: true })).toBeVisible();
    await expect(filter.getByRole('option')).toHaveText(route === '/money/spending' ? ['All items', 'Needs check', 'Essentials', 'Other spending'] : ['All items', 'Needs check']);
    await expect(page.getByRole('region', { name: 'Money items', exact: true }).getByRole('combobox')).toHaveCount(1);
    await expect(list.getByRole('listitem', { name: last.label, exact: true })).toHaveCount(0);
    await expect(pages).toContainText('Page 1 of 5'); await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await wraps(list.getByRole('heading', { name: first.label, exact: true })); await fits(page);
    await page.screenshot({ path: info.outputPath(`money-${route.split('/').at(-1)}-120.png`), fullPage: true });
    await bounded(list); await pages.getByRole('button', { name: 'Next' }).click();
    await expect(pages).toContainText('Page 2 of 5'); await expect(list.getByRole('listitem')).toHaveCount(8);
    await expect(list.getByRole('listitem', { name: records[8].label, exact: true })).toBeVisible();
    await search.fill('Seabird'); await expect(page.getByText('1 of 40 items', { exact: true })).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1); await expect(pages).toHaveCount(0);
    const row = list.getByRole('listitem', { name: last.label, exact: true }); await expect(row).toBeVisible();
    if (route === '/money/debts') {
      await expect(row.getByText('Required / minimum', { exact: true }).locator('..')).toContainText('₹100.25');
      await expect(row.getByText('Intended · includes minimum', { exact: true }).locator('..')).toContainText('₹200.50');
      await expect(row.getByText('Outstanding balance', { exact: true }).locator('..')).toContainText('₹2,000.75');
    } else await expect(row).toContainText(route === '/money/income' ? '₹1,000.25' : '₹100.25');
    const reading = row.getByRole('button', { name: `Details for ${last.label}`, exact: true }); await reading.click();
    const dialog = page.getByRole('dialog', { name: `Details for ${last.label}`, exact: true });
    await expect(dialog.getByRole('heading', { name: `Details for ${last.label}`, exact: true })).toBeFocused();
    expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
    if (route === '/money/debts') await expect(dialog).toContainText('The intended payment includes the minimum, not an extra payment. Outstanding debt is not reduced by planning assumptions.');
    await page.keyboard.press('Escape'); await expect(reading).toBeFocused();
    if (route === '/money/income') {
      const edit = row.getByRole('button', { name: `Edit ${last.label}`, exact: true }); await edit.click();
      await expect(page.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue('amount');
      await page.getByLabel('Amount (₹)').fill('1500.75');
      await page.screenshot({ path: info.outputPath('money-income-correction.png'), fullPage: true });
      const corrected = await saveCorrection(page); await expect(edit).toBeFocused(); await expect(row).toContainText('₹1,500.75');
      expect(corrected.plan.closingPaise).toBe(3848050);
      expect(corrected.facts.records.filter(record => record.id !== last.id)).toEqual(saved.facts.records.filter(record => record.id !== last.id));
      await page.reload(); await expect(page).toHaveURL(/\/money\/income$/); await search.fill('Seabird');
      await expect(row).toContainText('₹1,500.75');
      expect((await (await page.request.get('/api/session')).json() as Snapshot).sessionId).toBe(saved.sessionId);
    }
    await search.fill('NoSuchNickname'); await expect(page.getByRole('heading', { name: 'No matching items', exact: true })).toBeVisible();
    await expect(list).toHaveCount(0); await expect(page.getByText('0 of 40 items', { exact: true })).toBeVisible();
    await search.fill(''); await expect(list.getByRole('listitem')).toHaveCount(8); await expect(pages).toContainText('Page 1 of 5');
    if (route === '/money/spending') {
      await filter.selectOption('essential'); await expect(page.getByText('20 of 40 items', { exact: true })).toBeVisible();
      for (const row of await list.getByRole('listitem').all()) await expect(row).toContainText('Essential');
    }
    await fits(page);
  });
}

test('120 dated events paginate and search the complete backend timeline without growing the document', async ({ page }, info) => {
  const saved = await seed(page, 120); await browse(page, '/money/upcoming');
  const list = page.getByRole('list', { name: 'Upcoming events', exact: true });
  const pages = page.getByRole('navigation', { name: 'Upcoming events pages', exact: true });
  await expect(page.getByText('120 of 120 events', { exact: true })).toBeVisible();
  await expect(pages).toContainText('Page 1 of 15'); await fits(page);
  await page.screenshot({ path: info.outputPath('money-upcoming-120.png'), fullPage: true });
  await bounded(list); await pages.getByRole('button', { name: 'Next' }).click();
  await expect(pages).toContainText('Page 2 of 15'); await expect(list).toHaveAttribute('start', '9');
  const event = saved.plan.events.at(-1)!;
  await expect(list.getByRole('listitem', { name: event.label, exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search upcoming items', exact: true }).fill(event.label);
  await expect(page.getByText('1 of 120 events', { exact: true })).toBeVisible();
  const row = list.getByRole('listitem', { name: event.label, exact: true });
  await expect(row.locator('time')).toHaveAttribute('datetime', event.date); await expect(row).toContainText('Not a current bank balance');
  await expect(pages).toHaveCount(0);
  const filter = page.getByRole('combobox', { name: 'Filter upcoming items', exact: true });
  await expect(filter.getByRole('option')).toHaveText(['All events', 'Incoming', 'Payments due']);
  await page.getByRole('searchbox', { name: 'Search upcoming items', exact: true }).fill('');
  await filter.selectOption('income'); await expect(page.getByText('40 of 120 events', { exact: true })).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(8); await fits(page);
  expect((await (await page.request.get('/api/session')).json() as Snapshot).plan).toEqual(saved.plan);
});

test('custom change selection reads all eligible backend occurrences without saving or clipping its dialog', async ({ page }, info) => {
  const saved = await seed(page, 120); await browse(page, '/money/changes'); await fits(page);
  await page.screenshot({ path: info.outputPath('money-changes-120.png'), fullPage: true });
  await page.getByRole('button', { name: 'Choose custom changes', exact: true }).click();
  const add = page.getByRole('button', { name: 'Add a change', exact: true }); await add.click();
  const dialog = page.getByRole('dialog', { name: 'Choose a spending change', exact: true });
  const select = dialog.getByRole('combobox', { name: 'Payment or expense', exact: true });
  const response = await page.request.get('/api/session/options');
  expect(response.ok()).toBe(true);
  const options = await response.json() as AdjustmentOptions;
  expect(options.options.length).toBeGreaterThan(8);
  await expect(select.getByRole('option')).toHaveCount(options.options.length + 1);
  await select.selectOption(options.options.at(-1)!.eventId); await dialog.getByLabel('Planned amount (₹)').fill('100.25');
  await fits(page); await page.screenshot({ path: info.outputPath('money-change-dialog.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(add).toBeFocused();
  const current = await (await page.request.get('/api/session')).json() as Snapshot;
  expect(current.facts).toEqual(saved.facts); expect(current.preview).toBeNull(); expect(current.accepted).toBeNull();
});

test('320px with 200% text permits natural scrolling, full nicknames and keyboard correction access', async ({ page }, info) => {
  const saved = await seed(page, 105); await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await fits(page, true); await page.screenshot({ path: info.outputPath('money-overview-320-text200.png'), fullPage: true });
  await browse(page, '/money/debts'); await fits(page, true);
  const first = saved.facts.records.find(record => record.kind === 'debt')!;
  const row = page.getByRole('list', { name: 'Money items', exact: true }).getByRole('listitem', { name: first.label, exact: true });
  await wraps(row.getByRole('heading', { name: first.label, exact: true }));
  const edit = row.getByRole('button', { name: `Edit ${first.label}`, exact: true });
  await edit.focus(); await expect(edit).toBeInViewport({ ratio: 1 }); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Correct ${first.label}`, exact: true });
  await expect(dialog.getByRole('heading', { name: `Correct ${first.label}`, exact: true })).toBeFocused();
  await expect(dialog.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue('amount');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Tab'); await expect(dialog.locator(':focus')).toHaveCount(1);
  const save = dialog.getByRole('button', { name: 'Save correction', exact: true }); await save.focus();
  await expect(save).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('money-correction-320-text200.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(edit).toBeFocused();
  await page.locator('.site-footer').scrollIntoViewIfNeeded(); await expect(page.locator('.site-footer')).toBeInViewport({ ratio: .99 });
  await fits(page, true);
  expect((await (await page.request.get('/api/session')).json() as Snapshot).facts).toEqual(saved.facts);
});