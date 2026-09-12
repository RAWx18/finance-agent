// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { AuthSession, Command, ConversationSummary, Snapshot } from '../../src/api';
import { signIn } from './authSupport';

test.use({ serviceWorkers: 'block', permissions: [], launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

test('compact financial picture receives real SSE facts and recalculates an inline date correction without voice', async ({ page, context, baseURL }, info) => {
  const origin = new URL(baseURL!).origin;
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
  expect(process.env.E2E_DATA_DIR, 'Use the isolated browser backend, never the shared application').toBeTruthy();
  const blocked: string[] = [];
  const errors: string[] = [];
  let ownsSession = false;
  let captures = 0;
  await context.setExtraHTTPHeaders({ Origin: origin });
  await context.exposeBinding('financialPictureCapture', () => { captures++; });
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = async () => {
      await (window as unknown as { financialPictureCapture: () => Promise<void> }).financialPictureCapture();
      throw new DOMException('Financial picture checks keep the microphone off.', 'NotAllowedError');
    };
  });
  await context.routeWebSocket('**', socket => { blocked.push(socket.url()); socket.close(); });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // Financial HTTP/SSE and shipped assets stay real; no room or provider may be contacted.
    if (url.origin !== origin || url.pathname === '/api/session/call' && request.method() !== 'GET') {
      blocked.push(`${request.method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await signIn(page);
    const authResponse = await context.request.get('/api/auth/session');
    expect(authResponse.status()).toBe(200);
    const auth = await authResponse.json() as AuthSession;
    expect(auth.user.email).toBe('google-user-one@example.com');
    expect((await context.request.get('/api/session')).status(), 'Do not replace an existing session').toBe(404);
    const created = await context.request.post('/api/session', { data: {} });
    expect(created.status()).toBe(200);
    ownsSession = true;
    const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));
    const seed = spawnSync('uv', ['run', '--project', backend, '--locked', 'python', '-m', 'tests.history_support', auth.user.id],
      { cwd: backend, env: process.env, encoding: 'utf8' });
    expect(seed.status, seed.stderr).toBe(0);
    const historyResponse = await context.request.get('/api/history');
    expect(historyResponse.status()).toBe(200);
    const history = (await historyResponse.json()).conversations as ConversationSummary[];
    expect(history).toHaveLength(4);
    const slug = history[0].slug;
    const selection = await context.request.post(`/api/history/${slug}/continue`, { data: {} });
    expect(selection.status(), await selection.text()).toBe(200);
    let saved = await selection.json() as Snapshot;
    const stream = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/events' && response.status() === 200);
    await page.goto(`/app/${slug}`);
    expect((await stream).headers()['content-type']).toContain('text/event-stream');
    const conversation = page.getByRole('region', { name: 'Your conversation', exact: true });
    const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
    await expect(conversation).toBeVisible();
    await expect(conversation).toHaveAttribute('data-phase', 'idle');
    await expect(picture).toContainText('Figures appear as you talk');

    // Sending outside the page makes the mounted picture depend on the actual snapshot stream.
    const command: Command = { commandId: randomUUID(), expectedRevision: saved.revision,
      operation: { type: 'updateFacts', changes: { expectedRevision: saved.revision,
        opening: { amount: '1000000', status: 'exact' },
        coverage: { income: 'none', essential: 'reviewed', optional: 'reviewed', debt: 'none' },
        records: [
          { label: 'Rent', kind: 'essential', delete: false, distinct: true, amount: { amount: '30000', status: 'exact' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once' } },
          { label: 'Weekend outings', kind: 'optional', delete: false, distinct: true, amount: { amount: '2000', status: 'estimate' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once' } },
        ],
      } } };
    const response = await context.request.post('/api/session/commands', { data: command });
    expect(response.status(), await response.text()).toBe(200);
    saved = await response.json() as Snapshot;
    expect(saved.facts.opening).toMatchObject({ amountPaise: 100000000, status: 'exact' });
    expect(saved.plan.closingPaise).toBe(100000000);
    expect(saved.plan.budgetBasis.datedProjectionComplete).toBe(false);
    const status = picture.getByRole('region', { name: 'Financial status', exact: true });
    await expect(status).toBeVisible();
    await expect(picture.getByText('Projected end', { exact: true })).toHaveCount(1);
    await expect(status.getByText('₹10,00,000', { exact: true })).toHaveCount(1);
    await expect(status.getByText('Needs dates', { exact: true })).toBeVisible();
    await expect.poll(() => status.innerText()).toMatch(/incomplete|not (?:yet )?(?:a )?(?:complete|full)|not included|excluded|does not include|doesn’t include/i);
    const timeline = picture.getByRole('article', { name: 'Commitments & income', exact: true });
    await expect(timeline.getByRole('heading', { name: 'Commitments & income', exact: true })).toBeVisible();
    const commitments = timeline.getByRole('list', { name: 'Next commitments', exact: true });
    await expect(commitments.getByRole('listitem')).toHaveCount(2);
    const rent = commitments.getByRole('listitem', { name: 'Rent', exact: true });
    const outings = commitments.getByRole('listitem', { name: 'Weekend outings', exact: true });
    const rentId = saved.facts.records.find(record => record.label === 'Rent')!.id;
    const outingId = saved.facts.records.find(record => record.label === 'Weekend outings')!.id;
    await expect(rent.getByRole('button', { name: 'Edit Rent amount', exact: true })).toContainText('₹30,000');
    await expect(rent.getByRole('button', { name: 'Edit Rent amount', exact: true }).getByText('Est.', { exact: true })).toHaveCount(0);
    await expect(outings.getByRole('button', { name: 'Edit Weekend outings amount', exact: true })).toContainText('₹2,000');
    await expect(outings.getByRole('button', { name: 'Edit Weekend outings amount', exact: true }).getByText('Est.', { exact: true })).toBeVisible();
    const missingDates = commitments.getByRole('button', { name: /^Edit .+ date$/ }).filter({ hasText: /date needed|unknown/i });
    await expect(missingDates).toHaveCount(2);

    const left = page.locator('.conversation-pane');
    const bounds = await left.boundingBox();
    expect(bounds).not.toBeNull();
    async function layout() {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow').toBe(true);
      const details = picture.getByRole('region', { name: 'Financial picture details', exact: true });
      expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'No horizontal financial-panel overflow').toBe(true);
      if (info.project.name === 'desktop') {
        const current = await left.boundingBox();
        expect(current).not.toBeNull();
        for (const key of ['x', 'y', 'width', 'height'] as const)
          expect(Math.abs(current![key] - bounds![key]), `Left conversation ${key} stays stable`).toBeLessThanOrEqual(1);
      }
      if (info.project.name === 'mobile') {
        for (const control of await picture.getByRole('form').locator('input:enabled, select:enabled, button:enabled').all()) {
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport({ ratio: 1 });
          const box = (await control.boundingBox())!;
          expect(box.height, 'Editor controls remain touch-sized').toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
        }
      }
    }
    async function concise() {
      const text = await picture.innerText();
      expect(text).not.toMatch(/The dated items leave|Incomplete forecast|Next step/i);
      for (const action of saved.workspace?.actions ?? []) {
        if (action.question.trim()) expect(text).not.toContain(action.question);
      }
      await expect(picture.getByText('Projected end', { exact: true })).toHaveCount(1);
    }
    await concise();
    await layout();
    await page.screenshot({ path: info.outputPath('financialPicture.png'), fullPage: true });
    const disclosure = status.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^(Needs attention|Why\?)$/ }) });
    const summary = disclosure.locator('summary');
    await expect(summary).toHaveText('Needs attention');
    await expect(disclosure).not.toHaveAttribute('open');
    await summary.focus();
    await summary.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');
    await concise();
    await layout();
    await summary.press('Enter');
    await expect(disclosure).not.toHaveAttribute('open');
    await layout();

    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    }
    for (const [field, value] of [['name', 'Monthly rent'], ['amount', '31000']] as const) {
      const edit = rent.getByRole('button', { name: `Edit Rent ${field}`, exact: true });
      await edit.click();
      const input = rent.getByRole('textbox', { name: `Rent ${field}`, exact: true });
      await expect(input).toBeFocused();
      await expect(input).toBeEditable();
      await input.fill(value);
      await expect(input).toHaveValue(value);
      await layout();
      await input.press('Escape');
      await expect(rent.getByRole('form')).toHaveCount(0);
      await expect(edit).toBeFocused();
    }
    const date = new Date(`${saved.anchorDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 2);
    const dueDate = date.toISOString().slice(0, 10);
    const editDate = rent.getByRole('button', { name: 'Edit Rent date', exact: true });
    await editDate.click();
    const dateInput = rent.getByLabel('Rent date', { exact: true });
    const certainty = rent.getByRole('combobox', { name: 'Rent date certainty', exact: true });
    await expect(certainty).toHaveValue('unknown');
    await expect(dateInput).toBeDisabled();
    await certainty.selectOption('exact');
    await expect(dateInput).toBeEditable();
    await dateInput.fill(dueDate);
    await expect(dateInput).toHaveValue(dueDate);
    await layout();
    await page.screenshot({ path: info.outputPath('financialPictureDateEdit.png'), fullPage: true });
    const correction = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/commands' && response.request().method() === 'POST');
    await rent.getByRole('button', { name: 'Save Rent date', exact: true }).click();
    const corrected = await correction;
    expect(corrected.status(), await corrected.text()).toBe(200);
    expect(corrected.request().postDataJSON()).toMatchObject({ expectedRevision: saved.revision,
      operation: { type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: saved.revision,
        records: [{ id: rentId, schedule: { date: dueDate, certainty: 'exact' } }],
      } } });
    saved = await corrected.json() as Snapshot;
    expect(saved.plan.closingPaise).toBe(97000000);
    expect(saved.plan.outflowPaise).toBe(3000000);
    expect(saved.plan.firstGap).toBeNull();
    expect(saved.plan.budgetBasis.datedProjectionComplete).toBe(false);
    expect(saved.plan.events.filter(event => event.recordId === rentId && event.included)).toEqual([
      expect.objectContaining({ date: dueDate, amountPaise: 3000000 }),
    ]);
    expect(saved.facts.records.find(record => record.id === rentId)).toMatchObject({ label: 'Rent', amount: { amountPaise: 3000000, status: 'exact' }, schedule: { date: dueDate, certainty: 'exact' } });
    expect(saved.facts.records.find(record => record.id === outingId)).toMatchObject({ label: 'Weekend outings', amount: { amountPaise: 200000, status: 'estimate' }, schedule: { date: null, certainty: 'unknown' } });
    expect(saved.facts.records.filter(record => record.schedule.date === null).map(record => record.id)).toEqual([outingId]);
    expect(saved.workspace?.results?.find(result => result.id === 'closing')?.amountPaise).toBe(saved.plan.closingPaise);
    await expect(rent.getByRole('form')).toHaveCount(0);
    await expect(editDate).toBeFocused();
    await expect(editDate).toContainText(new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date));
    await expect(status.getByText('₹9,70,000', { exact: true })).toHaveCount(1);
    await expect(status.getByText('₹10,00,000', { exact: true })).toHaveCount(0);
    await expect(status.getByText('Needs dates', { exact: true })).toBeVisible();
    await expect(missingDates).toHaveCount(1);
    await expect(missingDates).toHaveAccessibleName('Edit Weekend outings date');
    await expect(outings.getByText('Est.', { exact: true })).toBeVisible();
    await concise();
    await layout();
    await summary.click();
    await expect(disclosure).toHaveAttribute('open', '');
    await concise();
    await layout();
    await summary.click();
    await expect(disclosure).not.toHaveAttribute('open');
    await layout();
    await expect(conversation).toHaveAttribute('data-phase', 'idle');
    await expect(conversation.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    await page.screenshot({ path: info.outputPath('financialPictureCorrected.png'), fullPage: true });
    const persisted = await context.request.get('/api/session');
    expect(persisted.status()).toBe(200);
    expect(await persisted.json()).toMatchObject({ sessionId: saved.sessionId, conversationSlug: slug, revision: saved.revision, facts: saved.facts, plan: { closingPaise: 97000000 } });
  } finally {
    try {
      if (!page.isClosed()) await page.goto('about:blank');
    } finally {
      if (ownsSession) {
        const deleted = await context.request.delete('/api/session');
        expect(deleted.status()).toBe(200);
        expect((await context.request.get('/api/session')).status()).toBe(404);
      }
    }
    expect(captures, 'No microphone capture was requested').toBe(0);
    expect(blocked, 'No paid voice or external provider traffic was attempted').toEqual([]);
    expect(errors).toEqual([]);
  }
});