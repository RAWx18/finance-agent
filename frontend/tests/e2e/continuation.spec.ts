// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import type { CallState, ConversationSummary, Snapshot } from '../../src/api';
import type {} from '../voiceSdk';
import { signIn } from './authSupport';

let bundle: string;
let styles: string;
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'], serviceWorkers: 'block' });
test.beforeAll(async () => {
  const sdk = fileURLToPath(new URL('../voiceSdk.ts', import.meta.url));
  const result = await build({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, logLevel: 'error',
    resolve: { alias: [{ find: '@pipecat-ai/client-js', replacement: sdk }, { find: '@pipecat-ai/daily-transport', replacement: sdk }] },
    build: { write: false, minify: false, rollupOptions: { input: fileURLToPath(new URL('../../src/main.tsx', import.meta.url)), output: { codeSplitting: false } } } });
  if ('on' in result) throw new Error('A browser test must not start a watcher.');
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(item => item.output).filter(item => item.type === 'chunk');
  styles = (Array.isArray(result) ? result : [result]).flatMap(item => item.output)
    .flatMap(item => item.type === 'asset' && item.fileName.endsWith('.css') ? [item.source] : []).join('\n');
  expect(chunks).toHaveLength(1);
  expect(Object.keys(chunks[0].modules).filter(id => /node_modules\/(?:@pipecat-ai|@daily-co)\//.test(id))).toEqual([]);
  bundle = chunks[0].code;
});

test('History continues A with real persisted memory and SSE, reconnects A, and reloads without microphone', async ({ page, context, baseURL }, info) => {
  const origin = new URL(baseURL!).origin;
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
  expect(process.env.E2E_DATA_DIR).toBeTruthy();
  await context.setExtraHTTPHeaders({ Origin: origin });
  const blocked: string[] = [];
  const errors: string[] = [];
  const starts: { callId: string; conversationSlug?: string }[] = [];
  const selections: string[] = [];
  let call: CallState = { callId: null, status: 'idle', cleanupConfirmed: true, message: null };
  const entry = await context.request.get('/login');
  const script = (await entry.text()).match(/<script\b[^>]*\bsrc="([^"]+)"/);
  expect(script).not.toBeNull();
  await context.routeWebSocket('**', socket => { blocked.push(socket.url()); socket.close(); });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { blocked.push(request.url()); await route.abort(); return; }
    if (url.pathname === '/api/session/call') {
      // Every media method terminates at this boundary; no paid room can be created.
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { callId: string; conversationSlug?: string };
        starts.push(body);
        const response = await context.request.get('/api/session');
        const saved = await response.json() as Snapshot;
        expect(body).toEqual({ callId: expect.any(String), conversationSlug: saved.conversationSlug });
        expect(call.cleanupConfirmed).toBe(true);
        call = { callId: body.callId, conversationSlug: body.conversationSlug, status: 'connecting', cleanupConfirmed: false, message: null };
        await route.fulfill({ json: { ...body, url: 'https://voice-fixture.daily.co/room', token: 'synthetic-provider-double',
          expiresAt: new Date(Date.now() + 60000).toISOString() } });
      } else if (request.method() === 'DELETE') {
        expect(request.postDataJSON()).toEqual({ callId: call.callId });
        call = { ...call, status: 'ended', cleanupConfirmed: true }; await route.fulfill({ json: call });
      } else if (request.method() === 'GET') await route.fulfill({ json: call });
      else { blocked.push(request.method()); await route.abort(); }
    } else if (url.pathname === script![1]) await route.fulfill({ contentType: 'application/javascript', body: bundle });
    else if (/^\/assets\/[^/]+\.css$/.test(url.pathname)) await route.fulfill({ contentType: 'text/css', body: styles });
    else if (url.pathname === '/api/settings') {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), voiceAvailable: true, voiceUnavailableReason: null } });
    } else {
      if (/^\/api\/history\/[^/]+\/continue$/.test(url.pathname)) selections.push(url.pathname);
      await route.continue();
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await signIn(page, '/history');
    expect((await context.request.delete('/api/session')).status()).toBe(200);
    const auth = await (await context.request.get('/api/auth/session')).json();
    const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));
    const seed = spawnSync('uv', ['run', '--project', backend, '--locked', 'python', '-m', 'tests.history_support', auth.user.id],
      { cwd: backend, env: process.env, encoding: 'utf8' });
    expect(seed.status, seed.stderr).toBe(0);
    const history = (await (await context.request.get('/api/history')).json()).conversations as ConversationSummary[];
    expect(history).toHaveLength(4);
    const [a, b] = history;
    for (const [chat, amount] of [[a, '1111'], [b, '9999']] as const) {
      const response = await context.request.post(`/api/history/${chat.slug}/continue`, { data: {} });
      expect(response.status(), await response.text()).toBe(200);
      const selected = await response.json() as Snapshot;
      const save = await context.request.post('/api/session/commands', { data: { commandId: randomUUID(), expectedRevision: selected.revision,
        operation: { type: 'updateFacts', changes: { expectedRevision: selected.revision, opening: { status: 'exact', amount } } } } });
      expect(save.status()).toBe(200);
    }
    await page.goto(`/history/${a.slug}`);
    const continueTalking = page.getByRole('button', { name: 'Continue talking', exact: true });
    await expect(continueTalking).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Download captions' })).toBeVisible();
    await continueTalking.focus(); await expect(continueTalking).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('historyContinue.png') });
    await continueTalking.press('Enter');
    await expect(page).toHaveURL(`${origin}/app/${a.slug}`);
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
    expect(selections).toEqual([`/api/history/${a.slug}/continue`]);
    expect(starts.map(start => start.conversationSlug)).toEqual([a.slug]);
    const picture = page.getByRole('region', { name: 'Your financial picture' });
    await expect(picture).toContainText('₹1,111.00'); await expect(picture).not.toContainText('₹9,999.00');
    await page.evaluate(async () => { const client = window.voiceFixture.clients[0]; client.callbacks.onBotReady!({ version: '2.1' }); await client.micReady; });
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
    await page.locator(`[href="/history/${b.slug}"]`).click();
    await expect(page.getByRole('button', { name: 'Continue talking' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Download captions' })).toBeEnabled();
    expect(await page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(0);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Conversation', exact: true }).click();
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onDisconnected!());
    const reconnect = page.getByRole('region', { name: 'Your conversation' }).getByRole('button', { name: 'Reconnect' });
    await expect(reconnect).toBeEnabled();
    expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    await reconnect.click();
    await expect.poll(() => starts.length).toBe(2);
    expect(starts.map(start => start.conversationSlug)).toEqual([a.slug, a.slug]);
    expect(starts[0].callId).not.toBe(starts[1].callId);
    await page.getByRole('button', { name: 'End conversation' }).click();
    await expect.poll(() => call.cleanupConfirmed).toBe(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Start talking' })).toBeEnabled();
    expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(0);
    await expect(picture).toContainText('₹1,111.00'); await expect(picture).not.toContainText('₹9,999.00');
    expect((await (await context.request.get('/api/history')).json()).conversations).toHaveLength(4);
    expect(selections).toHaveLength(1); expect(starts).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('conversationReload.png') });
    if (info.project.name === 'mobile') {
      await page.goto(`/history/${a.slug}`);
      await page.setViewportSize({ width: 320, height: 640 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
      await expect(page.getByRole('button', { name: 'Continue talking' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Download captions' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const messages = page.getByRole('region', { name: 'Conversation messages' });
      await messages.focus(); await messages.press('End');
      expect(await messages.evaluate(element => element.clientHeight)).toBeGreaterThan(100);
      await page.screenshot({ path: info.outputPath('historyLargeText.png') });
      expect(starts).toHaveLength(2);
    }
  } finally {
    if (!page.isClosed()) { await page.evaluate(() => window.voiceFixture?.clients.forEach(client => client.stopCapture())); await page.goto('about:blank'); }
    await context.request.delete('/api/session');
    expect(blocked).toEqual([]); expect(errors).toEqual([]);
  }
});