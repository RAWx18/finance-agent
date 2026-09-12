// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import type { CallState, Command, Snapshot } from '../../src/api';
import type {} from '../voiceSdk';
import { signIn } from './authSupport';

let bundle: string;
let styles: string;
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'], serviceWorkers: 'block' });
test.beforeAll(async () => {
  const sdk = fileURLToPath(new URL('../voiceSdk.ts', import.meta.url));
  const output = await build({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, logLevel: 'error',
    resolve: { alias: [{ find: '@pipecat-ai/client-js', replacement: sdk }, { find: '@pipecat-ai/daily-transport', replacement: sdk }] },
    build: { write: false, minify: false, rollupOptions: { input: fileURLToPath(new URL('../../src/main.tsx', import.meta.url)), output: { codeSplitting: false } } } });
  if ('on' in output) throw new Error('The companion check must not start a watcher.');
  const files = (Array.isArray(output) ? output : [output]).flatMap(item => item.output);
  const chunks = files.filter(item => item.type === 'chunk');
  expect(chunks).toHaveLength(1);
  expect(Object.keys(chunks[0].modules).filter(id => /node_modules\/(?:@pipecat-ai|@daily-co)\//.test(id))).toEqual([]);
  bundle = chunks[0].code;
  styles = files.flatMap(item => item.type === 'asset' && item.fileName.endsWith('.css') ? [item.source] : []).join('\n');
});

test('live companion edits recalculate canonical cards with durable human provenance', async ({ page, context, baseURL }, info) => {
  const origin = new URL(baseURL!).origin;
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
  expect(process.env.E2E_DATA_DIR).toBeTruthy();
  await context.setExtraHTTPHeaders({ Origin: origin });
  const blocked: string[] = [];
  const errors: string[] = [];
  let call: CallState = { callId: null, status: 'idle', cleanupConfirmed: true, message: null };
  const entry = (await (await context.request.get('/login')).text()).match(/<script\b[^>]*\bsrc="([^"]+)"/);
  expect(entry).not.toBeNull();
  await context.routeWebSocket('**', socket => { blocked.push(socket.url()); socket.close(); });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { blocked.push(url.origin); await route.abort(); return; }
    if (url.pathname === '/api/session/call') {
      // All room operations terminate here; finance/auth/SSE remain the actual backend.
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { callId: string; conversationSlug?: string };
        const saved: Snapshot = await (await context.request.get('/api/session')).json();
        expect(body.conversationSlug).toBe(saved.conversationSlug);
        expect(call.cleanupConfirmed).toBe(true);
        call = { callId: body.callId, conversationSlug: saved.conversationSlug, status: 'connecting', cleanupConfirmed: false, message: null };
        await route.fulfill({ json: { callId: body.callId, conversationSlug: saved.conversationSlug, url: 'https://voice-fixture.daily.co/room',
          token: 'synthetic-provider-double', expiresAt: new Date(Date.now() + 1800000).toISOString() } });
      } else if (request.method() === 'DELETE') {
        expect(request.postDataJSON()).toEqual({ callId: call.callId });
        call = { ...call, status: 'ended', cleanupConfirmed: true }; await route.fulfill({ json: call });
      } else if (request.method() === 'GET') await route.fulfill({ json: call });
      else { blocked.push(request.method()); await route.abort(); }
    } else if (url.pathname === entry![1]) await route.fulfill({ contentType: 'application/javascript', body: bundle });
    else if (/^\/assets\/[^/]+\.css$/.test(url.pathname)) await route.fulfill({ contentType: 'text/css', body: styles });
    else if (url.pathname === '/api/settings') {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), voiceAvailable: true, voiceUnavailableReason: null } });
    } else await route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  let release: (() => void) | undefined;
  try {
    await signIn(page);
    const auth = await (await context.request.get('/api/auth/session')).json();
    const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));
    const seed = spawnSync('uv', ['run', '--project', backend, '--locked', 'python', '-m', 'tests.history_support', auth.user.id],
      { cwd: backend, env: process.env, encoding: 'utf8' });
    expect(seed.status, seed.stderr).toBe(0);
    const slug = (await (await context.request.get('/api/history')).json()).conversations[0].slug as string;
    const selection = await context.request.post(`/api/history/${slug}/continue`, { data: {} });
    expect(selection.status()).toBe(200);
    let saved: Snapshot = await selection.json();
    await page.goto(`/app/${slug}`);
    const companion = page.getByRole('region', { name: 'Your financial picture', exact: true });
    await expect(companion).toContainText('Figures appear as you talk');
    await expect(companion.getByRole('article')).toHaveCount(0);
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
    await page.evaluate(async () => { const client = window.voiceFixture.clients[0]; client.callbacks.onBotReady!({ version: '2.1' }); await client.micReady; });
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    const day = (offset: number) => { const date = new Date(`${saved.anchorDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
    const submit = async (changes: Extract<Command['operation'], { type: 'updateFacts' }>['changes']) => {
      const response = await context.request.post('/api/session/commands', { data: { commandId: randomUUID(), expectedRevision: saved.revision,
        operation: { type: 'updateFacts', changes: { ...changes, expectedRevision: saved.revision } } } });
      expect(response.status(), await response.text()).toBe(200); saved = await response.json();
    };
    await submit({ expectedRevision: saved.revision, opening: { amount: '5000', status: 'exact' } });
    await expect(companion.getByRole('article')).toHaveCount(1);
    await expect(companion.getByRole('button', { name: 'Edit Cash at plan start', exact: true })).toContainText('₹5,000');
    await submit({ expectedRevision: saved.revision, records: [
      { delete: false, distinct: true, kind: 'essential', label: 'Rent', amount: { amount: '12000', status: 'exact' }, schedule: { date: day(2), certainty: 'exact', recurrence: 'once' } },
      { delete: false, distinct: true, kind: 'income', label: 'Salary', reliability: 'reliable', amount: { amount: '25000', status: 'exact' }, schedule: { date: day(10), certainty: 'exact', recurrence: 'once' } },
    ] });
    const gap = companion.getByLabel('First shortfall', { exact: true });
    await expect(gap).toContainText('₹7,000');
    await expect(companion.getByRole('article')).toHaveCount(2);
    await expect(companion).not.toContainText(/Why this result|What you’ve shared|picture is still taking shape|What cash was|Next steps/);
    await page.screenshot({ path: info.outputPath('companion-live.png'), fullPage: true });
    const rent = companion.getByRole('listitem', { name: 'Rent', exact: true });
    await rent.getByRole('button', { name: 'Edit Rent amount', exact: true }).click();
    const amount = rent.getByRole('textbox', { name: 'Rent amount', exact: true });
    await amount.fill('6000');
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/session/commands', async route => { await pending; await route.fallback(); });
    const response = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
    await amount.press('Enter');
    await expect(rent.getByRole('button', { name: 'Save Rent amount', exact: true })).toBeDisabled();
    await expect(gap).toContainText('₹7,000');
    release!();
    const result = await response; expect(result.status()).toBe(200);
    const command = result.request().postDataJSON() as Command;
    expect(command.operation).toMatchObject({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: saved.revision } });
    saved = await result.json();
    expect(saved.workspace!.change!.source).toEqual({ kind: 'humanCardEdit', actorId: auth.user.id, at: expect.any(String) });
    expect(saved.workspace!.change!.id).toBe(command.commandId);
    expect(saved.workspace!.change).toEqual(saved.latestChange);
    expect(saved.plan.firstGap!.amountPaise).toBe(100000);
    await expect(gap).toContainText('₹1,000');
    await expect(rent.getByRole('form')).toHaveCount(0);
    await expect(rent.getByRole('button', { name: 'Edit Rent amount', exact: true })).toBeFocused();
    expect(await (await context.request.post('/api/session/commands', { data: command })).json()).toEqual(saved);
    await page.unroute('**/api/session/commands');
    const salary = companion.getByRole('listitem', { name: 'Salary', exact: true });
    await salary.getByRole('button', { name: 'Edit Salary date', exact: true }).click();
    await salary.getByLabel('Salary date', { exact: true }).fill(day(1));
    const dated = page.waitForResponse(response => response.url().endsWith('/api/session/commands') && response.request().method() === 'POST');
    await salary.getByRole('button', { name: 'Save Salary date', exact: true }).click();
    saved = await (await dated).json();
    expect(saved.plan.firstGap).toBeNull();
    await expect(gap).toHaveCount(0);
    expect(saved.facts.records).toHaveLength(2);
    expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(1);
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('companion-corrected.png'), fullPage: true });
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await rent.getByRole('button', { name: 'Edit Rent name', exact: true }).click();
      await expect(rent.getByRole('button', { name: 'Cancel Rent name', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('companion-large-text.png'), fullPage: true });
      await rent.getByRole('button', { name: 'Cancel Rent name', exact: true }).click();
    }
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    await expect.poll(() => call.cleanupConfirmed).toBe(true);
  } finally {
    release?.();
    if (!page.isClosed()) { await page.evaluate(() => window.voiceFixture?.clients.forEach(client => client.stopCapture())); await page.goto('about:blank'); }
    await context.request.delete('/api/session');
    expect(blocked).toEqual([]); expect(errors).toEqual([]);
  }
});