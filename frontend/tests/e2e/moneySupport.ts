// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { Command, Snapshot } from '../../src/api';
import { moneyRoutes } from '../../src/moneyRoutes';
import type { MoneyRoute } from '../../src/moneyRoutes';
import { test as authenticated } from './authSupport';

export const test = authenticated.extend<{ moneySafety: void }>({
  serviceWorkers: 'block',
  moneySafety: [async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    const blocked: string[] = [];
    const errors: string[] = [];
    const observe = (page: Page) => page.on('pageerror', error => errors.push(error.message));
    context.pages().forEach(observe); context.on('page', observe);
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== origin || url.pathname === '/api/session/call' && request.method() !== 'GET') {
        blocked.push(`${request.method()} ${url.pathname}`); await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await context.routeWebSocket('**', socket => {
      blocked.push(socket.url()); socket.close({ code: 1008, reason: 'Money tests prohibit provider connections' });
    });
    try { await use(); }
    finally {
      context.off('page', observe);
      expect(blocked, 'Money must not start a call or contact providers').toEqual([]); expect(errors).toEqual([]);
    }
  }, { auto: true }],
});

export async function cleanup(context: BrowserContext) {
  await Promise.all(context.pages().map(page => page.close()));
  const response = await context.request.delete('/api/session');
  expect([200, 204, 404]).toContain(response.status());
}

export function dateAt(anchor: string, offset: number) {
  const date = new Date(`${anchor}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10);
}

export async function command(page: Page, operation: Command['operation']) {
  const current = await page.request.get('/api/session'); expect(current.ok()).toBe(true);
  const snapshot = await current.json() as Snapshot;
  if (operation.type === 'updateFacts') operation.changes.expectedRevision = snapshot.revision;
  const response = await page.request.post('/api/session/commands', { data: { commandId: randomUUID(), expectedRevision: snapshot.revision, operation } });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Snapshot;
}

export async function browse(page: Page, route: MoneyRoute) {
  await expect(page.locator('#money-heading')).toBeVisible();
  const select = page.getByRole('combobox', { name: 'Browse Money', exact: true });
  if (await select.isVisible()) await select.selectOption(route);
  else await page.getByRole('navigation', { name: 'Money navigation' }).getByRole('link', { name: route === '/money' ? 'Overview' : moneyRoutes[route], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${route}$`));
  await expect(page.getByRole('heading', { level: 1, name: moneyRoutes[route], exact: true })).toBeVisible();
}

export async function saveCorrection(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  const saved = await response; expect(saved.ok(), await saved.text()).toBe(true);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return await saved.json() as Snapshot;
}

export async function correct(page: Page, label: string, field: string, value: string) {
  const edit = page.getByRole('button', { name: `Edit ${label}`, exact: true }); await edit.click();
  await page.getByRole('combobox', { name: 'Detail', exact: true }).selectOption(field);
  if (['amount', 'target', 'outstanding'].includes(field)) { await page.getByRole('combobox', { name: 'Amount certainty', exact: true }).selectOption('exact'); await page.getByLabel('Amount (₹)').fill(value); }
  else if (field === 'controllability') await page.getByRole('combobox', { name: 'Can this spending change?', exact: true }).selectOption(value);
  else if (field === 'reliability') await page.getByRole('combobox', { name: 'Receipt reliability', exact: true }).selectOption(value);
  else if (field === 'schedule.date') await page.getByLabel('Date', { exact: true }).fill(value);
  const saved = await saveCorrection(page); await expect(edit).toBeFocused(); return saved;
}

export async function golden(page: Page, cardTarget = false) {
  const initial = await (await page.request.post('/api/session', { data: {} })).json() as Snapshot;
  const saved = await command(page, { type: 'updateFacts', changes: { expectedRevision: initial.revision,
    opening: { status: 'exact', amount: '5000' }, coverage: { income: 'reviewed', essential: 'reviewed', debt: 'reviewed', optional: 'reviewed' },
    records: [
      { label: 'Salary', kind: 'income', distinct: true, delete: false, amount: { status: 'exact', amount: '30000' }, schedule: { date: dateAt(initial.anchorDate, 10), recurrence: 'once', certainty: 'exact' }, reliability: 'reliable' },
      { label: 'Rent', kind: 'essential', distinct: true, delete: false, amount: { status: 'exact', amount: '12000' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact' } },
      { label: 'Loan', kind: 'debt', distinct: true, delete: false, debtType: 'loan', amount: { status: 'exact', amount: '6000' }, schedule: { date: dateAt(initial.anchorDate, 5), recurrence: 'once', certainty: 'exact' } },
      { label: 'Food', kind: 'essential', distinct: true, delete: false, amount: { status: 'exact', amount: '3000' }, schedule: { date: dateAt(initial.anchorDate, 7), recurrence: 'once', certainty: 'exact' } },
      { label: 'Card', kind: 'debt', distinct: true, delete: false, debtType: 'card', controllability: 'controllable', amount: { status: 'exact', amount: '2000' }, schedule: { date: dateAt(initial.anchorDate, 15), recurrence: 'once', certainty: 'exact' }, ...(cardTarget ? { target: { status: 'exact' as const, amount: '4000' }, outstanding: { status: 'exact' as const, amount: '20000' } } : {}) },
      { label: 'Optional purchase', kind: 'optional', distinct: true, delete: false, controllability: 'controllable', amount: { status: 'exact', amount: '2000' }, schedule: { date: dateAt(initial.anchorDate, 16), recurrence: 'once', certainty: 'exact' } },
    ] } });
  await page.goto('/money');
  await expect(page.getByRole('region', { name: 'What needs attention' })).toContainText('₹7,000');
  return saved;
}

export async function checkClosing(page: Page, amount: string) {
  await browse(page, '/money');
  await page.getByRole('button', { name: 'View calculation', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Plan details', exact: true });
  await expect(detail.getByText('Projected closing cash', { exact: true }).locator('..')).toContainText(amount.replace(/\.00$/, ''));
  await detail.getByRole('button', { name: 'Close plan details' }).click();
}