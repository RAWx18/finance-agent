// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Plan } from '../../src/api';
import { browse, cleanup, command, dateAt, golden, test } from './moneySupport';

test.afterEach(async ({ context }) => { await cleanup(context); });

/** Exercise paging and financial qualifiers using only synthetic INR facts. */
async function seed(page: Page) {
  const initial = await golden(page);
  const saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision, records: [
    { label: 'Automatic subscription', kind: 'optional', distinct: true, delete: false, autoDebit: true, amount: { amount: '125', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 0), certainty: 'exact' } },
    { label: 'Estimated outing', kind: 'optional', distinct: true, delete: false, amount: { amount: '450', status: 'estimate' }, schedule: { date: dateAt(initial.anchorDate, 1), certainty: 'estimate' } },
    { label: 'Minimum card', kind: 'debt', debtType: 'card', distinct: true, delete: false, amount: { amount: '700', status: 'exact' }, target: { amount: null, status: 'unknown' }, schedule: { date: dateAt(initial.anchorDate, 3), certainty: 'exact' } },
    { label: 'Uncertain receipt', kind: 'income', distinct: true, delete: false, reliability: 'uncertain', amount: { amount: '1800', status: 'estimate' }, schedule: { date: dateAt(initial.anchorDate, 4), certainty: 'estimate' } },
    { label: 'Weekend trip', kind: 'optional', distinct: true, delete: false, controllability: 'controllable', amount: { amount: '850', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 20), certainty: 'exact' } },
    { label: 'Undated repair', kind: 'essential', distinct: true, delete: false, amount: { amount: '975', status: 'exact' }, schedule: { date: null, certainty: 'unknown' } },
  ] } });
  expect(saved.plan.events).toHaveLength(11);
  expect(saved.plan.budgetBasis.unresolvedAmounts.filter(item => item.reason === 'missingDate')).toHaveLength(1);
  await browse(page, '/money/upcoming');
  await expect(page.getByRole('button', { name: '1 item needs a date', exact: true })).toBeVisible();
  return saved;
}

/** Format API paise for a display assertion without recomputing a projection. */
function rupees(paise: number | null) {
  return paise === null ? 'Unknown' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100);
}

