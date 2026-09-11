// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { build } from 'vite';
import type { CallJoin, CallState, Command, FactsInput, Settings, Snapshot } from '../../src/api';
import { dateLabel, decimal, draftFacts, money } from '../../src/money';
import type {} from '../voiceSdk';
import { signIn } from './authSupport';

// Rendered App + real financial HTTP/SSE, with provider-double transport and fabricated captions.
// This suite never creates a paid room and does not replace real-provider speech acceptance.
let bundle: string;
type Voice = { calls: string[]; blocked: string[]; errors: string[] };
const test = base.extend<{ voice: Voice }>({
  voice: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
    await context.setExtraHTTPHeaders({ Origin: origin });
    const voice: Voice = { calls: [], blocked: [], errors: [] };
    let call: CallState = { callId: null, status: 'idle', message: null };
    let delivered = 0;
    const index = await context.request.get(`${origin}/login`, { maxRedirects: 0 });
    expect(index.status()).toBe(200);
    const scripts = [...(await index.text()).matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
    expect(scripts).toHaveLength(1);
    const entry = new URL(scripts[0][1], origin);
    expect(entry.origin).toBe(origin);
    expect(entry.pathname).toMatch(/^\/assets\/[^/]+\.js$/);

    await context.routeWebSocket('**', socket => {
      voice.blocked.push(socket.url());
      socket.close({ code: 1008, reason: 'Provider-double tests prohibit WebSockets' });
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        voice.blocked.push(request.url());
        await route.abort('blockedbyclient');
      } else if (url.pathname === '/api/session/call') {
        // All methods terminate here, including pagehide/keepalive cleanup; never forward to the server.
        voice.calls.push(request.method());
        if (request.method() === 'POST') {
          call = { callId: randomUUID(), status: 'connecting', message: null };
          const join: CallJoin = { callId: call.callId!, url: 'https://voice-fixture.invalid/room',
            token: 'synthetic-provider-double', expiresAt: new Date(Date.now() + 60000).toISOString() };
          await route.fulfill({ json: join });
        } else if (request.method() === 'GET' || request.method() === 'DELETE') {
          if (request.method() === 'DELETE') call = { ...call, status: 'ended' };
          await route.fulfill({ json: call });
        } else await route.fulfill({ status: 405, json: { code: 'testMethod', message: 'Unsupported test method' } });
      } else if (url.pathname === '/api/settings' && request.method() === 'GET') {
        const response = await route.fetch({ maxRedirects: 0 });
        expect(response.status()).toBe(200);
        const settings = await response.json() as Settings;
        await route.fulfill({ response, json: { ...settings, voiceAvailable: true, voiceUnavailableReason: null } satisfies Settings });
      } else if (url.href === entry.href && request.method() === 'GET') {
        delivered += 1;
        await route.fulfill({ contentType: 'application/javascript', body: bundle });
      } else if ((request.method() === 'GET' && (['/', '/login', '/app', '/figures', '/account', '/auth/callback'].includes(url.pathname) || /^\/assets\/[^/]+\.css$/.test(url.pathname)))
        || (url.pathname.startsWith('/api/auth/') && ['GET', 'POST'].includes(request.method()))
        || (url.pathname === '/api/session' && ['GET', 'POST', 'DELETE'].includes(request.method()))
        || (url.pathname === '/api/session/commands' && request.method() === 'POST')
        || (['/api/session/events', '/api/session/export'].includes(url.pathname) && request.method() === 'GET')) {
        await route.continue();
      } else {
        voice.blocked.push(`${request.method()} ${url.pathname}`);
        await route.abort('blockedbyclient');
      }
    });
    page.on('pageerror', error => voice.errors.push(error.message));
    await signIn(page);
    try { await use(voice); }
    finally {
      if (!page.isClosed()) {
        await page.evaluate(() => {
          for (const client of window.voiceFixture?.clients ?? []) client.stopCapture();
        });
        await page.goto('about:blank');
      }
      // The fresh BrowserContext owns only this test's synthetic financial session.
      const deleted = await context.request.delete(`${origin}/api/session`, { maxRedirects: 0 });
      expect([200, 401, 404]).toContain(deleted.status());
      expect(delivered).toBeGreaterThan(0);
      expect(voice.blocked, 'No unexpected script, provider HTTP request, or WebSocket may escape').toEqual([]);
      expect(voice.errors).toEqual([]);
    }
  }, { auto: true }],
});

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'], serviceWorkers: 'block',
});

test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const sdk = fileURLToPath(new URL('../voiceSdk.ts', import.meta.url));
  const result = await build({
    root, configFile: false, envFile: false, logLevel: 'error',
    resolve: { alias: [
      { find: '@pipecat-ai/client-js', replacement: sdk },
      { find: '@pipecat-ai/daily-transport', replacement: sdk },
    ] },
    build: { write: false, minify: false, rollupOptions: {
      input: fileURLToPath(new URL('../../src/main.tsx', import.meta.url)),
      output: { codeSplitting: false },
    } },
  });
  if ('on' in result) throw new Error('Provider-double build must not start a watcher.');
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(output => output.output)
    .filter(chunk => chunk.type === 'chunk');
  expect(chunks).toHaveLength(1);
  expect(chunks[0].isEntry).toBe(true);
  expect(Object.keys(chunks[0].modules)).toContain(sdk);
  expect(Object.keys(chunks[0].modules).filter(id => /node_modules\/(?:@pipecat-ai|@daily-co)\//.test(id))).toEqual([]);
  bundle = chunks[0].code;
});