/** Match the public calendar-date label independently of the UI formatter. */
function day(date: string) {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** Compare every rendered occurrence, in server order, across all result pages. */
async function checkEvents(page: Page, events: Plan['events']) {
  const list = page.getByRole('list', { name: 'Upcoming events', exact: true });
  const pages = page.getByRole('navigation', { name: 'Upcoming events pages', exact: true });
  for (let offset = 0; offset < events.length; offset += 8) {
    const slice = events.slice(offset, offset + 8);
    await expect(list.locator(':scope > li > .money-event-identity > h3')).toHaveText(slice.map(event => event.label));
    for (const [index, event] of slice.entries()) {
      const row = list.locator(':scope > li').nth(index);
      await expect(row).toHaveAttribute('aria-label', event.label);
      await expect(row.locator(':scope > time')).toHaveAttribute('datetime', event.date);
      await expect(row.locator(':scope > time')).toHaveText(day(event.date).replace(/ \d{4}$/, ''));
      await expect(row.locator('.money-event-value > strong')).toHaveText(event.amountPaise === null ? 'Unknown' : `${event.kind === 'income' ? '+' : '−'}${rupees(event.amountPaise)}`);
      await expect(row.locator('.money-event-balance')).toHaveText(`Forecast ${rupees(event.balancePaise)}`);
      await expect(row.getByRole('button', { name: `Details for ${event.label} on ${day(event.date)}`, exact: true })).toHaveAttribute('aria-haspopup', 'dialog');
    }
    if (offset + 8 < events.length) await pages.getByRole('button', { name: 'Next', exact: true }).click();
  }
  if (events.length > 8) {
    await expect(pages.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await pages.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(pages.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  } else await expect(pages).toHaveCount(0);
}

/** Check controls after scrolling them into view, including native select text width. */
async function checkControls(controls: Locator) {
  for (const control of await controls.all()) {
    await control.scrollIntoViewIfNeeded();
    await expect.soft(control).toBeInViewport({ ratio: 0.99 });
    const bounds = await control.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const canvas = document.createElement('canvas').getContext('2d')!;
      canvas.font = style.font;
      const selected = element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent ?? '' : '';
      return { label: element.getAttribute('aria-label') ?? selected ?? element.textContent,
        left: rect.left, right: rect.right, viewport: innerWidth,
        top: rect.top, bottom: rect.bottom, height: innerHeight,
        clipped: element.scrollWidth > element.clientWidth + 1,
        selectedWidth: canvas.measureText(selected).width,
        available: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    expect.soft(bounds.left, JSON.stringify(bounds)).toBeGreaterThanOrEqual(0);
    expect.soft(bounds.right, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewport + 1);
    expect.soft(bounds.top, JSON.stringify(bounds)).toBeGreaterThanOrEqual(-1);
    expect.soft(bounds.bottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.height + 1);
    expect.soft(bounds.clipped, JSON.stringify(bounds)).toBe(false);
    expect.soft(bounds.selectedWidth, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.available + 1);
  }
}

test('source events remain exact through paging, filters, keyboard details and complete printing', async ({ page }) => {
  const saved = await seed(page);
  const commands: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/session')) commands.push(request.method() + ' ' + request.url()); });
  const upcoming = page.getByRole('region', { name: 'Upcoming money and payments', exact: true });
  const search = upcoming.getByRole('searchbox', { name: 'Search upcoming items' });
  const filter = upcoming.getByRole('combobox', { name: 'Filter upcoming items' });
  await expect(upcoming.getByRole('tab')).toHaveCount(0);
  await expect(upcoming.getByRole('combobox', { name: 'Time period' })).toHaveValue('upcoming');
  await checkEvents(page, saved.plan.events);
  await search.fill('  CARD  ');
  await checkEvents(page, saved.plan.events.filter(event => event.label.toLowerCase().includes('card')));
  await search.fill('');
  for (const kind of ['income', 'due']) {
    await filter.selectOption(kind);
    await checkEvents(page, saved.plan.events.filter(event => kind === 'income' ? event.kind === 'income' : event.kind !== 'income'));
  }
  await filter.selectOption('all');
  const list = upcoming.getByRole('list', { name: 'Upcoming events', exact: true });
  for (const [label, badges] of [
    ['Automatic subscription', ['Optional', 'Auto-debit']],
    ['Estimated outing', ['Optional', 'Estimated', 'Date uncertain']],
    ['Minimum card', ['Card payment', 'Minimum only · target unknown']],
    ['Uncertain receipt', ['Money in', 'Estimated', 'Not counted', 'Date uncertain']],
  ] as const) {
    const row = list.getByRole('listitem', { name: label, exact: true });
    await row.scrollIntoViewIfNeeded();
    for (const badge of badges) await expect(row.getByText(badge, { exact: true })).toBeInViewport();
  }
  const card = saved.plan.events.find(event => event.label === 'Minimum card')!;
  expect(card.amountBasis).toBe('requiredOnly');
  const details = upcoming.getByRole('button', { name: `Details for ${card.label} on ${day(card.date)}`, exact: true });
  await details.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: card.label, exact: true });
  await expect(dialog.getByRole('heading', { name: card.label, exact: true })).toBeFocused();
  await expect(dialog).toContainText('Required / minimum only · intended payment unknown');
  await expect(dialog).toContainText('Not a current bank balance');
  await expect(dialog).toContainText(rupees(card.balancePaise));
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible(); await expect(details).toBeFocused();
  const missing = upcoming.getByRole('button', { name: '1 item needs a date', exact: true });
  await missing.click();
  const undated = page.getByRole('dialog', { name: '1 item needs a date', exact: true });
  await expect(undated.getByRole('list', { name: 'Items without dates' })).toContainText('Undated repair');
  await expect(undated).toContainText('₹975.00');
  await expect(undated).toContainText('Date unknown, not in dated balances.');
  await expect(undated.getByRole('link', { name: 'View item category' })).toHaveAttribute('href', '/money/spending');
  await page.keyboard.press('Escape'); await expect(missing).toBeFocused();
  await upcoming.getByRole('button', { name: 'About this forecast', exact: true }).click();
  const forecast = page.getByRole('dialog', { name: 'About this forecast', exact: true });
  await expect(forecast).toContainText('not completed payments or a current bank balance');
  await expect(forecast).toContainText('Same-day payments come before income');
  await expect(forecast).toContainText('Row order is not payment priority');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Recent changes', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Plan tools', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Plan tools', exact: true }).getByRole('heading', { name: 'Recent changes' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.emulateMedia({ media: 'print' });
  const print = page.getByRole('article', { name: 'Saved plan for printing', exact: true });
  await expect(print).toBeVisible();
  await expect(print.locator('.money-events > li')).toHaveCount(11);
  await expect(print.getByRole('listitem', { name: 'Minimum card', exact: true })).toContainText('Required / minimum only · intended payment unknown');
  await expect(print.locator('.money-event-detail')).toHaveCount(11);
  await expect(print.getByRole('button', { name: /^Details for/ })).toHaveCount(0);
  await page.emulateMedia({ media: 'screen' });
  expect(await (await page.request.get('/api/session')).json()).toEqual(saved);
  expect(commands, 'Upcoming browsing must not issue financial commands').toEqual([]);
});

test('compact rows and accessible controls fit baseline and 320px double-size text', async ({ page }, testInfo) => {
  await seed(page);
  const upcoming = page.getByRole('region', { name: 'Upcoming money and payments', exact: true });
  await page.screenshot({ path: testInfo.outputPath('upcoming.png'), fullPage: true });
  await expect(page.locator('.money-context')).toHaveCount(0);
  for (const text of [/Based on what you’ve shared/, /Expected money in and planned spending/, /Not a current bank balance/, /Projected balance after/, /Date: Reported/]) {
    for (const copy of await upcoming.getByText(text).all()) await expect(copy).not.toBeVisible();
  }
  const layout = await upcoming.evaluate(element => {
    const list = element.querySelector('.money-events')!;
    const toolbar = element.querySelector('.upcoming-toolbar')!.getBoundingClientRect();
    const rows = [...list.children].map(row => row.getBoundingClientRect());
    const owners = [];
    let top = 0; let bottom = innerHeight;
    for (let parent = list.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent); const rect = parent.getBoundingClientRect();
      if (/auto|scroll/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) owners.push(parent.className);
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    }
    const controls = [...element.querySelectorAll('.upcoming-toolbar input, .upcoming-toolbar select, .upcoming-toolbar > button')].map(control => {
      const rect = control.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
    });
    return { width: innerWidth, visibleRows: rows.filter(row => row.top >= top && row.bottom <= bottom).length,
      gap: rows[0].top - toolbar.bottom, overflow: getComputedStyle(list).overflowY, owners, controls,
      documentWidth: document.documentElement.scrollWidth };
  });
  await testInfo.attach('baseline geometry', { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
  expect.soft(layout.overflow, 'Upcoming list must not own a second scrollbar').toBe('visible');
  expect.soft(layout.owners, 'Desktop uses the Money view; mobile uses the document').toHaveLength(layout.width > 700 ? 1 : 0);
  expect.soft(layout.visibleRows, 'Useful rows visible before any scrolling').toBeGreaterThanOrEqual(layout.width > 700 ? 4 : 2);
  expect.soft(layout.gap, 'No explanatory block between toolbar and first row').toBeLessThan(100);
  expect.soft(layout.documentWidth).toBeLessThanOrEqual(layout.width);
  const [search, period, filter, info] = layout.controls;
  expect.soft(Math.max(period.top, filter.top, info.top)).toBeLessThan(Math.min(period.bottom, filter.bottom, info.bottom));
  if (layout.width > 700) expect.soft(Math.max(...layout.controls.map(control => control.top))).toBeLessThan(Math.min(...layout.controls.map(control => control.bottom)));
  else expect.soft(search.bottom).toBeLessThanOrEqual(period.top);
  await checkControls(upcoming.locator('.upcoming-toolbar input, .upcoming-toolbar select, .upcoming-toolbar > button'));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; window.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('upcomingNarrow.png'), fullPage: true });
  expect.soft(await page.evaluate(() => innerWidth)).toBe(320);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const title = await page.getByRole('heading', { name: 'Upcoming', exact: true }).boundingBox();
  const actions = await page.locator('.money-heading-actions').boundingBox();
  expect.soft(title).not.toBeNull(); expect.soft(actions).not.toBeNull();
  expect.soft(actions!.y, 'Page actions must not cover the enlarged title').toBeGreaterThanOrEqual(title!.y + title!.height);
  const pagination = upcoming.getByRole('navigation', { name: 'Upcoming events pages', exact: true });
  await checkControls(pagination.getByRole('button'));
  const paginationText = await pagination.getByRole('status').evaluate(element => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, line: parseFloat(style.lineHeight) };
  });
  expect.soft(paginationText.height, 'Pagination status remains readable on one line').toBeLessThanOrEqual(paginationText.line + 1);
  await upcoming.locator('.upcoming-toolbar').screenshot({ path: testInfo.outputPath('upcomingNarrowToolbar.png') });
  await checkControls(upcoming.locator('.upcoming-toolbar input, .upcoming-toolbar select, .upcoming-toolbar > button, .upcoming-undated > button'));
  const details = upcoming.getByRole('button', { name: /^Details for/ }).first();
  await checkControls(details);
  await details.click();
  const dialog = page.getByRole('dialog');
  await expect.soft(dialog).toBeInViewport({ ratio: 1 });
  await checkControls(dialog.getByRole('button', { name: /^Close/ }));
  await page.screenshot({ path: testInfo.outputPath('upcomingNarrowDetails.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(details).toBeFocused();
});

test('stale saved rows recover to API corrections and genuine empty states', async ({ page }) => {
  const saved = await seed(page);
  const commands: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/session/commands') commands.push(request.url()); });
  const upcoming = page.getByRole('region', { name: 'Upcoming money and payments', exact: true });
  const rent = upcoming.getByRole('listitem', { name: 'Rent', exact: true });
  await expect(rent.locator('.money-event-value > strong')).toHaveText('−₹12,000.00');
  await page.route('**/api/session/events', route => route.abort('connectionfailed'));
  await page.reload();
  await expect(page.getByText('Updates paused · showing your saved plan', { exact: true })).toBeVisible();
  await expect(rent.locator('.money-event-value > strong')).toHaveText('−₹12,000.00');
  const corrected = await command(page, { type: 'updateFacts', changes: { expectedRevision: saved.revision, records: [
    { id: saved.facts.records.find(record => record.label === 'Rent')!.id, distinct: false, delete: false, amount: { amount: '12345.67', status: 'exact' } },
  ] } });
  await page.unroute('**/api/session/events');
  await expect(page.getByText('Updates paused · showing your saved plan', { exact: true })).toHaveCount(0);
  await expect(rent.locator('.money-event-value > strong')).toHaveText('−₹12,345.67');
  await expect(upcoming.getByText('−₹12,000.00', { exact: true })).toHaveCount(0);
  await checkEvents(page, corrected.plan.events);
  await page.reload();
  await expect(rent.locator('.money-event-value > strong')).toHaveText('−₹12,345.67');
  const search = upcoming.getByRole('searchbox', { name: 'Search upcoming items' });
  await search.fill('No such upcoming item');
  await expect(upcoming.getByRole('heading', { name: 'No matching items', exact: true })).toBeVisible();
  await expect(upcoming.getByRole('status')).toHaveText('0 items found');
  await expect(upcoming.getByRole('list', { name: 'Upcoming events', exact: true })).toHaveCount(0);
  await search.fill('');
  const undated = await command(page, { type: 'updateFacts', changes: { expectedRevision: corrected.revision,
    records: corrected.facts.records.filter(record => record.schedule.date !== null).map(record => ({ id: record.id, delete: false, distinct: false, schedule: { date: null, certainty: 'unknown' as const } })),
  } });
  expect(undated.plan.events).toEqual([]);
  await expect(upcoming.getByRole('heading', { name: 'No dated items yet', exact: true })).toBeVisible();
  await expect(upcoming).toContainText('Add the missing dates to see those items here.');
  await expect(upcoming.getByRole('button', { name: '12 items need a date', exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/session')).json()).toEqual(undated);
  expect(commands, 'Only explicit fixture API updates may write; the browser remains read-only').toEqual([]);
});