function dateAt(anchor: string, offset: number) {
  const [year, month, day] = anchor.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

async function current(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/session', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  return response.json();
}

async function submit(page: Page, snapshot: Snapshot, operation: Command['operation']): Promise<Snapshot> {
  const command: Command = { commandId: randomUUID(), expectedRevision: snapshot.revision, operation };
  const response = await page.request.post('/api/session/commands', { data: command, maxRedirects: 0 });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function actOnPlan(page: Page, label: string, snapshot: Snapshot, operation: Command['operation']): Promise<Snapshot> {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/commands' && response.request().method() === 'POST');
  await page.getByRole('button', { name: label, exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({
    commandId: expect.stringMatching(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i),
    expectedRevision: snapshot.revision, operation,
  });
  return response.json();
}

async function connected(page: Page, before: Awaited<ReturnType<typeof geometry>>, count = 1) {
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients.reduce((sum, client) => sum + client.connections.length, 0))).toBe(count);
  await expect(page.locator('.voice-status')).toHaveText('Connecting');
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toHaveCount(0);
  await stable(page, before, 'connecting with a dated empty session');
  await page.evaluate(() => window.voiceFixture.clients.at(-1)!.callbacks.onConnected!());
  await expect(page.locator('.voice-status')).toHaveText('Connecting to assistant');
  await stable(page, before, 'transport connected');
  await page.evaluate(() => window.voiceFixture.clients.at(-1)!.callbacks.onBotReady!({ version: '2.1.0' }));
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'true');
  await expect(page.getByRole('button', { name: 'Your figures', exact: true })).toBeDisabled();
  await expect(page.locator('.live-layout')).toBeVisible();
  await stable(page, before, 'active');
}

async function geometry(page: Page) {
  return page.evaluate(() => ({
    scrollY, scrollHeight: document.documentElement.scrollHeight,
    gutter: innerWidth - document.documentElement.clientWidth,
    boxes: ['.site-header', 'main', '.conversation', '.conversation-controls', '.financial-pane', '.context-scroll', '.context-empty, .context-scroll', '.site-footer'].flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element) return [];
      const { x, y, width, height } = element.getBoundingClientRect();
      return [{ selector, x, y, width, height }];
    }),
  }));
}

async function stable(page: Page, before: Awaited<ReturnType<typeof geometry>>, state: string) {
  const after = await geometry(page);
  expect(Math.abs(after.scrollY - before.scrollY), `${state}: document scrollY`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.scrollHeight - before.scrollHeight), `${state}: document height`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.gutter - before.gutter), `${state}: scrollbar gutter`).toBeLessThanOrEqual(1);
  for (const box of before.boxes) {
    const actual = after.boxes.find(item => item.selector === box.selector);
    expect(actual, `${state}: ${box.selector} exists`).toBeDefined();
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(actual![key] - box[key]), `${state}: ${box.selector} ${key}`).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('.conversation-controls').evaluate(element => element.scrollHeight <= element.clientHeight + 1), `${state}: controls contain all button rows`).toBe(true);
  await expect(page.locator('details, summary, [aria-expanded]')).toHaveCount(0);
}

async function modal(page: Page, dialog: Locator, title: string, before: Awaited<ReturnType<typeof geometry>>) {
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(dialog.locator('.dialog-body')).toHaveCSS('overflow-y', 'auto');
  await expect(dialog).toBeInViewport({ ratio: 1 });
  const body = await dialog.locator('.dialog-body').boundingBox();
  expect(body!.height).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'End conversation', exact: true, includeHidden: true }).focus();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  const stops = await dialog.locator('button:enabled, a[href], [tabindex="0"]').count();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < stops + 2; index++) {
      await page.keyboard.press(key);
      await expect(dialog.locator(':focus')).toHaveCount(1);
    }
  }
  await stable(page, before, `${title} open`);
}

async function layout(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'End conversation', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toBeInViewport({ ratio: 1 });
  const details = page.getByRole('region', { name: 'Financial picture details', exact: true });
  await expect(details).toHaveCSS('overflow-y', 'auto');
  await expect(details).toBeInViewport({ ratio: 1 });
  const bounds = (await geometry(page)).boxes;
  const conversation = bounds.find(box => box.selector === '.conversation')!;
  const controls = bounds.find(box => box.selector === '.conversation-controls')!;
  const pane = bounds.find(box => box.selector === '.financial-pane')!;
  const scroll = bounds.find(box => box.selector === '.context-scroll')!;
  expect(controls.y).toBeGreaterThanOrEqual(conversation.y);
  expect(controls.y + controls.height).toBeLessThanOrEqual(conversation.y + conversation.height + 1);
  expect(scroll.y).toBeGreaterThanOrEqual(pane.y);
  expect(scroll.y + scroll.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
  expect(scroll.width).toBeGreaterThan(200);
  expect(scroll.height).toBeGreaterThan(0);
  expect(await page.locator('.conversation-controls').evaluate(element => getComputedStyle(element).position)).not.toBe('fixed');
  if (page.viewportSize()!.width <= 700) {
    expect(pane.y).toBeGreaterThanOrEqual(conversation.y + conversation.height - 1);
  } else {
    expect(pane.x).toBeGreaterThanOrEqual(conversation.x + conversation.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
}

test('provider double: live picture → salary-date correction over SSE → review → real export', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Talk it through.');
  await expect(page.getByRole('button', { name: 'Start conversation' })).toBeEnabled();
  expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(0);
  expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
  expect(voice.calls).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('provider-double-landing.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start conversation' }).click();
  await expect(page.locator('.voice-status')).toHaveText('Ready when you are');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Let’s talk it through.');
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toHaveCount(0);
  expect(await page.evaluate(() => window.voiceFixture.tracks.length)).toBe(0);
  expect(voice.calls).toEqual([]);
  const ready = await geometry(page);
  await page.getByRole('button', { name: 'Start talking' }).click();
  await connected(page, ready);
  expect(await page.evaluate(() => window.voiceFixture.tracks.map(track => ({ kind: track.kind, state: track.readyState })))).toEqual([{ kind: 'audio', state: 'live' }]);
  await expect(page.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
  await page.evaluate(() => {
    const events = window.voiceFixture.clients[0].callbacks;
    events.onUserStartedSpeaking!();
    events.onUserTranscript!({ text: 'Test figures: I have five thousand available.', final: true, timestamp: 'fixture-1', user_id: 'fixture-user' });
    events.onUserStoppedSpeaking!();
    events.onLLMFunctionCallStarted!({ function_name: 'save_facts' });
    events.onLLMFunctionCallInProgress!({ tool_call_id: 'fixture-save', function_name: 'save_facts' });
  });
  await expect(page.locator('.voice-status')).toHaveText('Thinking');
  await stable(page, ready, 'saving speech facts');
  const initial = await current(page);
  const facts: FactsInput = {
    opening: { amount: '5000', status: 'exact' }, reserve: '0',
    coverage: { income: 'reviewed', essential: 'reviewed', debt: 'reviewed', optional: 'reviewed' },
    records: [
      { id: 'salary', kind: 'income', label: 'Salary', amount: { amount: '30000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 10), recurrence: 'once' }, reliability: 'reliable', autoDebit: false },
      { id: 'rent', kind: 'essential', label: 'Rent', amount: { amount: '12000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once' }, autoDebit: false },
      { id: 'loan', kind: 'debt', label: 'Loan', amount: { amount: '6000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 5), recurrence: 'once' }, debtType: 'loan', autoDebit: false },
      { id: 'food', kind: 'essential', label: 'Food', amount: { amount: '3000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 7), recurrence: 'once' }, autoDebit: false },
      { id: 'card', kind: 'debt', label: 'Card', amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 15), recurrence: 'once' }, debtType: 'card', autoDebit: false },
      { id: 'optional', kind: 'optional', label: 'Optional purchase', amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 16), recurrence: 'once' }, autoDebit: false },
    ],
  };
  const saved = await submit(page, initial, { type: 'replaceFacts', facts });
  expect(saved.plan.firstGap).toEqual({ date: dateAt(initial.anchorDate, 2), amountPaise: 700000 });
  expect(saved.plan.peakGapPaise).toBe(1600000);
  const salary = page.getByRole('article', { name: 'Salary', exact: true });
  const focus = page.getByRole('article', { name: 'Plan focus', exact: true });
  await expect(salary).toContainText(dateLabel(saved.facts.records[0].schedule.date!));
  await expect(salary).toContainText(money(saved.facts.records[0].amount.amountPaise));
  await expect(focus).toContainText(money(saved.plan.firstGap!.amountPaise));
  await expect(focus).toContainText(`Largest gap: ${money(saved.plan.peakGapPaise)}`);
  await expect(page.locator('.context-scroll > .fact-grid > article')).toHaveCount(5);
  expect(await page.locator('.context-scroll > .fact-grid > article').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
    .toEqual(['Money available', 'Salary', 'Rent', 'Loan', 'Food']);
  await stable(page, ready, 'first financial SSE commit');
  const picture = await geometry(page);
  expect(picture.boxes.some(box => box.selector === '.context-scroll')).toBe(true);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onLLMFunctionCallStopped!({ tool_call_id: 'fixture-save', cancelled: false }));
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await stable(page, picture, 'financial save completed');
  await layout(page);
  await salary.scrollIntoViewIfNeeded();
  await expect(salary).toBeInViewport({ ratio: 0.99 });
  await stable(page, picture, 'reported figure scrolled into view');
  await page.screenshot({ path: testInfo.outputPath('provider-double-live.png'), fullPage: true });

  const proposed = await page.request.post('/api/session/commands', { data: {
    commandId: randomUUID(), expectedRevision: saved.revision,
    operation: { type: 'previewAdjustments', adjustments: [{ eventId: `optional:${dateAt(initial.anchorDate, 16)}`, amount: '0' }] },
  } satisfies Command });
  expect(proposed.status()).toBe(200);
  const preview = await proposed.json() as Snapshot;
  expect(preview.facts).toEqual(saved.facts);
  expect(preview.plan).toEqual(saved.plan);
  await expect(page.locator('.proposal-notice').getByRole('status')).toHaveText('Proposal to review · Not saved');
  await stable(page, picture, 'proposal announcement');
  const reviewProposal = page.getByRole('button', { name: 'Review proposed change', exact: true });
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toBeVisible();
  await reviewProposal.click();
  await expect(proposal.getByRole('heading', { name: 'Spending change preview', exact: true })).toBeFocused();
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await expect(proposal).toContainText('Optional purchase');
  await expect(proposal).toContainText('₹2,000.00 reported → ₹0.00 assumed');
  await expect(proposal).toContainText(`A cash gap remains on ${dateLabel(saved.plan.firstGap!.date)}.`);
  for (const [name, plan, closing] of [
    ['Before · reported figures', preview.plan, 'Projected closing cash'],
    ['After · preview', preview.preview!.plan, 'Assumed closing cash'],
  ] as const) {
    const comparison = proposal.getByRole('region', { name, exact: true });
    for (const [label, value] of [
      ['First cash gap', `${money(plan.firstGap!.amountPaise)} · ${dateLabel(plan.firstGap!.date)}`],
      ['Largest cash gap', `${money(plan.peakGapPaise)}${plan.peakGapDate ? ` · ${dateLabel(plan.peakGapDate)}` : ''}`],
      [closing, money(plan.closingPaise)],
    ]) {
      await expect(comparison.locator('.comparison-values > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText(value);
    }
  }
  await expect(proposal.getByRole('checkbox')).not.toBeChecked();
  await expect(proposal.getByRole('checkbox')).toHaveAccessibleName(/unconditionally—not dependent on uncertain income or payee agreement/);
  await expect(proposal.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  await expect(proposal.getByRole('button', { name: 'Reject preview' })).toBeEnabled();
  expect((await current(page)).accepted).toBeNull();
  await expect(focus).toContainText(money(saved.plan.firstGap!.amountPaise));
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await stable(page, picture, 'inline proposal reviewed');

  const end = page.getByRole('button', { name: 'End conversation', exact: true });
  await end.focus();
  const correction = draftFacts(saved);
  correction.records[0].schedule.date = dateAt(initial.anchorDate, 1);
  const corrected = await submit(page, saved, { type: 'replaceFacts', facts: correction });
  expect(corrected.plan.firstGap).toBeNull();
  expect(corrected.plan.peakGapPaise).toBe(0);
  expect(corrected.facts.records[0].schedule.date).not.toBe(saved.facts.records[0].schedule.date);
  await expect(salary).toContainText(dateLabel(corrected.facts.records[0].schedule.date!));
  await expect(salary).not.toContainText(dateLabel(saved.facts.records[0].schedule.date!));
  await expect(focus).toContainText('Known commitments look covered');
  await expect(focus).not.toContainText('First cash gap');
  await expect(focus).not.toContainText('₹16,000.00');
  await expect(proposal).toHaveCount(0);
  await expect(page.locator('.context-updates [aria-live="polite"]')).toHaveText(`Latest saved change: Salary: ${dateLabel(saved.facts.records[0].schedule.date!)} → ${dateLabel(corrected.facts.records[0].schedule.date!)}`);
  await expect(end).toBeFocused();
  expect(await page.locator('.context-scroll > .fact-grid > article').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
    .toEqual(['Money available', 'Salary', 'Rent', 'Loan', 'Food']);
  await stable(page, picture, 'salary correction and proposal invalidation over SSE');
  const note = page.locator('.change-note');
  await expect(note).toHaveCSS('white-space', 'nowrap');
  await expect(note).toHaveCSS('text-overflow', 'ellipsis');
  expect(await note.evaluate(element => element.clientHeight <= Number.parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true);
  const changes = page.getByRole('button', { name: 'Recent changes', exact: true });
  await changes.click();
  const changeDialog = page.getByRole('dialog', { name: 'Recent changes', exact: true });
  await modal(page, changeDialog, 'Recent changes', picture);
  await expect(changeDialog.getByRole('listitem')).toHaveText([`Salary: ${dateLabel(saved.facts.records[0].schedule.date!)} → ${dateLabel(corrected.facts.records[0].schedule.date!)}`]);
  await page.keyboard.press('Escape');
  await expect(changeDialog).toBeHidden();
  await expect(changes).toBeFocused();
  await stable(page, picture, 'recent changes dismissed');
  await page.screenshot({ path: testInfo.outputPath('provider-double-corrected.png'), fullPage: true });
  await end.click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'review');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your 30-day plan.');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(await page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(1);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
  expect(await current(page)).toEqual(corrected);
  await page.screenshot({ path: testInfo.outputPath('provider-double-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Finish review' }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'finished');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your next step is clearer.');
  expect(await current(page)).toEqual(corrected);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-finished.png'), fullPage: true });
  const exported = await page.request.get('/api/session/export', { maxRedirects: 0 });
  expect(exported.status()).toBe(200);
  const text = await exported.text();
  expect(text).toContain('Salary');
  expect(text).toContain(corrected.facts.records[0].schedule.date!);
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download plan', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('cashflow.txt');
  expect(await file.failure()).toBeNull();
  const stream = await file.createReadStream();
  const contents: Buffer[] = [];
  for await (const chunk of stream!) contents.push(Buffer.from(chunk));
  expect(Buffer.concat(contents).toString('utf8')).toBe(text);
});

test('provider double: accept an exact whole proposal, replace consent and restore removed assumptions over real HTTP/SSE', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  const ready = await geometry(page);
  await page.getByRole('button', { name: 'Start talking' }).click();
  await connected(page, ready);
  const initial = await current(page);
  const facts: FactsInput = { opening: { amount: '5000', status: 'exact' }, reserve: '0',
    coverage: { income: 'reviewed', essential: 'reviewed', debt: 'reviewed', optional: 'reviewed' }, records: [
      { id: 'salary', label: 'Salary', kind: 'income', autoDebit: false, reliability: 'reliable',
        amount: { amount: '30000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 10), recurrence: 'once' } },
      { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false,
        amount: { amount: '12000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once' } },
      { id: 'card', label: 'Card', kind: 'debt', debtType: 'card', autoDebit: false, controllability: 'controllable',
        amount: { amount: '2000', status: 'exact' }, target: { amount: '4000', status: 'exact' }, outstanding: { amount: '90000', status: 'exact' },
        schedule: { date: dateAt(initial.anchorDate, 15), recurrence: 'once' } },
      { id: 'optional', label: 'Optional purchase', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 16), recurrence: 'once' } },
    ] };
  const baseline = await submit(page, initial, { type: 'replaceFacts', facts });
  expect(baseline.plan.firstGap).toEqual({ date: dateAt(initial.anchorDate, 2), amountPaise: 700000 });
  const adjustments = [
    { eventId: `card:${dateAt(initial.anchorDate, 15)}`, amount: '2000' },
    { eventId: `optional:${dateAt(initial.anchorDate, 16)}`, amount: '0' },
  ];
  const pending = await submit(page, baseline, { type: 'previewAdjustments', adjustments });
  expect(pending.preview!.adjustments.every(item => item.acceptanceReady)).toBe(true);
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toBeVisible();
  await page.getByRole('button', { name: 'Review proposed change', exact: true }).click();
  await expect(proposal.getByRole('heading', { name: 'Spending change preview' })).toBeFocused();
  await expect(proposal.getByRole('list', { name: 'Planning assumptions' }).getByRole('listitem')).toHaveCount(2);
  await expect(proposal).toContainText('₹4,000.00 reported → ₹2,000.00 assumed');
  await expect(proposal).toContainText('₹2,000.00 reported → ₹0.00 assumed');
  await expect(proposal).toContainText('Minimum is not payoff');
  await expect(proposal).toContainText(`A cash gap remains on ${dateLabel(baseline.plan.firstGap!.date)}.`);
  await expect(proposal.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  const consent = proposal.getByRole('checkbox');
  await consent.focus(); await page.keyboard.press('Space');
  await expect(consent).toBeChecked();
  expect((await current(page)).accepted).toBeNull();
  const replacement = await submit(page, pending, { type: 'previewAdjustments',
    adjustments: [adjustments[0], { ...adjustments[1], amount: '123.45' }] });
  expect(replacement.revision).toBe(pending.revision);
  expect(replacement.sequence).toBeGreaterThan(pending.sequence);
  expect(replacement.preview!.id).not.toBe(pending.preview!.id);
  await expect(consent).not.toBeChecked();
  await expect(consent).toBeFocused();
  await expect(proposal).toContainText('₹2,000.00 reported → ₹123.45 assumed');
  await expect(proposal.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  await consent.check();
  const accepted = await actOnPlan(page, 'Accept planning assumptions', replacement,
    { type: 'acceptPreview', previewId: replacement.preview!.id, confirmed: true, consentScope: 'unconditional' });
  await expect(proposal).toHaveCount(0);
  expect(accepted.facts).toEqual(baseline.facts);
  expect(accepted.plan).toEqual(baseline.plan);
  expect(accepted.accepted!.adjustments).toHaveLength(2);
  expect(accepted.accepted!.plan.firstGap).toEqual(baseline.plan.firstGap);
  const removals = await submit(page, accepted, { type: 'previewAdjustments', adjustments: [adjustments[0]] });
  expect(removals.preview!.removedAssumptionIds).toEqual([adjustments[1].eventId]);
  expect(removals.preview!.adjustments).toHaveLength(1);
  await expect(proposal).toContainText('Accepting replaces all saved assumptions; changes do not stack.');
  await expect(proposal.getByRole('list', { name: 'Removed assumptions' })).toContainText(
    `Optional purchase · ${dateLabel(dateAt(initial.anchorDate, 16))} · ₹123.45 assumed → ₹2,000.00 reported`);
  await expect(proposal.getByRole('list', { name: 'Planning assumptions' })).toContainText('Consent saved for this occurrence');
  await expect(consent).not.toBeChecked();
  await expect(consent).toHaveAccessibleName(/including removals, unconditionally—not dependent on uncertain income or payee agreement/);
  await consent.check();
  await expect(page.getByRole('button', { name: 'End conversation', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Your figures', exact: true })).toBeDisabled();
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await stable(page, ready, 'whole replacement proposal and removals');
  await page.screenshot({ path: testInfo.outputPath('provider-double-whole-proposal.png'), fullPage: true });
  const confirmed = await actOnPlan(page, 'Accept planning assumptions', removals,
    { type: 'acceptPreview', previewId: removals.preview!.id, confirmed: true, consentScope: 'unconditional' });
  await expect(proposal).toHaveCount(0);
  expect(confirmed.accepted!.adjustments.map(item => item.eventId)).toEqual([adjustments[0].eventId]);
  expect(confirmed.facts).toEqual(baseline.facts);
  expect(confirmed.accepted!.plan.firstGap).toEqual(baseline.plan.firstGap);
  expect(confirmed.accepted!.plan.closingPaise).toBe(1900000);
  await expect(page.getByRole('article', { name: 'Card', exact: true })).toContainText('Reported outstanding: ₹90,000.00');
  await expect(page.getByRole('article', { name: 'Plan focus', exact: true })).toContainText('₹7,000.00');
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'review');
  await expect(page.locator('.review-numbers')).toContainText(money(confirmed.accepted!.plan.closingPaise));
  const exported = await page.request.get('/api/session/export', { maxRedirects: 0 });
  expect(exported.status()).toBe(200);
  expect(await exported.text()).toContain('reduced planned outflow');
  expect(await exported.text()).toContain(decimal(confirmed.accepted!.plan.closingPaise!));
  expect((await current(page)).accepted).toEqual(confirmed.accepted);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
});

test('provider double: unavailable opening and coverage answers advance the real selected question without inventing figures', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  const ready = await geometry(page);
  await page.getByRole('button', { name: 'Start talking' }).click();
  await connected(page, ready);
  const initial = await current(page);
  expect(initial.plan.decisionAssessment!.nextActionId).toBe('clarify:opening');
  await expect(page.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
  const deferred = await actOnPlan(page, 'I cannot confirm this now', initial,
    { type: 'respondToAction', actionId: initial.plan.decisionAssessment!.nextActionId!, response: 'unavailable' });
  expect(deferred.plan.decisionAssessment!.nextActionId).toBe('clarify:coverage');
  const question = deferred.plan.decisionAssessment!.uncertainties!.find(item => item.id === deferred.plan.decisionAssessment!.nextQuestionId)!;
  await expect(page.locator('.focus-action')).toHaveText(question.question);
  await expect(page.getByLabel('Saved answers', { exact: true })).toContainText('Unconfirmed details remain open.');
  expect(deferred.facts.opening).toEqual(initial.facts.opening);
  expect(deferred.facts.coverage).toEqual(initial.facts.coverage);
  const qualified = await actOnPlan(page, 'I cannot confirm this now', deferred,
    { type: 'respondToAction', actionId: deferred.plan.decisionAssessment!.nextActionId!, response: 'unavailable' });
  const assessment = qualified.plan.decisionAssessment!;
  expect(assessment.nextQuestionId).toBeNull();
  expect(assessment.actions!.find(action => action.id === assessment.nextActionId)!.kind).toBe('reviewOutcome');
  expect(assessment.outcome!.readiness).toBe('qualified');
  expect(qualified.facts.decision!.responses).toHaveLength(2);
  expect(qualified.facts.opening.amountPaise).toBeNull();
  expect(qualified.facts.coverage).toEqual(initial.facts.coverage);
  expect(qualified.facts.records).toEqual([]);
  expect(qualified.plan.closingPaise).toBeNull();
  await expect(page.getByRole('button', { name: 'I cannot confirm this now' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Your financial picture', exact: true })).not.toContainText(/₹0\.00|Known commitments look covered/);
  await stable(page, ready, 'unavailable answers preserve unknown cash');
  await page.getByRole('button', { name: 'Open questions' }).click();
  const questions = page.getByRole('dialog', { name: 'Open questions', exact: true });
  for (const item of assessment.uncertainties!) await expect(questions).toContainText(item.question);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('provider-double-unavailable-answers.png'), fullPage: true });
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'review');
  await expect(page.locator('.review-numbers')).toContainText('Unknown');
  expect(await current(page)).toEqual(qualified);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
});

test('provider double: reject a preview without declining its cut, then explicitly decline and retain the real early gap', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  const ready = await geometry(page);
  await page.getByRole('button', { name: 'Start talking' }).click();
  await connected(page, ready);
  const initial = await current(page);
  const baseline = await submit(page, initial, { type: 'replaceFacts', facts: {
    opening: { amount: '1000', status: 'exact' }, reserve: '0',
    coverage: { income: 'none', essential: 'reviewed', debt: 'none', optional: 'reviewed' }, records: [
      { id: 'purchase', label: 'Purchase', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '800', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once' } },
      { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false,
        amount: { amount: '500', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 3), recurrence: 'once' } },
      { id: 'trip', label: 'Trip', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '100', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 9), recurrence: 'once' } },
    ],
  } });
  const assessment = baseline.plan.decisionAssessment!;
  const action = assessment.actions!.find(item => item.id === assessment.nextActionId)!;
  const choice = assessment.choices!.find(item => item.id === action.choiceId)!;
  expect(action.kind).toBe('previewChange');
  expect(baseline.plan.firstGap).toEqual({ date: dateAt(initial.anchorDate, 3), amountPaise: 30000 });
  const adjustments = choice.adjustmentAmounts.map(item => ({ eventId: item.eventId, amount: decimal(item.amountPaise) }));
  const pending = await submit(page, baseline, { type: 'previewAdjustments', adjustments });
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText('Rejecting this preview does not mark any suggested cut as declined.');
  const discarded = await actOnPlan(page, 'Reject preview', pending, { type: 'discardPreview', previewId: pending.preview!.id });
  await expect(proposal).toHaveCount(0);
  expect(discarded.facts).toEqual(baseline.facts);
  expect(discarded.facts.decision!.responses).toEqual([]);
  expect(discarded.plan.decisionAssessment!.nextActionId).toBe(action.id);
  await expect(page.getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
  await expect(page.getByLabel('Saved answers', { exact: true })).toHaveCount(0);
  const proposed = await submit(page, discarded, { type: 'previewAdjustments', adjustments });
  await expect(proposal).toBeVisible();
  const declined = await actOnPlan(page, 'Do not suggest this cut', proposed, { type: 'respondToAction', actionId: action.id, response: 'declined' });
  await expect(proposal).toHaveCount(0);
  expect(declined.accepted).toBeNull();
  expect(declined.facts.records).toEqual(baseline.facts.records);
  expect(declined.plan.events).toEqual(baseline.plan.events);
  expect(declined.plan.firstGap).toEqual(baseline.plan.firstGap);
  expect(declined.facts.decision!.responses!.map(item => ({ actionId: item.actionId, response: item.response })))
    .toEqual([{ actionId: action.id, response: 'declined' }]);
  const next = declined.plan.decisionAssessment!.actions!.find(item => item.id === declined.plan.decisionAssessment!.nextActionId)!;
  expect(next.kind).toBe('contactPayee');
  expect(next.recordIds).toContain('rent');
  await expect(page.locator('.focus-action')).toHaveText(next.question);
  await expect(page.getByRole('article', { name: 'Plan focus', exact: true })).toContainText('₹300.00');
  await expect(page.getByLabel('Saved answers', { exact: true })).toContainText('Declined cuts are not assumed.');
  await expect(page.getByRole('button', { name: 'Do not suggest this cut' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Your figures', exact: true })).toBeDisabled();
  await stable(page, ready, 'declined cut and unresolved rent gap');
  await page.screenshot({ path: testInfo.outputPath('provider-double-declined-cut.png'), fullPage: true });
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'review');
  await expect(page.getByRole('region', { name: 'Next steps', exact: true })).toContainText(next.question);
  expect(await current(page)).toEqual(declined);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
});

test('provider-double: overlapping purchase refusal shows visible guidance without mutation over real HTTP/SSE', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
  await expect(picture.getByRole('alert')).toHaveCount(0);
  const ready = await geometry(page);
  await page.getByRole('button', { name: 'Start talking' }).click();
  await connected(page, ready);
  await expect(picture.getByText(/Your session is saved|Your answer is saved/)).toHaveCount(0);
  const initial = await current(page);
  const baseline = await submit(page, initial, { type: 'replaceFacts', facts: {
    opening: { amount: '1000', status: 'exact' }, reserve: '0',
    coverage: { income: 'none', essential: 'reviewed', debt: 'none', optional: 'reviewed' }, records: [
      { id: 'purchase', label: 'Purchase', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '800', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once' } },
      { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false,
        amount: { amount: '500', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 3), recurrence: 'once' } },
      { id: 'trip', label: 'Trip', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '100', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 9), recurrence: 'once' } },
    ],
  } });
  const assessment = baseline.plan.decisionAssessment!;
  const action = assessment.actions!.find(item => item.id === assessment.nextActionId)!;
  const choice = assessment.choices!.find(item => item.id === action.choiceId)!;
  expect(action.kind).toBe('previewChange');
  expect(choice.kind).toBe('reduceOptional');
  expect(choice.adjustmentAmounts).toEqual([{ eventId: `purchase:${dateAt(initial.anchorDate, 1)}`, amountPaise: 0 }]);
  expect(baseline.plan.firstGap).toEqual({ date: dateAt(initial.anchorDate, 3), amountPaise: 30000 });
  const pending = await submit(page, baseline, { type: 'previewAdjustments',
    adjustments: [{ eventId: choice.adjustmentAmounts[0].eventId, amount: '500' }] });
  expect(pending.facts).toEqual(baseline.facts);
  expect(pending.plan).toEqual(baseline.plan);
  expect(pending.accepted).toBeNull();
  const proposal = picture.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toContainText('₹800.00 reported → ₹500.00 assumed');
  await expect(picture.locator('.focus-action')).toHaveText(action.question);
  await expect(proposal.getByRole('checkbox')).not.toBeChecked();
  const commands: Command[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/session/commands' && request.method() === 'POST') commands.push(request.postDataJSON() as Command);
  });
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/commands' && response.request().method() === 'POST');
  await picture.getByRole('button', { name: 'Do not suggest this cut' }).click();
  const conflict = await response;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'stalePreview', snapshot: pending });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({ commandId: expect.any(String), expectedRevision: pending.revision,
    operation: { type: 'respondToAction', actionId: action.id, response: 'declined' } });
  const feedback = picture.getByRole('region', { name: 'Financial picture details', exact: true }).getByRole('alert');
  await expect(feedback).toHaveText('Your answer was not saved because the open proposal differs from this suggested cut. Review the proposal or choose “Reject preview” before answering again.');
  // Mobile device scale can clip a fractional pixel at the panel border.
  await expect(feedback).toBeInViewport({ ratio: 0.99 });
  const feedbackBounds = await feedback.boundingBox();
  expect(feedbackBounds).not.toBeNull();
  expect(feedbackBounds!.y).toBeGreaterThanOrEqual(-1);
  expect(feedbackBounds!.y + feedbackBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await expect(feedback).not.toHaveClass(/sr-only/);
  await expect(page.getByText(/no longer available to accept|Pending proposal differs from this choice/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry same action' })).toHaveCount(0);
  await expect(picture.getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
  await expect(proposal.getByRole('button', { name: 'Reject preview' })).toBeEnabled();
  await expect(proposal.getByRole('checkbox')).not.toBeChecked();
  await expect(proposal.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  await expect(picture.getByLabel('Saved answers', { exact: true })).toHaveCount(0);
  await expect(picture.getByRole('article', { name: 'Money available', exact: true })).toContainText('₹1,000.00');
  await expect(picture.getByRole('article', { name: 'Purchase', exact: true })).toContainText('₹800.00');
  await expect(picture.getByRole('article', { name: 'Plan focus', exact: true })).toContainText('₹300.00');
  expect(await current(page)).toEqual(pending);
  await expect(page.getByRole('button', { name: 'Your figures', exact: true })).toBeDisabled();
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await stable(page, ready, 'overlapping refusal feedback inside the financial scroller');
  await page.screenshot({ path: testInfo.outputPath('provider-double-overlap-conflict.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review proposed change', exact: true }).click();
  await expect(proposal.getByRole('heading', { name: 'Spending change preview', exact: true })).toBeFocused();
  expect(await current(page)).toEqual(pending);
  const discarded = await actOnPlan(page, 'Reject preview', pending, { type: 'discardPreview', previewId: pending.preview!.id });
  await expect(proposal).toHaveCount(0);
  await expect(feedback).toHaveCount(0);
  expect(discarded.facts).toEqual(baseline.facts);
  expect(discarded.facts.decision!.responses).toEqual([]);
  expect(discarded.plan).toEqual(baseline.plan);
  expect(discarded.accepted).toEqual(pending.accepted);
  expect(discarded.revision).toBe(pending.revision);
  expect(discarded.preview).toBeNull();
  expect(discarded.plan.decisionAssessment!.nextActionId).toBe(action.id);
  await expect(picture.getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
  await expect(picture.getByLabel('Saved answers', { exact: true })).toHaveCount(0);
  await expect(picture.getByText(/Preview rejected|Your answer is saved/)).toHaveCount(0);
  expect(commands.map(command => command.operation)).toEqual([
    { type: 'respondToAction', actionId: action.id, response: 'declined' },
    { type: 'discardPreview', previewId: pending.preview!.id },
  ]);
  expect(commands[1].commandId).not.toBe(commands[0].commandId);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'review');
  expect(await current(page)).toEqual(discarded);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
});

test('provider double: live capture, interruption, bounded captions, disconnection and clean retry', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  await expect(page.locator('.voice-status')).toHaveText('Ready when you are');
  const ready = await geometry(page);
  await page.getByRole('button', { name: 'Start talking' }).click();
  await connected(page, ready);
  const snapshot = await current(page);
  const events = () => page.locator('.voice-status');
  await page.evaluate(() => window.voiceFixture.clients[0].stopCapture());
  await expect(events()).toHaveText('Microphone not connected');
  await stable(page, ready, 'capture stopped');
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserStartedSpeaking!());
  await expect(events()).not.toContainText(/Listening|listening/);
  await page.evaluate(async () => {
    await window.voiceFixture.clients[0].initDevices();
    window.voiceFixture.clients[0].callbacks.onUserStoppedSpeaking!();
  });
  await expect(events()).toHaveText('Listening');
  await stable(page, ready, 'capture restored');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(events()).toHaveText('Microphone muted');
  await stable(page, ready, 'muted');
  expect(await page.evaluate(() => window.voiceFixture.clients[0].tracks().local.audio!.enabled)).toBe(false);
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserMuteStarted!());
  await expect(events()).toHaveText('Listening paused');
  await stable(page, ready, 'listening paused');
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onUserMuteStopped!();
    callbacks.onBotLlmStarted!();
  });
  await expect(events()).toHaveText('Thinking');
  await stable(page, ready, 'generating');
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onBotLlmStopped!();
    callbacks.onBotStartedSpeaking!();
    callbacks.onBotOutput!({ text: 'Synthetic spoken prefix. Unspoken tail.', segment_id: 7, will_be_spoken: true, spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Synthetic spoken prefix.', remaining_text: 'Unspoken tail.' } });
  });
  await expect(events()).toHaveText('Speaking');
  await expect(page.getByRole('region', { name: 'Live caption' })).toContainText('Synthetic spoken prefix.');
  await stable(page, ready, 'speaking');
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserStartedSpeaking!());
  await expect(events()).toHaveText('Interrupted · listening');
  await stable(page, ready, 'interrupted');
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onBotStoppedSpeaking!();
    callbacks.onBotOutput!({ text: 'Synthetic spoken prefix. Unspoken tail.', segment_id: 7, will_be_spoken: true, spoken_status: 'completed' });
    callbacks.onUserStoppedSpeaking!();
  });
  await expect(page.getByRole('region', { name: 'Live caption' })).toContainText('Synthetic spoken prefix.');
  await expect(page.getByText('Synthetic spoken prefix. Unspoken tail.', { exact: true })).toHaveCount(0);
  await expect(events()).toHaveText('Listening');
  await stable(page, ready, 'speaking stopped');
  const captionBounds = await page.locator('.caption-history-scroll').boundingBox();
  const parentBounds = await page.locator('.captions').boundingBox();
  const end = page.getByRole('button', { name: 'End conversation', exact: true });
  await end.focus();
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    for (let index = 0; index < 29; index++) callbacks.onUserTranscript!({ text: `Synthetic caption ${index}: ${'these are fabricated test words, not a recording. '.repeat(6)}`, final: true, timestamp: `fixture-${index}`, user_id: 'fixture-user' });
    callbacks.onUserTranscript!({ text: 'Synthetic partial words', final: false, timestamp: 'fixture-partial', user_id: 'fixture-user' });
    callbacks.onBotOutput!({ text: 'Synthetic generated but unspoken text', will_be_spoken: false, spoken_status: 'completed' });
  });
  const transcript = page.getByRole('list', { name: 'Conversation transcript', exact: true });
  await expect(transcript.getByRole('listitem')).toHaveCount(30);
  await expect(transcript).toContainText('Synthetic spoken prefix.');
  await expect(transcript).toContainText('Synthetic caption 0:');
  await expect(transcript).toContainText('Synthetic caption 25:');
  await expect(transcript).toContainText('Synthetic caption 28:');
  await expect(transcript).not.toContainText('Synthetic partial words');
  await expect(page.getByText('Synthetic generated but unspoken text', { exact: true })).toHaveCount(0);
  await expect(end).toBeFocused();
  await stable(page, ready, '29 growing captions and interim words');
  const captions = page.locator('.caption-history-scroll');
  await expect(captions).toHaveCSS('overflow-y', 'auto');
  expect(await captions.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight > 0)).toBe(true);
  const grown = await captions.boundingBox();
  const parent = await page.locator('.captions').boundingBox();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(grown![key] - captionBounds![key]), `Caption scroller ${key}`).toBeLessThanOrEqual(1);
    expect(Math.abs(parent![key] - parentBounds![key]), `Fixed caption parent ${key}`).toBeLessThanOrEqual(1);
  }
  const captionParent = await page.locator('.captions').evaluate(element => ({
    overflow: getComputedStyle(element).overflowY, top: element.scrollTop,
    excess: element.scrollHeight - element.clientHeight,
  }));
  expect(['auto', 'scroll']).not.toContain(captionParent.overflow);
  expect(captionParent.top).toBe(0);
  expect(captionParent.excess).toBeLessThanOrEqual(1);
  await captions.focus();
  await page.keyboard.press('End');
  await expect.poll(() => captions.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await stable(page, ready, 'keyboard scroll within captions');
  await page.keyboard.press('Home');
  await expect.poll(() => captions.evaluate(element => element.scrollTop)).toBe(0);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserTranscript!({
    text: 'Synthetic caption while reading history', final: true, timestamp: 'history-reading', user_id: 'fixture-user',
  }));
  await expect(captions).toBeFocused();
  expect(await captions.evaluate(element => element.scrollTop)).toBe(0);
  const latest = page.getByRole('button', { name: 'Latest captions', exact: true });
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(latest).toBeFocused();
  await expect.poll(() => captions.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  await stable(page, ready, 'reading and resuming inline caption history');
  await expect(page.getByRole('dialog', { name: 'Conversation history' })).toHaveCount(0);
  const privacy = page.getByRole('button', { name: 'Privacy', exact: true });
  await privacy.click();
  const privacyDialog = page.getByRole('dialog', { name: 'Privacy', exact: true });
  await modal(page, privacyDialog, 'Privacy', ready);
  await page.keyboard.press('Escape');
  await expect(privacyDialog).toBeHidden();
  await expect(privacy).toBeFocused();
  await stable(page, ready, 'live privacy dismissed');
  await expect(end).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-captions.png'), fullPage: true });

  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onDisconnected!());
  await expect(events()).toHaveText('Disconnected');
  await expect(page.getByRole('alert')).toContainText('The audio connection closed. Check your internet connection, then reconnect.');
  await stable(page, ready, 'disconnected');
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(await page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(1);
  await page.evaluate(() => { window.voiceFixture.connectError = true; });
  await page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect' }).click();
  await expect(events()).toHaveText('Unable to connect');
  await expect(page.getByRole('alert')).toContainText('Check your connection and microphone');
  await stable(page, ready, 'connection failed');
  await expect(transcript.getByRole('listitem')).toHaveCount(0);
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(await page.evaluate(() => window.voiceFixture.clients[1].disconnects)).toBe(1);
  await page.evaluate(() => { window.voiceFixture.connectError = false; });
  await page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect' }).click();
  await connected(page, ready, 3);
  // A disposed client's late events must not resurrect its captions or connection state.
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onBotReady!({ version: '2.1.0' });
    callbacks.onUserTranscript!({ text: 'Stale synthetic caption', final: true, timestamp: 'late', user_id: 'fixture-user' });
    callbacks.onDisconnected!();
  });
  await expect(events()).toHaveText('Listening');
  await expect(page.getByText('Stale synthetic caption', { exact: true })).toHaveCount(0);
  await stable(page, ready, 'retry ignores disposed client events');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[2].callbacks;
    callbacks.onUserTranscript!({ text: `Synthetic enlarged-text caption: ${'These are test words for readable wrapping. '.repeat(12)}`, final: true, timestamp: 'enlarged', user_id: 'fixture-user' });
    callbacks.onBotStartedSpeaking!();
  });
  await expect(events()).toHaveText('Speaking');
  await expect(page.getByRole('region', { name: 'Live caption' })).toContainText('Synthetic enlarged-text caption:');
  await page.evaluate(() => window.voiceFixture.clients[2].callbacks.onUserStartedSpeaking!());
  await expect(events()).toHaveText('Interrupted · listening');
  await page.evaluate(() => {
    window.voiceFixture.clients[2].callbacks.onBotStoppedSpeaking!();
    window.voiceFixture.clients[2].callbacks.onUserStoppedSpeaking!();
  });
  const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('main *, header *, footer *')).flatMap(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.width && (bounds.right > innerWidth + 1 || bounds.left < -1 || element.scrollWidth > element.clientWidth + 1) ? [{ element: element.className || element.tagName, left: bounds.left, right: bounds.right, width: element.clientWidth, content: element.scrollWidth }] : [];
  }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(overflow)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  expect(await page.evaluate(() => !['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY))).toBe(true);
  const clipped = await page.locator('.conversation-controls button, .voice-status').evaluateAll(elements => elements.flatMap(element => {
    const bounds = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects()).some(text => text.left < bounds.left - 1 || text.right > bounds.right + 1 || text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1)
      ? [element.textContent] : [];
  }));
  expect(clipped, 'Enlarged status and control labels must remain readable').toEqual([]);
  expect(await page.locator('.conversation-controls').evaluate(element => {
    const bottom = element.getBoundingClientRect().bottom;
    return [...element.querySelectorAll('button')].every(button => button.getBoundingClientRect().bottom <= bottom + 1);
  }), 'Wrapped voice controls must not overlap captions').toBe(true);
  await expect(page.getByRole('link', { name: 'Skip to main content' })).not.toBeInViewport();
  const mute = page.getByRole('button', { name: 'Mute microphone', exact: true });
  await end.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(mute).toBeFocused();
  await expect(mute).toBeInViewport({ ratio: 0.99 });
  await page.keyboard.press('Enter');
  await expect(events()).toHaveText('Microphone muted');
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(events()).toHaveText('Listening');
  await page.keyboard.press('Tab');
  await expect(end).toBeFocused();
  await expect(end).toBeInViewport({ ratio: 0.99 });
  await page.screenshot({ path: testInfo.outputPath('provider-double-enlarged-text.png'), fullPage: true });
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toHaveAttribute('data-view', 'review');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ready to talk again?');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  expect(await current(page)).toEqual(snapshot);
  expect(await page.evaluate(() => window.voiceFixture.clients.map(client => client.disconnects))).toEqual([1, 1, 1]);
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(3);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(3);
});
