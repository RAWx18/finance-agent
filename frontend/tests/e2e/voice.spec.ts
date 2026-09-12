// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { build } from 'vite';
import type { CallJoin, CallState, Command, FactsInput, Settings, Snapshot } from '../../src/api';
import { dateLabel, decimal, draftFacts, lastDate, money } from '../../src/money';
import type {} from '../voiceSdk';
import { signIn } from './authSupport';

// Rendered App + real financial HTTP/SSE, with provider-double transport and fabricated captions.
// This suite never creates a paid room and does not replace real-provider speech acceptance.
let bundle: string;
let styles: string;
type Voice = { calls: string[]; blocked: string[]; errors: string[] };
const test = base.extend<{ voice: Voice }>({
  /** Isolate voice providers while retaining real financial HTTP, SSE and session cleanup. */
  voice: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
    await context.setExtraHTTPHeaders({ Origin: origin });
    const voice: Voice = { calls: [], blocked: [], errors: [] };
    let call: CallState = { callId: null, status: 'idle', cleanupConfirmed: true, message: null };
    const ended = new Set<string>();
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
        if (request.method() === 'POST' || request.method() === 'DELETE') {
          expect(request.headers()['content-type']).toBe('application/json');
          expect(request.postDataJSON()).toEqual({ callId: expect.stringMatching(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i),
            ...(request.method() === 'POST' && call.conversationSlug ? { conversationSlug: call.conversationSlug } : {}) });
          const { callId } = request.postDataJSON() as { callId: string };
          if (request.method() === 'DELETE') {
            ended.add(callId);
            if (call.callId === callId) call = { ...call, status: 'ended', cleanupConfirmed: true };
            await route.fulfill({ json: { callId, status: 'ended', cleanupConfirmed: true, message: null } satisfies CallState });
          } else if (ended.has(callId)) {
            await route.fulfill({ status: 409, json: { code: 'callEnded', message: 'This call has ended; use a fresh call ID.' } });
          } else if (!call.cleanupConfirmed && call.callId !== callId) {
            await route.fulfill({ status: 409, json: { code: 'callBusy', message: 'A voice call is already running or ending.' } });
          } else {
            call = { callId, conversationSlug: 'conversation-2026-09-12-000000', status: 'connecting', cleanupConfirmed: false, message: null };
            const join: CallJoin = { callId, conversationSlug: call.conversationSlug!, url: 'https://voice-fixture.daily.co/room',
              token: 'synthetic-provider-double', expiresAt: new Date(Date.now() + 1800000).toISOString() };
            await route.fulfill({ json: join });
          }
        } else if (request.method() === 'GET') await route.fulfill({ json: call });
        else await route.fulfill({ status: 405, json: { code: 'testMethod', message: 'Unsupported test method' } });
      } else if (url.pathname === '/api/session' && ['GET', 'POST'].includes(request.method()) && call.conversationSlug) {
        const response = await route.fetch({ maxRedirects: 0 });
        if (response.status() !== 200) { await route.fulfill({ response }); return; }
        // The provider double owns only call identity; financial facts and commands remain real HTTP/SSE.
        const snapshot = await response.json() as Snapshot;
        await route.fulfill({ response, json: { ...snapshot, conversationSlug: call.conversationSlug } satisfies Snapshot });
      } else if (url.pathname === '/api/settings' && request.method() === 'GET') {
        const response = await route.fetch({ maxRedirects: 0 });
        expect(response.status()).toBe(200);
        const settings = await response.json() as Settings;
        await route.fulfill({ response, json: { ...settings, voiceAvailable: true, voiceUnavailableReason: null } satisfies Settings });
      } else if (url.href === entry.href && request.method() === 'GET') {
        delivered += 1;
        await route.fulfill({ contentType: 'application/javascript', body: bundle });
      } else if (/^\/assets\/[^/]+\.css$/.test(url.pathname) && request.method() === 'GET') {
        await route.fulfill({ contentType: 'text/css', body: styles });
      } else if (/^\/assets\/brand-[\w-]+\.svg$/.test(url.pathname) && request.method() === 'GET') {
        await route.continue();
      } else if ((request.method() === 'GET' && ['/', '/login', '/app', '/history', '/money', '/account', '/auth/callback'].includes(url.pathname))
        || (/^\/(?:api\/)?history(?:\/[^/]+)?$/.test(url.pathname) && request.method() === 'GET')
        || (url.pathname.startsWith('/api/auth/') && ['GET', 'POST'].includes(request.method()))
        || (url.pathname === '/api/account' && request.method() === 'DELETE')
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
      // The isolated backend shares its synthetic identity across browser contexts.
      let deleted = await context.request.delete(`${origin}/api/session`, { maxRedirects: 0 });
      if (deleted.status() === 401) {
        await signIn(page);
        await page.goto('about:blank');
        deleted = await context.request.delete(`${origin}/api/session`, { maxRedirects: 0 });
      }
      expect([200, 404]).toContain(deleted.status());
      expect(delivered).toBeGreaterThan(0);
      expect(voice.blocked, 'No unexpected script, provider HTTP request, or WebSocket may escape').toEqual([]);
      expect(voice.errors).toEqual([]);
    }
  }, { auto: true }],
});

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'] },
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
  styles = (Array.isArray(result) ? result : [result]).flatMap(output => output.output)
    .flatMap(item => item.type === 'asset' && item.fileName.endsWith('.css') ? [item.source] : []).join('\n');
  expect(chunks).toHaveLength(1);
  expect(chunks[0].isEntry).toBe(true);
  expect(Object.keys(chunks[0].modules)).toContain(sdk);
  expect(Object.keys(chunks[0].modules)).toContain(fileURLToPath(new URL('../../src/components/assistant-ui/elements/voice.tsx', import.meta.url)));
  expect(Object.keys(chunks[0].modules).filter(id => /node_modules\/(?:@pipecat-ai|@daily-co)\//.test(id))).toEqual([]);
  bundle = chunks[0].code;
});

test('provider double: focused Conversation stays in session through End and reconnect', async ({ page, voice }, info) => {
  const created = await page.request.post('/api/session', { data: {} });
  expect(created.status()).toBe(200);
  const initial = await created.json() as Snapshot;
  const saved = await submit(page, initial, { type: 'replaceFacts', facts: {
    ...draftFacts(initial),
    opening: { amount: '5000', status: 'exact' },
    coverage: { income: 'none', essential: 'reviewed', optional: 'none', debt: 'none' },
    records: [{ id: 'rent', kind: 'essential', label: 'Rent', autoDebit: false, amount: { amount: '1200', status: 'exact' },
      schedule: { date: dateAt(initial.anchorDate, 2), certainty: 'exact', recurrence: 'once' } }],
  } });
  const transitions: { method: string; callId: string; conversationSlug?: string }[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/session/call' && ['POST', 'DELETE'].includes(request.method()))
      transitions.push({ method: request.method(), ...request.postDataJSON() });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  const main = page.locator('main');
  const journey = page.locator('.journey-layout');
  const controls = journey.locator('.conversation-controls');
  const picture = journey.getByRole('region', { name: 'Your financial picture', exact: true });
  const cards = picture.getByRole('article');
  const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const figures = navigation.getByRole('link', { name: 'Money', exact: true });
  await expect(main).toHaveAttribute('data-view', 'ready');
  await expect(picture.getByRole('button', { name: 'Edit Cash at plan start', exact: true }).locator('.card-number')).toHaveText('₹5,000');
  await expect(picture.getByRole('listitem', { name: 'Rent', exact: true }).locator('.card-number')).toHaveText('−₹1,200');
  const content = await cards.allTextContents();
  expect(content.length).toBeGreaterThan(0);
  /** Verify call transitions retain a focused conversation and unchanged financial cards. */
  const clean = async () => {
    await expect(page.locator('.journey-progress, .review-controls, .review-layout, .post-call')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: /progress/i })).toHaveCount(0);
    await expect(journey.getByText(/^(Review|Take your plan)$/)).toHaveCount(0);
    await expect(journey.getByRole('button', { name: /^(Review saved picture|Finish review|Return to conversation|Continue talking|Download.*)$/ })).toHaveCount(0);
    await expect(journey.getByRole('link', { name: /^(View full plan|Download.*)$/ })).toHaveCount(0);
    await expect(picture.getByRole('region', { name: 'Financial status', exact: true })).toHaveCount(1);
    await expect(journey.locator('.conversation-pane')).toBeVisible();
    await expect(journey.locator('.financial-pane')).toBeVisible();
    await expect(controls).toBeVisible();
    await expect(picture).toBeVisible();
    await expect.poll(() => cards.allTextContents()).toEqual(content);
    await expect(page.locator('.page-feedback')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (info.project.name !== 'mobile') {
      const top = (await main.boundingBox())!.y;
      for (const pane of ['.conversation-pane', '.financial-pane']) {
        const bounds = (await journey.locator(pane).boundingBox())!;
        expect(bounds.y - top, `${pane} starts near main, without an empty feedback row`).toBeGreaterThanOrEqual(0);
        expect(bounds.y - top).toBeLessThanOrEqual(16);
      }
    }
  };
  await clean();
  expect(transitions).toEqual([]);
  expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(0);
  const joining = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/call' && response.request().method() === 'POST');
  await controls.getByRole('button', { name: 'Start talking', exact: true }).click();
  const join = await (await joining).json() as CallJoin;
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
  await page.evaluate(async () => {
    const client = window.voiceFixture.clients[0];
    client.callbacks.onConnected!(); client.callbacks.onBotReady!({ version: '2.1.0' });
    await client.micReady;
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', local: false, name: 'Assistant' });
    client.callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 1 });
  });
  await expect(main).toHaveAttribute('data-view', 'session');
  await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'active');
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await expect(figures).toBeDisabled();
  await clean();
  const microphone = await page.evaluateHandle(() => window.voiceFixture.clients[0].tracks().local.audio!);
  await navigation.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
  expect(await page.evaluate(track => track.readyState === 'live' && track.enabled
    && window.voiceFixture.clients[0].tracks().local.audio === track
    && window.voiceFixture.clients[0].disconnects === 0, microphone)).toBe(true);
  await expect(figures).toBeDisabled();
  await page.getByRole('region', { name: 'History', exact: true }).getByRole('link', { name: 'Return to call', exact: true }).last().click();
  await expect(page).toHaveURL(new RegExp(`/app/${join.conversationSlug}$`));
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  expect(await page.evaluate(track => window.voiceFixture.clients[0].tracks().local.audio === track
    && track.readyState === 'live' && track.enabled && window.voiceFixture.clients[0].disconnects === 0, microphone)).toBe(true);
  expect(transitions).toEqual([{ method: 'POST', callId: join.callId }]);
  await clean();
  const layout = await journey.boundingBox();
  const callControls = await controls.boundingBox();
  await controls.getByRole('button', { name: 'End conversation', exact: true }).press('Enter');
  await expect(main).toHaveAttribute('data-view', 'session');
  await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'ended');
  await expect(page.locator('.conversation')).toHaveAttribute('data-cleanup-pending', 'false');
  await expect(page.locator('.voice-status')).toHaveText('Conversation ended');
  await expect.poll(() => page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('audio')).toHaveJSProperty('srcObject', null);
  await expect(controls.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  await expect(figures).toBeEnabled();
  await clean();
  expect(await journey.boundingBox()).toEqual(layout);
  const endedControls = await controls.boundingBox();
  for (const coordinate of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(endedControls![coordinate] - callControls![coordinate])).toBeLessThanOrEqual(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('focusedConversation.png'), fullPage: true });
  expect(await current(page)).toEqual(saved);
  await figures.click();
  await expect(page).toHaveURL(/\/money$/);
  await page.getByRole('button', { name: 'Plan tools', exact: true }).click();
  const tools = page.getByRole('dialog', { name: 'Plan tools', exact: true });
  await expect(tools.getByRole('button', { name: 'Print saved plan', exact: true })).toBeEnabled();
  const exported = await page.request.get('/api/session/export');
  expect(exported.status()).toBe(200);
  const text = await exported.text();
  expect(text).toContain('Rent');
  const downloading = page.waitForEvent('download');
  await tools.getByRole('link', { name: 'Download saved plan', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('cashflow.txt');
  expect(await download.failure()).toBeNull();
  expect(await readFile((await download.path())!, 'utf8')).toBe(text);
  await page.keyboard.press('Escape');
  await navigation.getByRole('link', { name: 'Conversation', exact: true }).click();
  await expect(main).toHaveAttribute('data-view', 'session');
  await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'ended');
  await clean();
  expect(transitions).toEqual([{ method: 'POST', callId: join.callId }, { method: 'DELETE', callId: join.callId }]);
  await controls.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[1]?.connections.length ?? 0)).toBe(1);
  await page.evaluate(async () => {
    const client = window.voiceFixture.clients[1];
    client.callbacks.onConnected!(); client.callbacks.onBotReady!({ version: '2.1.0' });
    await client.micReady;
    client.callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 1 });
  });
  await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'active');
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await expect(figures).toBeDisabled();
  await clean();
  expect(transitions[2]).toEqual({ method: 'POST', callId: expect.any(String), conversationSlug: join.conversationSlug });
  expect(transitions[2].callId).not.toBe(join.callId);
  await controls.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect(main).toHaveAttribute('data-view', 'session');
  await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'ended');
  await expect(page.locator('.conversation')).toHaveAttribute('data-cleanup-pending', 'false');
  await clean();
  expect(transitions).toEqual([{ method: 'POST', callId: join.callId }, { method: 'DELETE', callId: join.callId },
    { method: 'POST', callId: transitions[2].callId, conversationSlug: join.conversationSlug }, { method: 'DELETE', callId: transitions[2].callId }]);
  expect(voice.calls.filter(method => method !== 'GET')).toEqual(['POST', 'DELETE', 'POST', 'DELETE']);
  expect(await page.evaluate(() => window.voiceFixture.clients.map(client => client.disconnects))).toEqual([1, 1]);
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await current(page)).toEqual(saved);
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await clean();
    await controls.getByRole('button', { name: 'Reconnect', exact: true }).focus();
    await expect(controls.getByRole('button', { name: 'Reconnect', exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath('focusedConversationLargeText.png'), fullPage: true });
  }
  await microphone.dispose();
});

test('header geometry stays stable through call states and live financial updates', async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  /** Capture header geometry for call-state and financial-update comparisons. */
  const bounds = () => page.locator('.site-header, .site-header .brand, .site-navigation, .site-navigation > a, .profile-trigger').evaluateAll(elements =>
    elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
  const initial = await bounds();
  /** Verify the header stays stable and fills the application without overflow. */
  const unchanged = async () => {
    const current = await bounds();
    expect(current).toHaveLength(initial.length);
    for (const [index, box] of initial.entries()) for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(current[index][key] - box[key]), `Header ${index} ${key} stays stable`).toBeLessThanOrEqual(1);
    const root = (await page.locator('#root').boundingBox())!;
    expect(current[0].x).toBeCloseTo(root.x, 1);
    expect(current[0].width).toBeCloseTo(root.width, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'ready');
  await unchanged();
  await page.getByRole('button', { name: 'Start talking', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toBeDisabled();
  await unchanged();
  await page.evaluate(async () => {
    const client = window.voiceFixture.clients[0];
    client.callbacks.onConnected!(); client.callbacks.onBotReady!({ version: '2.1.0' });
    await client.micReady;
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', local: false, name: 'Assistant' });
    client.callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 1 });
  });
  await expect(page.locator('.voice-status')).toHaveText('Listening'); await unchanged();
  const saved = await current(page);
  const learned = await submit(page, saved, { type: 'updateFacts', changes: { expectedRevision: saved.revision,
    opening: { amount: '5000', status: 'exact' }, records: [{ kind: 'essential', label: 'Rent', delete: false, distinct: true,
      amount: { amount: '7000', status: 'exact' }, schedule: { date: dateAt(saved.anchorDate, 2), certainty: 'exact', recurrence: 'once' } }],
  } });
  const cash = page.getByRole('article', { name: learned.workspace!.cards!.find(card => card.template === 'cash')!.title, exact: true });
  await expect(cash).toContainText('₹5,000.00'); await unchanged();
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotStartedSpeaking!());
  await expect(page.locator('.voice-status')).toHaveText('Speaking'); await unchanged();
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotStoppedSpeaking!());
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await ended(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toBeEnabled();
  await unchanged();
  await page.screenshot({ path: info.outputPath('header-call-ended.png'), fullPage: true });
});

/** Return an ISO calendar date offset from the plan's anchor in UTC days. */
function dateAt(anchor: string, offset: number) {
  const [year, month, day] = anchor.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

declare global {
  interface Window {
    recoveryStreams: EventSource[];
    ringbackAudio?: { context: AudioContext; analyser: AnalyserNode };
    releaseCapture?: () => void;
    cardAnimations: { element: Element; animation: Animation }[];
    orbProbe: WeakMap<HTMLCanvasElement, { frames: number; state: string | null; volume: number;
      time: number; speed: number; amplitude: number; pixel: number[] }>;
  }
}

test.describe('release recovery with authenticated financial HTTP/SSE', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.recoveryStreams = [];
      const Source = window.EventSource;
      /** Retain native event streams for simulated recovery failures. */
      window.EventSource = class extends Source {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options); window.recoveryStreams.push(this);
        }
      };
    });
    await page.goto('/app');
  });

  /** Start a provider-double call with live capture and simulated assistant speech. */
  async function speaking(page: Page) {
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
    await page.evaluate(async () => {
      const client = window.voiceFixture.clients[0];
      client.callbacks.onConnected!(); client.callbacks.onBotReady!({ version: '2.1.0' });
      await client.micReady;
      client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', local: false, name: 'Assistant' });
      client.callbacks.onBotStartedSpeaking!();
    });
    await expect(page.locator('.voice-status')).toHaveText('Speaking');
  }

  /** Verify capture and playback are released and the client disconnects once. */
  async function stopped(page: Page) {
    await expect.poll(() => page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).srcObject)).toBeNull();
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(1);
  }

  for (const ending of ['ready', 'cancel', 'failure'] as const) test(`connecting ringback emits quiet audio and stops on ${ending}`, async ({ page, voice }) => {
    await page.evaluate(() => {
      const Context = window.AudioContext;
      /** Monitor native ringback audio during connection attempts. */
      window.AudioContext = class extends Context {
        /** Expose ringback signal levels without adding audible output. */
        createBufferSource() {
          const source = super.createBufferSource();
          const analyser = this.createAnalyser();
          const silent = this.createGain();
          silent.gain.value = 0;
          source.connect(analyser).connect(silent).connect(this.destination);
          window.ringbackAudio = { context: this, analyser };
          return source;
        }
      };
    });
    expect(await page.evaluate(() => window.ringbackAudio)).toBeUndefined();
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    expect(await page.evaluate(() => window.ringbackAudio)).toBeUndefined();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const audio = window.ringbackAudio;
      if (!audio) return 0;
      const samples = new Float32Array(audio.analyser.fftSize);
      audio.analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    })).toBeGreaterThan(0.002);
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onConnected!());
    await expect(page.locator('.voice-status')).toHaveText('Connecting to assistant');
    expect(await page.evaluate(() => window.ringbackAudio!.context.state)).toBe('running');
    expect(await page.evaluate(() => ({ tracks: window.voiceFixture.tracks.length, enabled: window.voiceFixture.clients[0].isMicEnabled })))
      .toEqual({ tracks: 0, enabled: false });
    if (ending === 'ready') await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotReady!({ version: '2.1' }));
    else if (ending === 'cancel') await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    else await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onDisconnected!());
    await expect.poll(() => page.evaluate(() => window.ringbackAudio!.context.state)).toBe('closed');
    if (ending === 'ready') {
      await expect(page.locator('.voice-status')).toHaveText('Listening');
      expect(await page.evaluate(() => ({ tracks: window.voiceFixture.tracks.length, enabled: window.voiceFixture.clients[0].isMicEnabled,
        capturing: window.voiceFixture.clients[0].tracks().local.audio?.enabled })))
        .toEqual({ tracks: 1, enabled: true, capturing: true });
      await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    } else {
      await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotReady!({ version: '2.1' }));
      expect(await page.evaluate(() => window.voiceFixture.tracks.length)).toBe(0);
    }
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  });

  test('End keeps Conversation visible immediately while slow cleanup gates reconnect despite a hung SDK', async ({ page, voice }, info) => {
    await speaking(page);
    const saved = await current(page);
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/session/call', async route => {
      if (route.request().method() === 'DELETE') await cleanup;
      await route.fallback();
    });
    await page.evaluate(() => { /** Simulate a transport disconnect that never completes. */window.voiceFixture.clients[0].disconnect = () => new Promise<void>(() => undefined); });
    try {
      const end = page.getByRole('button', { name: 'End conversation', exact: true });
      await end.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('main')).toHaveAttribute('data-view', 'session', { timeout: 1000 });
      await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'ended', { timeout: 1000 });
      await expect(page.locator('.conversation')).toHaveAttribute('data-cleanup-pending', 'true');
      await expect(page.locator('.financial-pane')).toBeVisible();
      expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
      await expect(page.locator('audio')).toHaveJSProperty('srcObject', null);
      await expect(page.getByRole('link', { name: 'Money', exact: true })).toBeDisabled();
      await expect(page.locator('.voice-status')).toHaveText('Conversation ended');
      await expect(page.locator('.voice-status-hint')).toHaveText('Your microphone is off. Confirming the call is closed.');
      const reconnect = page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect', exact: true });
      await expect(reconnect).toBeDisabled(); await expect(reconnect).toHaveAttribute('aria-busy', 'true');
      await expect(reconnect).toBeInViewport({ ratio: 1 });
      await page.evaluate(() => {
        const client = window.voiceFixture.clients[0];
        client.callbacks.onBotReady!({ version: '2.1' }); client.callbacks.onDisconnected!(); client.callbacks.onBotStartedSpeaking!();
      });
      await expect(page.locator('.voice-status')).toHaveText('Conversation ended');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('ended-cleanup-pending.png'), fullPage: true });
      expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
      expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(1);
      release();
      await expect(page.locator('.conversation')).toHaveAttribute('data-cleanup-pending', 'false');
      await expect(page.locator('.voice-status')).toHaveText('Conversation ended');
      await expect(reconnect).toBeEnabled();
      await expect(page.getByRole('link', { name: 'Money', exact: true })).toBeEnabled();
      expect(await current(page)).toEqual(saved);
      await reconnect.click();
      await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[1]?.connections.length ?? 0)).toBe(1);
      expect(voice.calls.filter(method => method === 'POST')).toHaveLength(2);
      await page.getByRole('button', { name: 'End conversation', exact: true }).click();
      await ended(page);
    } finally { release(); }
  });

  test('lost End acknowledgement reconciles saved state and permits reconnect without manual retry', async ({ page, voice }) => {
    await speaking(page);
    const saved = await current(page);
    await page.evaluate(() => {
      const fetch = window.fetch;
      let lost = false;
      /** Drop only the first cleanup response after the server boundary has processed it. */
      window.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!lost && String(input).endsWith('/api/session/call') && init?.method === 'DELETE') {
          lost = true;
          throw new TypeError('Synthetic acknowledgement loss');
        }
        return response;
      };
      /** Keep local SDK disconnect pending independently of owned backend cleanup. */
      window.voiceFixture.clients[0].disconnect = () => new Promise<void>(() => undefined);
    });
    const reads = voice.calls.filter(method => method === 'GET').length;
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    await expect(page.locator('.conversation')).toHaveAttribute('data-cleanup-pending', 'false');
    expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    await expect(page.locator('audio')).toHaveJSProperty('srcObject', null);
    await expect(page.getByText('Call ending not confirmed', { exact: true })).toHaveCount(0);
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
    expect(voice.calls.filter(method => method === 'GET').length).toBeGreaterThan(reads);
    expect(await current(page)).toEqual(saved);
    const reconnect = page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect', exact: true });
    await expect(reconnect).toBeEnabled();
    await reconnect.click();
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[1]?.connections.length ?? 0)).toBe(1);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(2);
    await page.evaluate(() => {
      window.voiceFixture.clients[0].callbacks.onDisconnected!();
      window.voiceFixture.clients[0].callbacks.onBotReady!({ version: '2.1' });
    });
    await expect(page.getByRole('button', { name: 'End conversation', exact: true })).toBeEnabled();
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    await ended(page);
    expect(await current(page)).toEqual(saved);
  });

  test('browser refresh preserves owned End recovery after unload network loss and hung SDK disconnect', async ({ page, voice }) => {
    const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/session/call' && request.method() === 'POST');
    await speaking(page);
    const { callId } = (await started).postDataJSON() as { callId: string };
    const initial = await current(page);
    const saved = await submit(page, initial, { type: 'replaceFacts', facts: { ...draftFacts(initial), opening: { amount: '321.09', status: 'exact' } } });
    const cash = page.getByRole('article', { name: saved.workspace!.cards!.find(card => card.template === 'cash')!.title, exact: true });
    await expect(cash).toContainText('₹321.09');
    await page.evaluate(() => {
      /** Simulate a transport disconnect that never completes. */
      window.voiceFixture.clients[0].disconnect = () => new Promise<void>(() => undefined);
      const fetch = window.fetch;
      /** Record and reject call cleanup requests to simulate unload network loss. */
      window.fetch = (input, init) => {
        if (String(input).endsWith('/api/session/call') && init?.method === 'DELETE') {
          sessionStorage.setItem('voice-unload-request', JSON.stringify({ keepalive: init.keepalive, body: init.body, cancellable: !!init.signal }));
          return Promise.reject(new TypeError('Synthetic unload network loss'));
        }
        return fetch(input, init);
      };
      window.addEventListener('pagehide', () => sessionStorage.setItem('voice-unload-state', JSON.stringify({
        marks: performance.getEntriesByType('mark').map(mark => mark.name),
        stopped: window.voiceFixture.tracks.every(track => track.readyState === 'ended'),
      })), { once: true });
    });
    await page.reload();
    const unload = await page.evaluate(() => ({ request: sessionStorage.getItem('voice-unload-request'), state: sessionStorage.getItem('voice-unload-state') }));
    expect(unload, 'Real pagehide must synchronously start keepalive End before its context disappears').toMatchObject({
      request: JSON.stringify({ keepalive: true, body: JSON.stringify({ callId }), cancellable: false }),
    });
    expect(JSON.parse(unload.state!)).toMatchObject({ stopped: true });
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(0);
    const retry = page.getByRole('button', { name: 'Retry ending call', exact: true });
    await expect(retry).toBeVisible();
    expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(0);
    const posted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/session/call' && request.method() === 'DELETE');
    await retry.click();
    expect((await posted).postDataJSON()).toEqual({ callId });
    await expect.poll(() => voice.calls.filter(method => method === 'DELETE').length).toBe(1);
    expect(await current(page)).toEqual(saved);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(0);
    await expect(page.locator('audio')).toHaveJSProperty('srcObject', null);
    await expect(page.getByRole('button', { name: 'Retry ending call', exact: true })).toHaveCount(0);
  });

  test('expired room credentials require explicit reconnect without losing committed figures', async ({ page, voice }) => {
    let expire = true;
    await page.route('**/api/session/call', async route => {
      if (route.request().method() !== 'POST' || !expire) { await route.fallback(); return; }
      expire = false;
      voice.calls.push('POST');
      await route.fulfill({ json: { callId: route.request().postDataJSON().callId, conversationSlug: 'conversation-2026-09-12-000000', url: 'https://voice-fixture.daily.co/room',
        token: 'synthetic-provider-double', expiresAt: new Date(Date.now() - 1).toISOString() } satisfies CallJoin });
    });
    const created = await page.request.post('/api/session', { data: {} });
    expect(created.status()).toBe(200);
    const initial: Snapshot = await created.json();
    const saved = await submit(page, initial, { type: 'replaceFacts', facts: { ...draftFacts(initial), opening: { amount: '321.09', status: 'exact' } } });
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Call expired', exact: true })).toContainText('saved figures');
    await stopped(page);
    expect(await current(page)).toEqual(saved);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    expect(await page.evaluate(() => window.voiceFixture.clients[0].connections.length)).toBe(0);
    await page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[1]?.connections.length ?? 0)).toBe(1);
    expect(await current(page)).toEqual(saved);
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  });

  test('local participant acknowledgement refreshes toggle and Continue on the persistent microphone', async ({ page, voice }, info) => {
    await speaking(page);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotStoppedSpeaking!());
    const status = page.locator('.voice-status');
    const capture = page.locator('.voice-status-panel');
    await expect(status).toHaveText('Listening');
    await expect(capture).toHaveAttribute('data-capturing', 'true');
    const microphone = await page.evaluateHandle(() => window.voiceFixture.clients[0].tracks().local.audio!);
    const mute = page.getByRole('button', { name: 'Mute microphone', exact: true });
    await expect(mute).toBeInViewport({ ratio: 1 });
    await mute.focus(); await page.keyboard.press('Enter');
    await expect(status).toHaveText('Microphone muted');
    await expect(capture).toHaveAttribute('data-capturing', 'false');
    expect(await page.evaluate(async track => ({ same: window.voiceFixture.clients[0].tracks().local.audio === track,
      enabled: track.enabled, ready: track.readyState,
      permission: (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state,
      disconnects: window.voiceFixture.clients[0].disconnects,
    }), microphone)).toEqual({ same: true, enabled: false, ready: 'live', permission: 'granted', disconnects: 0 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await expect(status).toHaveText('Listening');
    await expect(capture).toHaveAttribute('data-capturing', 'true');
    expect(await page.evaluate(async track => ({ same: window.voiceFixture.clients[0].tracks().local.audio === track,
      enabled: track.enabled, ready: track.readyState,
      permission: (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state,
      disconnects: window.voiceFixture.clients[0].disconnects,
    }), microphone)).toEqual({ same: true, enabled: true, ready: 'live', permission: 'granted', disconnects: 0 });
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 1 }));
    await expect(status).toHaveText('Paused');
    await expect(capture).toHaveAttribute('data-capturing', 'false');
    const resume = page.getByRole('button', { name: 'Continue', exact: true });
    await expect(resume).toBeInViewport({ ratio: 1 });
    await resume.click();
    await expect(resume).toBeDisabled();
    await expect(status).toHaveText('Paused');
    expect(await page.evaluate(() => window.voiceFixture.clients[0].isMicEnabled)).toBe(false);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 2 }));
    await expect(status).toHaveText('Listening');
    await expect(capture).toHaveAttribute('data-capturing', 'true');
    expect(await page.evaluate(track => {
      const client = window.voiceFixture.clients[0];
      return { same: client.tracks().local.audio === track, enabled: track.enabled, ready: track.readyState,
        mic: client.isMicEnabled, clients: window.voiceFixture.clients.length, tracks: window.voiceFixture.tracks.length,
        listeners: client.transport.participants.size, connections: client.connections.length, messages: client.messages };
    }, microphone)).toEqual({ same: true, enabled: true, ready: 'live', mic: true, clients: 1, tracks: 2, listeners: 1,
      connections: 1, messages: [{ type: 'continue-conversation', data: { sequence: 1 } }] });
    await page.screenshot({ path: info.outputPath('microphone-acknowledged.png'), fullPage: true });
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    await stopped(page);
    expect(await page.evaluate(() => ({ listeners: window.voiceFixture.clients[0].transport.participants.size,
      destroyed: window.voiceFixture.destroyed }))).toEqual({ listeners: 0, destroyed: 0 });
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
    await microphone.dispose();
  });

  test('stalled transport reconnect ends media and retains the financial session', async ({ page, voice }) => {
    await speaking(page);
    const saved = await current(page);
    const settings: Settings = await (await page.request.get('/api/settings')).json();
    await page.clock.install();
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onTransportStateChanged!('connecting'));
    await expect(page.locator('.voice-status')).toHaveText('Reconnecting');
    await page.clock.fastForward(settings.voiceStartupSeconds * 1000);
    await expect(page.getByRole('alert', { name: 'Connection timed out' })).toBeVisible();
    await stopped(page);
    expect(await current(page)).toEqual(saved);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
    await expect(page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  });

  test('server waiting: Continue keeps the call, captions and financial corrections until an active ACK', async ({ page, voice }, info) => {
    await speaking(page);
    const initial = await current(page);
    const saved = await submit(page, initial, { type: 'replaceFacts', facts: { ...draftFacts(initial), opening: { amount: '123.45', status: 'exact' } } });
    const cash = page.getByRole('article', { name: saved.workspace!.cards!.find(card => card.template === 'cash')!.title, exact: true });
    await expect(cash).toContainText('₹123.45');
    const before = await geometry(page);
    await page.evaluate(() => {
      const client = window.voiceFixture.clients[0];
      client.callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 1 });
      client.callbacks.onUserTranscript!({ text: 'Rent is due tomorrow', final: true, timestamp: 'rent', user_id: 'fixture-user' });
      client.callbacks.onBotStoppedSpeaking!();
      client.callbacks.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 2, reason: 'response' });
    });
    await expect(page.locator('.voice-status')).toHaveText('Paused');
    await expect(page.locator('.call-orb')).toHaveAttribute('data-state', 'paused');
    await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
    await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'muted');
    await expect(page.locator('.conversation')).toHaveAttribute('data-running', 'true');
    await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^(Unmute microphone|Mute microphone|Resume audio)$/ })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const resume = page.getByRole('button', { name: 'Continue', exact: true });
    await expect(resume).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => {
      const client = window.voiceFixture.clients[0];
      return { mic: client.isMicEnabled, enabled: client.tracks().local.audio!.enabled,
        tracks: window.voiceFixture.tracks.map(track => track.readyState), disconnects: client.disconnects,
        muted: document.querySelector('audio')!.muted, paused: document.querySelector('audio')!.paused };
    })).toEqual({ mic: false, enabled: false, tracks: ['live', 'live'], disconnects: 0, muted: true, paused: true });
    await stable(page, before, 'server waiting');
    await page.screenshot({ path: info.outputPath('server-waiting.png'), fullPage: true });
    const corrected = await submit(page, saved, { type: 'replaceFacts', facts: { ...draftFacts(saved), opening: { amount: '678.90', status: 'exact' } } });
    await expect(cash).toContainText('₹678.90');
    await resume.focus(); await page.keyboard.press('Enter');
    await expect(resume).toBeDisabled();
    await expect(page.getByRole('button', { name: 'End conversation', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.voiceFixture.clients[0].messages)).toEqual([{ type: 'continue-conversation', data: { sequence: 2 } }]);
    expect(await page.evaluate(() => window.voiceFixture.clients[0].isMicEnabled)).toBe(false);
    await expect(page.locator('.voice-status')).toHaveText('Paused');
    await page.evaluate(() => {
      const callbacks = window.voiceFixture.clients[0].callbacks;
      callbacks.onUserTranscript!({ text: 'Delayed recognition', final: false, timestamp: 'late', user_id: 'fixture-user' });
      callbacks.onBotOutput!({ text: 'Obsolete amount: 9000', segment_id: 100, spoken_status: 'completed' });
    });
    await expect(page.getByRole('region', { name: 'Live caption' })).toContainText('Rent is due tomorrow');
    await expect(page.getByText(/Delayed recognition|Obsolete amount: 9000/)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('server-waiting-ack.png'), fullPage: true });
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 3 }));
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'true');
    await expect(page.getByText('Rent is due tomorrow', { exact: true })).toBeVisible();
    expect(await current(page)).toEqual(corrected);
    expect(await page.evaluate(() => ({ clients: window.voiceFixture.clients.length,
      connections: window.voiceFixture.clients[0].connections.length, disconnects: window.voiceFixture.clients[0].disconnects,
      playing: !document.querySelector('audio')!.paused, muted: document.querySelector('audio')!.muted })))
      .toEqual({ clients: 1, connections: 1, disconnects: 0, playing: true, muted: false });
    await page.evaluate(() => {
      const client = window.voiceFixture.clients[0];
      client.callbacks.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 2 });
      client.callbacks.onBotStartedSpeaking!();
    });
    await expect(page.locator('.voice-status')).toHaveText('Speaking');
    await stable(page, before, 'server resume', true);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(0);
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    await stopped(page);
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
  });

  test('server waiting: End cancels a pending Continue and stale ACKs cannot restart capture', async ({ page, voice }) => {
    await speaking(page);
    await page.evaluate(() => {
      const callbacks = window.voiceFixture.clients[0].callbacks;
      callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 1 });
      callbacks.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 2 });
    });
    await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'muted');
    await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    await stopped(page);
    await page.evaluate(() => {
      const callbacks = window.voiceFixture.clients[0].callbacks;
      callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 3 });
      callbacks.onBotStartedSpeaking!();
    });
    await ended(page);
    expect(await page.evaluate(() => window.voiceFixture.clients[0].isMicEnabled)).toBe(false);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
  });

  test('server waiting: stale requests resynchronize and short enlarged-text layouts keep controls reachable', async ({ page, voice }, info) => {
    await speaking(page);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 2 }));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.evaluate(() => {
      const callbacks = window.voiceFixture.clients[0].callbacks;
      callbacks.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 4 });
      callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 3 });
    });
    await expect(page.locator('.voice-status')).toHaveText('Paused');
    await page.setViewportSize({ width: info.project.name === 'mobile' ? 360 : 768, height: 420 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
    const resume = page.getByRole('button', { name: 'Continue', exact: true });
    await resume.scrollIntoViewIfNeeded();
    await expect(resume).toBeInViewport({ ratio: 0.99 });
    await expect(resume).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('server-waiting-enlarged.png'), fullPage: true });
    await resume.click();
    expect(await page.evaluate(() => window.voiceFixture.clients[0].messages.at(-1))).toEqual({ type: 'continue-conversation', data: { sequence: 4 } });
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 5 }));
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  });

  for (const failure of ['lost updates', 'lost updates on history', 'corrupt snapshot'] as const) test(`${failure} stops active speech; fresh restart ignores old events and retains real corrections`, async ({ page, voice }, info) => {
    await speaking(page);
    const initial = await current(page);
    const saved = await submit(page, initial, { type: 'replaceFacts', facts: { ...draftFacts(initial), opening: { amount: '123.45', status: 'exact' } } });
    const cash = page.getByRole('article', { name: saved.workspace!.cards!.find(card => card.template === 'cash')!.title, exact: true });
    await expect(cash).toContainText('₹123.45');
    if (failure === 'lost updates on history') {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
      await expect(page).toHaveURL(/\/history$/);
    }
    await page.evaluate(failure => {
      const stream = window.recoveryStreams.at(-1)!;
      if (failure !== 'corrupt snapshot') { stream.close(); stream.dispatchEvent(new Event('error')); }
      else stream.dispatchEvent(new MessageEvent('snapshot', { data: '{"facts":null}' }));
    }, failure);
    await stopped(page);
    if (failure === 'lost updates on history') {
      await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Saved conversations', exact: true })).toHaveText('No conversations yet.');
      await page.getByRole('region', { name: 'History', exact: true }).getByRole('link', { name: 'Talk to Isha', exact: true }).last().click();
      await expect(page).toHaveURL(/\/app$/);
      await expect(page.getByRole('region', { name: 'Your saved plan is safe.' })).toBeVisible();
    }
    else await expect(page.getByRole('button', { name: 'Reconnect', exact: true }).first()).toBeDisabled();
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    const corrected = await submit(page, saved, { type: 'replaceFacts', facts: { ...draftFacts(saved), opening: { amount: '678.90', status: 'exact' } } });
    await expect(page.getByRole('status', { name: 'Conversation stopped' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Your saved plan is safe.' })).toHaveCount(0);
    await expect(cash).toContainText('₹678.90');
    await page.evaluate(saved => {
      const old = window.recoveryStreams[0];
      old.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify({ ...saved, sequence: saved.sequence + 100 }) }));
      old.dispatchEvent(new MessageEvent('deleted', { data: '{}' }));
      window.voiceFixture.clients[0].callbacks.onBotOutput!({ text: 'Obsolete financial advice', spoken_status: 'completed' });
    }, saved);
    await expect(cash).toContainText('₹678.90');
    await expect(page.getByText('Obsolete financial advice')).toHaveCount(0);
    expect(await current(page)).toEqual(corrected);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('recovered-financial-updates.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect.poll(() => voice.calls.filter(method => method === 'POST').length).toBe(2);
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[1]?.connections.length ?? 0)).toBe(1);
    await expect(page.locator('.voice-status')).toHaveText('Reconnecting');
    await page.evaluate(() => {
      const callbacks = window.voiceFixture.clients[0].callbacks;
      callbacks.onBotReady!({ version: '2.1.0' }); callbacks.onBotStartedSpeaking!();
      callbacks.onRemoteAudioLevel!(.6, { id: 'assistant', name: 'Assistant', local: false });
    });
    await expect(page.locator('.voice-status')).toHaveText('Reconnecting');
    await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
    await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'connecting');
    await page.evaluate(() => {
      const callbacks = window.voiceFixture.clients[1].callbacks;
      callbacks.onConnected!(); callbacks.onBotReady!({ version: '2.1.0' });
    });
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).srcObject)).toBeNull();
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  });

  test('expired cookies during active SDK audio unmount the private workspace and ignore late snapshots', async ({ page, context }) => {
    await speaking(page);
    const saved = await current(page);
    const cookies = await context.cookies();
    await context.addCookies(cookies.map(cookie => ({ ...cookie, expires: 1 })));
    expect((await page.request.get('/api/session')).status()).toBe(401);
    await page.evaluate(() => { const stream = window.recoveryStreams.at(-1)!; stream.close(); stream.dispatchEvent(new Event('error')); });
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.locator('audio')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    await page.evaluate(saved => window.recoveryStreams[0].dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(saved) })), saved);
    await expect(page.getByRole('region', { name: 'Your financial picture' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Retry connection|Reconnect|Retry same action)$/ })).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Conversation stopped' })).toHaveCount(0);
  });

  test('sign out stops active SDK capture and playback before the logout response', async ({ page }) => {
    await speaking(page);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserTranscript!({
      text: 'Private visit caption', timestamp: '2026-09-11T04:00:01.000Z', final: true, user_id: 'fixture-user',
    }));
    await expect(page.getByRole('region', { name: 'Live caption', exact: true })).toContainText('Private visit caption');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
    const savedHistory = page.getByRole('region', { name: 'History', exact: true });
    await expect(savedHistory.getByRole('navigation', { name: 'Saved conversations', exact: true })).toHaveText('No conversations yet.');
    await expect(savedHistory).not.toContainText('Private visit caption');
    await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Profile menu' }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/history$/);
    const blocked = page.getByRole('status', { name: 'A conversation is open', exact: true });
    await expect(blocked).toBeVisible();
    expect(await page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(0);
    expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'live'))).toBe(true);
    expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
    await blocked.getByRole('button', { name: 'Continue', exact: true }).click();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/auth/logout', async route => { await waiting; await route.fallback(); });
    await page.getByRole('button', { name: 'Profile menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('audio')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onError!({ label: 'rtvi-ai', id: 'late-error', type: 'error', data: { error: 'private disposed-provider diagnostic', fatal: true } }));
    await expect(page.getByRole('alert', { name: 'Conversation stopped' })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('private disposed-provider diagnostic');
    release();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByText('Private visit caption', { exact: true })).toHaveCount(0);
    await signIn(page, '/history');
    await expect(savedHistory.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
    await expect(savedHistory.getByRole('navigation', { name: 'Saved conversations', exact: true })).toHaveText('No conversations yet.');
    await expect(savedHistory).not.toContainText('Private visit caption');
    await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  });

  test('account deletion in another tab stops active SDK audio and lands quietly without recovery', async ({ page, context, baseURL }) => {
    await speaking(page);
    const original = (await (await context.request.get('/api/auth/session')).json()).user;
    const settings = await context.newPage();
    await settings.goto('/account');
    await settings.getByRole('button', { name: 'Delete app account', exact: true }).click();
    await settings.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
    const deletion = settings.waitForResponse(response => new URL(response.url()).pathname === '/api/account' && response.request().method() === 'DELETE');
    await settings.getByRole('button', { name: 'Permanently delete app account', exact: true }).click();
    expect((await deletion).status()).toBe(200);
    for (const tab of [page, settings]) {
      await expect(tab).toHaveURL(`${baseURL}/login`);
      await expect(tab.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled();
      await expect(tab.getByRole('button', { name: 'Profile menu', exact: true })).toHaveCount(0);
      await expect(tab.getByRole('dialog')).toHaveCount(0);
      await expect(tab.locator('body')).not.toContainText(/Your saved plan is safe|Opening your plan|Please sign in again|have been deleted/);
    }
    await expect(page.locator('audio')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    expect(await page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(1);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserTranscript!({
      text: 'Stale deleted-account caption', timestamp: '2026-09-11T04:00:01.000Z', final: true, user_id: 'fixture-user',
    }));
    await expect(page.locator('body')).not.toContainText('Stale deleted-account caption');
    expect((await context.request.get('/api/auth/session')).status()).toBe(401);
    await settings.close();
    await signIn(page);
    expect((await (await context.request.get('/api/auth/session')).json()).user.id).not.toBe(original.id);
    expect((await context.request.get('/api/session')).status()).toBe(404);
    expect(await (await context.request.get('/api/history')).json()).toEqual({ conversations: [] });
  });

  test('disconnected microphone releases active playback and offers explicit retry', async ({ page, voice }) => {
    await speaking(page);
    await page.evaluate(() => {
      const track = window.voiceFixture.clients[0].tracks().local.audio!;
      track.stop(); track.dispatchEvent(new Event('ended'));
    });
    await stopped(page);
    const error = page.getByRole('alert', { name: 'Microphone disconnected' });
    await expect(error).toContainText('Reconnect your microphone');
    await expect(error.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  });

  test('blocked playback resumes only through a user action with a live remote track', async ({ page }) => {
    await expect(page.locator('audio')).toHaveCount(1);
    await page.evaluate(() => {
      document.querySelector('audio')!.autoplay = false;
      const play = HTMLMediaElement.prototype.play;
      let blocked = true;
      /** Reject the first playback attempt to exercise explicit audio recovery. */
      HTMLMediaElement.prototype.play = function () {
        if (blocked) { blocked = false; return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError')); }
        return play.call(this);
      };
    });
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
    await page.evaluate(async () => {
      const client = window.voiceFixture.clients[0];
      client.callbacks.onBotReady!({ version: '2.1.0' });
      await client.micReady;
      client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', name: 'Assistant', local: false });
      client.callbacks.onBotStartedSpeaking!();
    });
    await expect(page.locator('.voice-status')).toHaveText('Assistant audio paused');
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onRemoteAudioLevel!(.6, { id: 'assistant', name: 'Assistant', local: false }));
    await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
    await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'muted');
    expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
    await page.locator('.conversation-controls').getByRole('button', { name: 'Resume audio', exact: true }).click();
    await expect(page.locator('.voice-status')).toHaveText('Speaking');
    expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  });

  test('a committed action with a lost HTTP response retries its identical UUID/body exactly once', async ({ page }) => {
    await speaking(page);
    const empty = await current(page);
    const initial = await submit(page, empty, { type: 'replaceFacts', facts: { ...draftFacts(empty), coverage: { ...empty.facts.coverage, income: 'none' } } });
    const action = initial.workspace!.actions!.find(action => action.id === initial.plan.decisionAssessment!.nextActionId)!;
    const question = page.getByRole('listitem').filter({ has: page.getByText(action.question, { exact: true }) });
    const bodies: string[] = [];
    await page.route('**/api/session/commands', async route => {
      bodies.push(route.request().postData()!);
      if (bodies.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort('connectionreset');
      } else await route.fallback();
    });
    await question.getByRole('button', { name: 'I cannot confirm this now', exact: true }).click();
    const notice = page.getByRole('complementary', { name: 'Notifications' }).getByRole('alert', { name: 'Save not confirmed', exact: true });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Retry same action', exact: true })).toBeEnabled();
    const committed = await current(page);
    expect(committed.revision).toBe(initial.revision + 1);
    expect(committed.facts.decision!.responses).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toEqual({ commandId: expect.any(String), expectedRevision: initial.revision,
      operation: { type: 'respondToAction', actionId: action.id, response: 'unavailable' } });
    expect(committed.facts.opening.amountPaise).toBeNull();
    await notice.getByRole('button', { name: 'Retry same action', exact: true }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await current(page)).toEqual(committed);
    await expect(page.getByRole('button', { name: 'Retry same action', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  });

  test('denied capture offers an actionable modal toast without creating a session or room before retry', async ({ page, voice }, info) => {
    await page.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      let denied = true;
      /** Defer the first permission denial while allowing a later capture retry. */
      navigator.mediaDevices.getUserMedia = constraints => {
        if (denied) {
          denied = false;
          return new Promise((_resolve, reject) => { window.releaseCapture = () => reject(new DOMException('private device diagnostic', 'NotAllowedError')); });
        }
        return capture(constraints);
      };
    });
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    await expect(page.locator('.voice-status')).toHaveText('Connecting');
    await expect.poll(() => page.evaluate(() => !!window.releaseCapture)).toBe(true);
    const before = await geometry(page);
    await page.evaluate(() => window.releaseCapture!());
    const notice = page.getByRole('complementary', { name: 'Notifications' }).getByRole('status', { name: 'Microphone access denied' });
    await expect(notice).toContainText('browser’s site settings');
    await expect(notice.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(0);
    expect(await page.evaluate(() => window.voiceFixture.tracks.length)).toBe(0);
    expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
    await expect(page.getByText('private device diagnostic')).toHaveCount(0);
    await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
    await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'idle');
    await stable(page, before, 'permission notice arrival');
    await toastPlacement(page);
    await page.screenshot({ path: info.outputPath('provider-double-orb-denied.png'), fullPage: true });
    await page.getByRole('button', { name: 'Minimize notifications', exact: true }).click();
    await page.locator('.site-footer').getByRole('button', { name: 'Privacy', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Privacy', exact: true });
    await modal(page, dialog, 'Privacy', before);
    await dialog.getByRole('button', { name: 'Notifications (1)', exact: true }).click();
    await expect(dialog.getByRole('complementary', { name: 'Notifications' })).toBeVisible();
    await toastPlacement(page);
    await notice.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.voiceFixture.clients.at(-1)?.connections.length ?? 0)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.evaluate(() => {
      const client = window.voiceFixture.clients.at(-1)!;
      client.callbacks.onConnected!(); client.callbacks.onBotReady!({ version: '2.1.0' });
    });
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  });

  test('setup 503 releases capture and checks availability without automatically opening a billable call', async ({ page, voice }) => {
    await page.route('**/api/session/call', async route => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 503, json: { code: 'voiceUnavailable', message: 'private provider failure' } });
      else await route.fallback();
    });
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    const error = page.getByRole('alert', { name: 'Conversations unavailable' });
    await expect(error).toBeVisible();
    await stopped(page);
    await error.getByRole('button', { name: 'Check availability', exact: true }).click();
    await expect(error).toHaveCount(0);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(0);
    await expect(page.getByText('private provider failure')).toHaveCount(0);
  });

  for (const stage of ['device', 'room', 'ready'] as const) test(`ending before ${stage} completes stops late capture and never overlaps a room`, async ({ page, voice }) => {
    let release!: () => void;
    let requested = false;
    const started = stage === 'device' ? null : page.waitForRequest(request => new URL(request.url()).pathname === '/api/session/call' && request.method() === 'POST');
    if (stage === 'device') await page.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      /** Hold microphone acquisition until the test exercises call cancellation. */
      navigator.mediaDevices.getUserMedia = async constraints => {
        await new Promise<void>(resolve => { window.releaseCapture = resolve; });
        return capture(constraints);
      };
    });
    if (stage === 'room') {
      const pending = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/session/call', async route => {
        if (route.request().method() === 'POST') { requested = true; await pending; }
        await route.fallback();
      });
    }
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    if (stage === 'device') await expect.poll(() => page.evaluate(() => !!window.releaseCapture)).toBe(true);
    else if (stage === 'room') await expect.poll(() => requested).toBe(true);
    else await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
    await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'connecting');
    await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
    await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    const ending = stage === 'device' ? null : page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/call' && response.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    if (stage === 'device') await page.evaluate(() => window.releaseCapture!());
    if (ending) {
      const response = await ending;
      const { callId } = (await started!).postDataJSON() as { callId: string };
      expect(response.request().postDataJSON()).toEqual({ callId });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ callId, status: 'ended', cleanupConfirmed: true, message: null });
    }
    if (stage === 'room') {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/call' && response.request().method() === 'POST');
      release();
      expect((await pending).status()).toBe(409);
    }
    await ended(page);
    await stopped(page);
    await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotReady!({ version: '2.1.0' }));
    await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toHaveCount(0);
    expect(voice.calls.filter(method => method === 'POST')).toHaveLength(stage === 'device' ? 0 : 1);
    expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(stage === 'device' ? 0 : 1);
    expect(await page.evaluate(() => window.voiceFixture.clients[0].connections.length)).toBe(stage === 'ready' ? 1 : 0);
    const state: CallState = await page.evaluate(async () => (await fetch('/api/session/call')).json());
    expect(state.cleanupConfirmed).toBe(true);
    expect(state.status).toBe(stage === 'ready' ? 'ended' : 'idle');
    expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  });
});

/** Verify an ended call retains the conversation controls and financial pane. */
async function ended(page: Page) {
  await expect(page.locator('main')).toHaveAttribute('data-view', 'session');
  await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'ended');
  await expect(page.locator('.conversation-controls')).toBeVisible();
  await expect(page.locator('.financial-pane')).toBeVisible();
}

/** Fetch the saved financial snapshot and verify the session remains accessible. */
async function current(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/session', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  return response.json();
}

/** Submit a financial command at the supplied revision and return its saved result. */
async function submit(page: Page, snapshot: Snapshot, operation: Command['operation']): Promise<Snapshot> {
  const command: Command = { commandId: randomUUID(), expectedRevision: snapshot.revision, operation };
  const response = await page.request.post('/api/session/commands', { data: command, maxRedirects: 0 });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** Activate a plan control and verify it submits the intended command and revision. */
async function actOnPlan(page: Page, label: string, snapshot: Snapshot, operation: Command['operation']): Promise<Snapshot> {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/commands' && response.request().method() === 'POST');
  const action = operation.type === 'respondToAction' ? snapshot.workspace!.actions!.find(action => action.id === operation.actionId) : null;
  const controls = action ? page.locator('.workspace-questions > li').filter({ has: page.getByText(action.question, { exact: true }) }) : page;
  await controls.getByRole('button', { name: label, exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({
    commandId: expect.stringMatching(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i),
    expectedRevision: snapshot.revision, operation,
  });
  return response.json();
}

/** Complete the simulated connection and verify capture readiness without layout shifts. */
async function connected(page: Page, count = 1) {
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients.reduce((sum, client) => sum + client.connections.length, 0))).toBe(count);
  await expect(page.locator('.voice-status')).toHaveText(count === 1 ? 'Connecting' : 'Reconnecting');
  await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'connecting');
  await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toHaveCount(0);
  const snapshot = await current(page);
  await expect(page.locator('.context-period')).toHaveText(`${dateLabel(snapshot.anchorDate)} – ${dateLabel(lastDate(snapshot.endDateExclusive))}`);
  // Session dates and navigation precede the baseline for transport-only transitions.
  const before = await geometry(page);
  await page.evaluate(() => window.voiceFixture.clients.at(-1)!.callbacks.onConnected!());
  await expect(page.locator('.voice-status')).toHaveText(count === 1 ? 'Connecting to assistant' : 'Reconnecting');
  await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'connecting');
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toHaveCount(0);
  await stable(page, before, 'transport connected');
  await page.evaluate(() => window.voiceFixture.clients.at(-1)!.callbacks.onBotReady!({ version: '2.1.0' }));
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'true');
  const figures = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true });
  await expect(figures).toHaveCount(1);
  await expect(figures).toHaveAttribute('aria-disabled', 'true');
  await expect(figures).toBeDisabled();
  await expect(figures).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^(Your figures|Prefer typing\?)$/ })).toHaveCount(0);
  await expect(page.locator('.journey-tools, .voice-connection')).toHaveCount(0);
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);
  await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'listening');
  const orb = (await page.locator('canvas.aui-voice-orb').boundingBox())!;
  expect(orb.width).toBeGreaterThanOrEqual(150);
  expect(Math.abs(orb.height - orb.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(orb.width - (await page.locator('.call-orb').boundingBox())!.width * 2)).toBeLessThanOrEqual(1);
  await expect(page.locator('.live-layout')).toBeVisible();
  await stable(page, before, 'active');
  return before;
}

/** Capture conversation geometry and page dimensions for transition comparisons. */
async function geometry(page: Page) {
  return page.evaluate(() => ({
    scrollY, scrollHeight: document.documentElement.scrollHeight,
    gutter: innerWidth - document.documentElement.clientWidth,
    boxes: ['.site-header', 'main', '.journey-intro h1', '.conversation', '.call-orb', '.conversation-controls', '.live-caption', '.financial-pane', '.context-scroll', '.site-footer'].flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element) return [];
      const { x, y, width, height } = element.getBoundingClientRect();
      return [{ selector, x, y, width, height }];
    }),
  }));
}

/** Verify stable call geometry while allowing financial content to grow on mobile. */
async function stable(page: Page, before: Awaited<ReturnType<typeof geometry>>, state: string, financial = false) {
  const after = await geometry(page);
  const natural = financial && page.viewportSize()!.width <= 700;
  if (!natural) {
    expect(Math.abs(after.scrollY - before.scrollY), `${state}: document scrollY`).toBeLessThanOrEqual(1);
    expect(Math.abs(after.scrollHeight - before.scrollHeight), `${state}: document height`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(after.gutter - before.gutter), `${state}: scrollbar gutter`).toBeLessThanOrEqual(1);
  for (const box of before.boxes) {
    const actual = after.boxes.find(item => item.selector === box.selector);
    expect(actual, `${state}: ${box.selector} exists`).toBeDefined();
    // Mobile cards use document flow; call controls retain their dimensions as money details grow.
    const dimensions = natural ? ['x', 'width'] as const : box.selector === '.context-scroll' ? ['x', 'width'] as const : ['x', 'y', 'width', 'height'] as const;
    for (const key of dimensions)
      expect(Math.abs(actual![key] - box[key]), `${state}: ${box.selector} ${key}`).toBeLessThanOrEqual(1);
    if (natural && ['.conversation', '.call-orb', '.conversation-controls', '.live-caption'].includes(box.selector)) {
      expect(Math.abs(actual!.height - box.height), `${state}: ${box.selector} height`).toBeLessThanOrEqual(1);
      expect(Math.abs(actual!.y + after.scrollY - box.y - before.scrollY), `${state}: ${box.selector} document position`).toBeLessThanOrEqual(1);
    }
  }
  const pane = after.boxes.find(box => box.selector === '.financial-pane')!;
  const scroll = after.boxes.find(box => box.selector === '.context-scroll')!;
  expect(scroll.height, `${state}: financial content remains usable`).toBeGreaterThan(0);
  expect(scroll.y).toBeGreaterThanOrEqual(pane.y);
  expect(scroll.y + scroll.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('.conversation-controls').evaluate(element => element.scrollHeight <= element.clientHeight + 1), `${state}: controls contain all button rows`).toBe(true);
  await expect(page.locator('.conversation :is(details, summary, [aria-expanded])')).toHaveCount(0);
}

/** Verify modal focus containment, scrolling and background layout stability. */
async function modal(page: Page, dialog: Locator, title: string, before: Awaited<ReturnType<typeof geometry>>) {
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(dialog.locator('.dialog-body')).toHaveCSS('overflow-y', 'auto');
  await expect(dialog).toBeInViewport({ ratio: 1 });
  const body = await dialog.locator('.dialog-body').boundingBox();
  expect(body!.height).toBeGreaterThan(0);
  await page.locator('.conversation-controls button').first().focus();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  const stops = await dialog.locator('button:enabled, a[href], [tabindex="0"]').count();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < stops + 2; index++) {
      await page.keyboard.press(key);
      await expect(dialog.locator(':focus')).toHaveCount(1);
    }
  }
  await stable(page, before, `${title} open`, true);
}

/** Verify notifications stay reachable and interactive near the viewport's lower-right edge. */
async function toastPlacement(page: Page) {
  const viewport = page.getByRole('complementary', { name: 'Notifications' });
  await expect(viewport).toHaveClass('toast-viewport');
  await expect(viewport).toHaveCSS('position', 'fixed');
  await expect(viewport).toBeInViewport({ ratio: 0.99 });
  const toggle = viewport.getByRole('button', { name: 'Minimize notifications', exact: true });
  await expect(toggle).toHaveCSS('pointer-events', 'auto');
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await toggle.click({ trial: true });
  const stack = viewport.getByRole('list', { name: 'Notification list' });
  await expect(stack).toHaveCSS('pointer-events', 'auto');
  expect(await stack.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.right - 1, box.y + box.height / 2));
  }), 'Notification scroll edge receives pointer input').toBe(true);
  const box = (await viewport.boundingBox())!;
  const size = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(size.width - box.x - box.width).toBeLessThanOrEqual(32);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  expect(size.height - box.y - box.height).toBeLessThanOrEqual(32);
}

/** Verify active-call controls and financial details remain usable across viewport sizes. */
async function layout(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('.voice-status')).toBeVisible();
  await page.getByRole('button', { name: 'End conversation', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'End conversation', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toBeInViewport({ ratio: 1 });
  const details = page.getByRole('region', { name: 'Financial picture details', exact: true });
  const natural = page.viewportSize()!.width <= 700;
  await expect(details).toHaveCSS('overflow-y', natural ? 'visible' : 'auto');
  if (!natural) await expect(details).toBeInViewport({ ratio: 1 });
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
  if (natural) {
    expect(await page.evaluate(() => !['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY))).toBe(true);
    await page.locator('.site-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.site-footer')).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: 'End conversation', exact: true }).scrollIntoViewIfNeeded();
  } else expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
}

test('focused call surface and history navigation', async ({ page, voice }, info) => {
  test.skip(info.project.name !== 'desktop', 'One active call across the explicit desktop, tablet and mobile matrix.');
  await page.goto('/app');
  const response = await page.request.get('/api/settings', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const configuration = await response.json() as Settings;
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  const live = page.getByRole('region', { name: 'Live caption', exact: true });
  const controls = page.locator('.conversation-controls');
  await expect(live).toHaveText('Captions appear here');
  const start = controls.getByRole('button', { name: 'Start talking', exact: true });
  await expect(start).toHaveText('');
  await start.click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
  await page.evaluate(async () => {
    const client = window.voiceFixture.clients[0];
    client.callbacks.onConnected!(); client.callbacks.onBotReady!({ version: '2.1.0' });
    await client.micReady;
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', local: false, name: 'Assistant' });
    client.callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 1 });
    for (const [text, timestamp] of [['Later figure', '2026-09-11T04:00:02.000Z'], ['Earlier figure', '2026-09-11T04:00:01.000Z']])
      client.callbacks.onUserTranscript!({ text, timestamp, final: true, user_id: 'fixture-user' });
    client.callbacks.onBotStartedSpeaking!();
    client.callbacks.onBotOutput!({ text: 'Spoken prefix. Unspoken tail.', segment_id: 91, will_be_spoken: true,
      spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Spoken prefix.', remaining_text: 'Unspoken tail.' } });
  });
  await expect(live.getByText('Spoken prefix.', { exact: true })).toBeVisible();
  const spokenTime = await live.locator('time').getAttribute('datetime');
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onUserStartedSpeaking!(); callbacks.onBotStoppedSpeaking!();
    callbacks.onBotOutput!({ text: 'Spoken prefix. Unspoken tail.', segment_id: 91, will_be_spoken: true, spoken_status: 'completed' });
  });
  await expect(live).toContainText(`${configuration.assistantName} · interrupted`);
  await expect(live.getByText('Spoken prefix.', { exact: true })).toBeVisible();
  await expect(live.locator('time')).toHaveAttribute('datetime', spokenTime!);
  await expect(live.locator('time')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(live).not.toContainText('Unspoken tail.');
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onUserTranscript!({ text: 'Latest figure', timestamp: '2026-09-11T04:00:03.000Z', final: true, user_id: 'fixture-user' });
    callbacks.onUserStoppedSpeaking!();
    callbacks.onUserTranscript!({ text: 'Still explaining', timestamp: 'interim', final: false, user_id: 'fixture-user' });
  });
  await expect(live.getByText('Still explaining', { exact: true })).toBeVisible();
  const interimTime = await live.locator('time').getAttribute('datetime');
  const snapshot = await current(page);
  const identity = await page.evaluateHandle(() => ({ client: window.voiceFixture.clients[0],
    track: window.voiceFixture.clients[0].tracks().local.audio, player: document.querySelector('audio')!,
    source: document.querySelector('audio')!.srcObject }));
  const history = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true });
  const savedHistory = page.getByRole('region', { name: 'History', exact: true });
  const saved = savedHistory.getByRole('navigation', { name: 'Saved conversations', exact: true });
  for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 } })) {
    await test.step(name, async () => {
      await page.setViewportSize(viewport);
      const canvas = page.locator('.call-orb canvas.aui-voice-orb');
      await expect(canvas).toHaveCount(1);
      await expect(canvas).toHaveAttribute('data-state', 'listening');
      const orb = (await canvas.boundingBox())!;
      expect(orb.width).toBeGreaterThanOrEqual(150);
      expect(Math.abs(orb.width - orb.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(orb.width - (await page.locator('.call-orb').boundingBox())!.width * 2)).toBeLessThanOrEqual(1);
      await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
        const gl = element.getContext('webgl2');
        const program = gl?.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
        return !!gl && !!program && !!gl.getProgramParameter(program, gl.LINK_STATUS);
      })).toBe(true);
      for (const label of ['Mute microphone', 'End conversation']) {
        const button = controls.getByRole('button', { name: label, exact: true });
        await expect(button).toBeEnabled(); await expect(button).toHaveText('');
        await expect(button.locator('svg')).toHaveCount(1);
        await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport({ ratio: 1 });
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      await live.scrollIntoViewIfNeeded(); await expect(live).toBeInViewport({ ratio: 1 });
      expect((await live.boundingBox())!.y).toBeGreaterThanOrEqual((await controls.boundingBox())!.y + (await controls.boundingBox())!.height);
      await expect(live.getByText('Still explaining', { exact: true })).toBeVisible();
      await expect(page.locator('.captions, [class*="caption-history"]')).toHaveCount(0);
      await expect(savedHistory).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Earlier captions', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`focused-call-${name}.png`), fullPage: true });
      await expect(history).toBeEnabled(); await history.click();
      await expect(page).toHaveURL(/\/history$/);
      await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeFocused();
      await expect(savedHistory.getByRole('link', { name: 'Return to call', exact: true }).last()).toBeVisible();
      await expect(page.locator('canvas')).toHaveCount(0);
      if (name === 'desktop') {
        await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Profile menu' }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        await expect(page).toHaveURL(/\/history$/);
        const blocked = page.getByRole('status', { name: 'A conversation is open', exact: true });
        await expect(blocked).toBeVisible();
        await blocked.getByRole('button', { name: 'Continue', exact: true }).click();
      }
      await expect(saved).toHaveAttribute('aria-busy', 'false');
      await expect(saved).toHaveText('No conversations yet.');
      await expect(saved.getByRole('link')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
      await expect(savedHistory).not.toContainText(/Earlier figure|Later figure|Latest figure|Spoken prefix\.|Unspoken tail\.|Still explaining/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`focused-history-${name}.png`), fullPage: true });
      await savedHistory.getByRole('link', { name: 'Return to call', exact: true }).last().click();
      await expect(page).toHaveURL(/\/app$/);
      await expect(page.locator('.voice-status')).toHaveText('Listening');
      await expect(live.getByText('Still explaining', { exact: true })).toBeVisible();
      await expect(live.locator('time')).toHaveAttribute('datetime', interimTime!);
      expect(await page.evaluate(identity => identity.client === window.voiceFixture.clients[0]
        && identity.track === identity.client.tracks().local.audio && identity.track?.readyState === 'live'
        && identity.player === document.querySelector('audio') && identity.source === identity.player.srcObject
        && !identity.player.paused && !identity.player.muted, identity)).toBe(true);
      expect(await page.evaluate(() => ({ clients: window.voiceFixture.clients.length, tracks: window.voiceFixture.tracks.length,
        connections: window.voiceFixture.clients[0].connections.length, disconnects: window.voiceFixture.clients[0].disconnects })))
        .toEqual({ clients: 1, tracks: 2, connections: 1, disconnects: 0 });
    });
  }
  const privacy = page.locator('.site-footer').getByRole('button', { name: 'Privacy', exact: true });
  await expect(page.getByRole('button', { name: 'Privacy', exact: true })).toHaveCount(1);
  await privacy.click();
  const dialog = page.getByRole('dialog', { name: 'Privacy', exact: true });
  await expect(dialog).toContainText('Azure Speech processes audio and spoken replies.');
  await expect(dialog).toContainText('Do not provide passwords, bank account numbers or full payment-card details.');
  const settings = await page.request.get('/api/settings', { maxRedirects: 0 });
  expect(settings.status()).toBe(200);
  await expect(dialog).toContainText(`Plans and associated conversations expire ${(await settings.json() as Settings).retentionHours} hours after plan creation and are removed during expiry cleanup.`);
  await expect(dialog).toContainText('Signing out does not delete saved data.');
  await dialog.getByRole('button', { name: 'Close privacy', exact: true }).click();
  await expect(privacy).toBeFocused();
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 2 }));
  await expect(page.locator('.voice-status')).toHaveText('Paused');
  await history.click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(saved).toHaveText('No conversations yet.');
  await expect(savedHistory).not.toContainText(/Earlier figure|Later figure|Latest figure|Spoken prefix\.|Unspoken tail\.|Still explaining/);
  await savedHistory.getByRole('link', { name: 'Return to call', exact: true }).last().click();
  const resume = controls.getByRole('button', { name: 'Continue', exact: true });
  await expect(resume).toBeEnabled(); await expect(resume).toHaveText('');
  expect(await page.evaluate(() => window.voiceFixture.clients[0].isMicEnabled)).toBe(false);
  expect(await page.evaluate(() => window.voiceFixture.clients[0].messages)).toEqual([]);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 3 }));
  await expect(page.locator('.voice-status')).toHaveText('Paused');
  await resume.focus(); await page.keyboard.press('Enter');
  await expect(resume).toBeDisabled(); await expect(resume).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.voiceFixture.clients[0].messages)).toEqual([{ type: 'continue-conversation', data: { sequence: 2 } }]);
  expect(await page.evaluate(() => window.voiceFixture.clients[0].isMicEnabled)).toBe(false);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 3 }));
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'true');
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  expect(await page.evaluate(identity => identity.client === window.voiceFixture.clients[0]
    && identity.track === identity.client.tracks().local.audio && identity.track?.enabled === true, identity)).toBe(true);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(0);
  expect(await current(page)).toEqual(snapshot);
  await identity.dispose();
  await controls.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await history.click(); await expect(saved).toHaveText('No conversations yet.');
  await expect(savedHistory).not.toContainText(/Earlier figure|Later figure|Latest figure|Spoken prefix\.|Unspoken tail\.|Still explaining/);
  await page.reload();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
  await expect(saved).toHaveText('No conversations yet.');
  await expect(saved.getByRole('link')).toHaveCount(0);
  await expect(savedHistory).not.toContainText(/Earlier figure|Later figure|Latest figure|Spoken prefix\.|Unspoken tail\.|Still explaining/);
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(0);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(await current(page)).toEqual(snapshot);
  await page.getByRole('button', { name: 'Profile menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await page.goto('/history');
  await expect(page).toHaveURL(/\/login\?returnTo=\/history$/);
  await expect(savedHistory).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
});

test('provider double: live picture → salary-date correction over SSE → End → Money export', async ({ page, voice }, testInfo) => {
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
  await page.getByRole('button', { name: 'Start talking' }).click();
  const ready = await connected(page);
  expect(await page.evaluate(() => window.voiceFixture.tracks.map(track => ({ kind: track.kind, state: track.readyState })))).toEqual([{ kind: 'audio', state: 'live' }]);
  await expect(page.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
  await page.evaluate(() => {
    const events = window.voiceFixture.clients[0].callbacks;
    events.onUserStartedSpeaking!();
    events.onUserTranscript!({ text: 'Test figures: I have five thousand available.', final: true, timestamp: '2026-09-11T04:00:01.000Z', user_id: 'fixture-user' });
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
      { id: 'salary', kind: 'income', label: 'Salary', amount: { amount: '30000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 10), recurrence: 'once', certainty: 'exact' }, reliability: 'reliable', autoDebit: false },
      { id: 'rent', kind: 'essential', label: 'Rent', amount: { amount: '12000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact' }, autoDebit: false },
      { id: 'loan', kind: 'debt', label: 'Loan', amount: { amount: '6000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 5), recurrence: 'once', certainty: 'exact' }, debtType: 'loan', autoDebit: false },
      { id: 'food', kind: 'essential', label: 'Food', amount: { amount: '3000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 7), recurrence: 'once', certainty: 'exact' }, autoDebit: false },
      { id: 'card', kind: 'debt', label: 'Card', amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 15), recurrence: 'once', certainty: 'exact' }, debtType: 'card', autoDebit: false },
      { id: 'optional', kind: 'optional', label: 'Optional purchase', amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 16), recurrence: 'once', certainty: 'exact' }, autoDebit: false },
    ],
  };
  const saved = await submit(page, initial, { type: 'replaceFacts', facts });
  expect(saved.plan.firstGap).toEqual({ date: dateAt(initial.anchorDate, 2), amountPaise: 700000 });
  expect(saved.plan.peakGapPaise).toBe(1600000);
  const salary = page.getByRole('listitem', { name: 'Salary', exact: true });
  const gap = page.getByRole('article', { name: 'Cash gap and timing risk', exact: true });
  const focus = page.locator('.workspace-outcome');
  const action = saved.plan.decisionAssessment!.actions!.find(item => item.id === saved.plan.decisionAssessment!.nextActionId)!;
  await expect(page.locator('.workspace-questions > li > p').filter({ hasText: action.question })).toHaveText(action.question);
  await expect(gap.locator('p:visible').filter({ hasText: action.question })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Edit figures|View all figures)$/ })).toHaveCount(0);
  await expect(salary).toContainText(dateLabel(saved.facts.records[0].schedule.date!));
  await expect(salary).toContainText(money(saved.facts.records[0].amount.amountPaise));
  await expect(gap).toContainText(money(saved.plan.firstGap!.amountPaise));
  await expect(gap.locator('.workspace-result').filter({ has: page.getByText('Largest cash gap', { exact: true }) })).toContainText(money(saved.plan.peakGapPaise));
  const records = page.locator('.financial-context .fact-row');
  await expect(records).toHaveCount(6);
  expect(await records.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
    .toEqual(['Salary', 'Rent', 'Food', 'Loan', 'Card', 'Optional purchase']);
  await expect(page.getByRole('article', { name: 'Available opening cash', exact: true })).toContainText('₹5,000.00');
  await stable(page, ready, 'first financial SSE commit', true);
  const picture = await geometry(page);
  expect(picture.boxes.some(box => box.selector === '.context-scroll')).toBe(true);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onLLMFunctionCallStopped!({ tool_call_id: 'fixture-save', cancelled: false }));
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await stable(page, picture, 'financial save completed');
  await layout(page);
  await salary.scrollIntoViewIfNeeded();
  await expect(salary).toBeInViewport({ ratio: 0.99 });
  await stable(page, picture, 'reported figure scrolled into view', true);
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
  await stable(page, picture, 'proposal announcement', true);
  const reviewProposal = page.getByRole('button', { name: 'Review proposed change', exact: true });
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toBeVisible();
  await reviewProposal.click();
  await expect(proposal.getByRole('heading', { name: 'Spending change preview', exact: true })).toBeFocused();
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await expect(proposal).toContainText('Optional purchase');
  await expect(proposal).toContainText('₹2,000.00 Reported → ₹0.00 Proposed');
  await expect(proposal).toContainText('A higher closing balance does not remove an earlier cash gap.');
  for (const [name, plan, closing] of [
    ['Before · active plan', preview.plan, 'Projected closing cash'],
    ['After · preview', preview.preview!.plan, 'Assumed closing cash'],
  ] as const) {
    const comparison = proposal.getByRole('region', { name, exact: true });
    await comparison.locator('summary').filter({ hasText: 'More calculated results' }).click();
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
  await expect(gap).toContainText(money(saved.plan.firstGap!.amountPaise));
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await stable(page, picture, 'inline proposal reviewed', true);

  const end = page.getByRole('button', { name: 'End conversation', exact: true });
  await end.focus();
  const corrected = await submit(page, saved, { type: 'updateFacts', changes: { expectedRevision: saved.revision,
    records: [{ id: 'salary', delete: false, distinct: false, schedule: { date: dateAt(initial.anchorDate, 1), certainty: 'exact' } }] } });
  expect(corrected.plan.firstGap).toBeNull();
  expect(corrected.plan.peakGapPaise).toBe(0);
  expect(corrected.facts.records[0].schedule.date).not.toBe(saved.facts.records[0].schedule.date);
  await expect(salary).toContainText(dateLabel(corrected.facts.records[0].schedule.date!));
  await expect(salary).not.toContainText(dateLabel(saved.facts.records[0].schedule.date!));
  await expect(focus).toContainText('Known commitments look covered');
  await expect(gap).toHaveCount(0);
  await expect(focus).not.toContainText('₹16,000.00');
  await expect(proposal).toHaveCount(0);
  await expect(page.locator('.context-updates [aria-live="polite"]')).toContainText(`Salary date: ${dateLabel(saved.facts.records[0].schedule.date!)} → ${dateLabel(corrected.facts.records[0].schedule.date!)}`);
  await expect(end).toBeFocused();
  expect(await records.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
    .toEqual(['Salary', 'Rent', 'Food', 'Loan', 'Card', 'Optional purchase']);
  await stable(page, picture, 'salary correction and proposal invalidation over SSE', true);
  const note = page.locator('.change-note');
  await expect(note).toHaveCSS('white-space', 'normal');
  expect(await note.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await note.getByRole('listitem').count()).toBeLessThanOrEqual(3);
  const changes = page.getByRole('button', { name: 'Recent changes', exact: true });
  await changes.click();
  const changeDialog = page.getByRole('dialog', { name: 'Recent changes', exact: true });
  await modal(page, changeDialog, 'Recent changes', picture);
  await expect(changeDialog).toContainText(`Salary date: ${dateLabel(saved.facts.records[0].schedule.date!)} → ${dateLabel(corrected.facts.records[0].schedule.date!)}`);
  await expect(changeDialog).toContainText(`First cash gap: ${money(saved.plan.firstGap!.amountPaise)} → ₹0.00`);
  await page.keyboard.press('Escape');
  await expect(changeDialog).toBeHidden();
  await expect(changes).toBeFocused();
  await stable(page, picture, 'recent changes dismissed', true);
  const changed = salary.getByRole('button', { name: 'Correct Salary', exact: true });
  await expect(page.getByRole('group', { name: 'Current reported item', exact: true })).toHaveCount(0);
  await changed.click();
  await expect(page.getByRole('dialog', { name: 'Correct Salary', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(changed).toBeFocused();
  await expect(salary).toBeInViewport({ ratio: .99 });
  await stable(page, picture, 'explicit changed-item navigation', true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-corrected.png'), fullPage: true });
  await end.click();
  await ended(page);
  await expect(page.locator('.voice-status')).toHaveText('Conversation ended');
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(await page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(1);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
  expect(await current(page)).toEqual(corrected);
  const figures = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true });
  await expect(figures).toHaveCount(1);
  await expect(figures).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('provider-double-ended.png'), fullPage: true });
  await figures.click();
  await expect(page).toHaveURL(/\/money$/);
  const calculation = page.getByRole('button', { name: 'View calculation', exact: true });
  await calculation.click();
  const details = page.getByRole('dialog', { name: 'Plan details', exact: true });
  await expect(details).toContainText(corrected.plan.decisionAssessment!.outcome!.conditions);
  expect(await details.evaluate(element => element.matches(':modal'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-plan-details.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(calculation).toBeFocused();
  expect(await current(page)).toEqual(corrected);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-money.png'), fullPage: true });
  const exported = await page.request.get('/api/session/export', { maxRedirects: 0 });
  expect(exported.status()).toBe(200);
  const text = await exported.text();
  expect(text).toContain('Salary');
  expect(text).toContain(corrected.facts.records[0].schedule.date!);
  await page.getByRole('button', { name: 'Plan tools', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'Plan tools', exact: true }).getByRole('link', { name: 'Download saved plan', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('cashflow.txt');
  expect(await file.failure()).toBeNull();
  const stream = await file.createReadStream();
  const contents: Buffer[] = [];
  for await (const chunk of stream!) contents.push(Buffer.from(chunk));
  expect(Buffer.concat(contents).toString('utf8')).toBe(text);
});

test('provider double: semantic card corrections animate once without replacing records, stealing focus or scrolling', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    window.cardAnimations = [];
    const animate = Element.prototype.animate;
    /** Record native financial-card animations for identity and motion assertions. */
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.matches('.financial-context article')) window.cardAnimations.push({ element: this, animation });
      return animation;
    };
  });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start talking', exact: true }).click();
  await connected(page);
  const initial = await current(page);
  const saved = await submit(page, initial, { type: 'replaceFacts', facts: {
    opening: { amount: '5000', status: 'exact' }, reserve: '0',
    coverage: { income: 'reviewed', essential: 'none', debt: 'none', optional: 'reviewed' }, records: [
      { id: 'optional', label: 'Optional purchase', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 16), recurrence: 'once', certainty: 'exact' } },
      { id: 'salary', label: 'Salary', kind: 'income', autoDebit: false, reliability: 'reliable',
        amount: { amount: '30000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once', certainty: 'exact' } },
    ],
  } });
  const records = page.locator('.financial-context .fact-row');
  const salary = page.getByRole('listitem', { name: 'Salary', exact: true });
  const correction = salary.getByRole('button', { name: 'Correct Salary', exact: true });
  const details = page.getByRole('region', { name: 'Financial picture details', exact: true });
  await expect(records).toHaveCount(2);
  await expect(salary).toContainText(money(saved.facts.records[1].amount.amountPaise));
  await expect.poll(() => page.evaluate(() => window.cardAnimations.filter(({ element }) => element.getAttribute('aria-label') === 'Expected income').length)).toBe(1);
  await page.evaluate(async () => {
    await Promise.all(window.cardAnimations.map(({ animation }) => animation.finished.catch(() => undefined)));
    window.cardAnimations = [];
  });
  const nodes = await records.elementHandles();
  expect(await records.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
    .toEqual(['Optional purchase', 'Salary']);
  await correction.click();
  await page.keyboard.press('Escape');
  await expect(correction).toBeFocused();
  await expect(salary).toBeInViewport({ ratio: .99 });
  const before = await geometry(page);
  const scrollTop = await details.evaluate(element => element.scrollTop);
  const bounds = (await salary.boundingBox())!;
  const corrected = await submit(page, saved, { type: 'updateFacts', changes: { expectedRevision: saved.revision,
    records: [{ id: 'salary', delete: false, distinct: false, amount: { amount: '35000', status: 'exact' } }] } });
  await expect(salary).toContainText(money(corrected.facts.records[1].amount.amountPaise));
  await expect.poll(() => page.evaluate(() => window.cardAnimations.filter(({ element }) => element.getAttribute('aria-label') === 'Expected income').length)).toBe(1);
  expect(await page.evaluate(() => window.cardAnimations.filter(({ element }) => element.matches('.workspace-income, .workspace-optional, .workspace-cash')).map(({ element, animation }) => ({
    label: element.getAttribute('aria-label'), duration: animation.effect!.getTiming().duration, iterations: animation.effect!.getTiming().iterations,
  })))).toEqual([{ label: 'Expected income', duration: 650, iterations: 1 }]);
  for (let index = 0; index < nodes.length; index++) {
    expect(await nodes[index].evaluate(element => element.isConnected)).toBe(true);
    expect(await records.nth(index).evaluate((element, original) => element === original, nodes[index])).toBe(true);
  }
  await expect(correction).toBeFocused();
  expect(await details.evaluate(element => element.scrollTop), 'A correction must not scroll the financial list').toBe(scrollTop);
  const correctedBounds = (await salary.boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(correctedBounds[key] - bounds[key]), `Corrected card ${key}`).toBeLessThanOrEqual(1);
  await stable(page, before, 'semantic correction preserves the composition');
  await page.evaluate(async () => {
    await Promise.all(window.cardAnimations.map(({ animation }) => animation.finished));
  });
  expect(await page.locator('.financial-context article').evaluateAll(elements => elements.flatMap(element => element.getAnimations()))).toEqual([]);
  expect(await page.locator('.site-header, .conversation, .financial-pane, .financial-context article, .live-caption, .conversation-controls button').evaluateAll(elements => elements.flatMap(element => {
    const style = getComputedStyle(element);
    return style.backgroundImage.includes('gradient(') || style.borderLeftWidth !== style.borderRightWidth
      || style.borderLeftColor !== style.borderRightColor || style.boxShadow.includes('inset') ? [element.className] : [];
  })), 'Financial and voice surfaces have no gradient or left-accent rail').toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('provider-double-stable-card-correction.png'), fullPage: true });
  await page.evaluate(() => { window.cardAnimations = []; });
  const preview = await submit(page, corrected, { type: 'previewAdjustments',
    adjustments: [{ eventId: `optional:${dateAt(initial.anchorDate, 16)}`, amount: '0' }] });
  expect(preview.revision).toBe(corrected.revision);
  expect(preview.sequence).toBeGreaterThan(corrected.sequence);
  expect(preview.facts).toEqual(corrected.facts);
  expect(preview.plan).toEqual(corrected.plan);
  await expect(page.getByRole('region', { name: 'Spending change preview', exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.cardAnimations.filter(({ element }) => element.matches('.workspace-income, .workspace-optional, .workspace-cash')).length), 'A proposal does not animate unchanged reported facts').toBe(0);
  await expect(correction).toBeFocused();
  await page.evaluate(() => { window.cardAnimations = []; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await submit(page, preview, { type: 'updateFacts', changes: { expectedRevision: preview.revision,
    records: [{ id: 'salary', delete: false, distinct: false, amount: { amount: '32000', status: 'exact' } }] } });
  await expect(salary).toContainText(money(reduced.facts.records[1].amount.amountPaise));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.cardAnimations.length), 'Reduced motion suppresses semantic card animation').toBe(0);
  for (let index = 0; index < nodes.length; index++) {
    expect(await records.nth(index).evaluate((element, original) => element === original, nodes[index])).toBe(true);
    await nodes[index].dispose();
  }
  await expect(correction).toBeFocused();
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  expect(await current(page)).toEqual(reduced);
});

test('provider double: accept an exact whole proposal, replace consent and restore removed assumptions over real HTTP/SSE', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  await page.getByRole('button', { name: 'Start talking' }).click();
  const ready = await connected(page);
  const initial = await current(page);
  const facts: FactsInput = { opening: { amount: '5000', status: 'exact' }, reserve: '0',
    coverage: { income: 'reviewed', essential: 'reviewed', debt: 'reviewed', optional: 'reviewed' }, records: [
      { id: 'salary', label: 'Salary', kind: 'income', autoDebit: false, reliability: 'reliable',
        amount: { amount: '30000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 10), recurrence: 'once', certainty: 'exact' } },
      { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false,
        amount: { amount: '12000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 2), recurrence: 'once', certainty: 'exact' } },
      { id: 'card', label: 'Card', kind: 'debt', debtType: 'card', autoDebit: false, controllability: 'controllable',
        amount: { amount: '2000', status: 'exact' }, target: { amount: '4000', status: 'exact' }, outstanding: { amount: '90000', status: 'exact' },
        schedule: { date: dateAt(initial.anchorDate, 15), recurrence: 'once', certainty: 'exact' } },
      { id: 'optional', label: 'Optional purchase', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '2000', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 16), recurrence: 'once', certainty: 'exact' } },
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
  await expect(proposal).toContainText('₹4,000.00 Reported → ₹2,000.00 Proposed');
  await expect(proposal).toContainText('₹2,000.00 Reported → ₹0.00 Proposed');
  await expect(proposal).toContainText('Required minimum ₹2,000.00 · Reported. Not payoff.');
  await expect(proposal.getByRole('region', { name: 'After · preview', exact: true })).toContainText(`₹7,000.00 · ${dateLabel(baseline.plan.firstGap!.date)}`);
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
  await expect(proposal).toContainText('₹2,000.00 Reported → ₹123.45 Proposed');
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
  await expect(proposal).toContainText('Replaces all saved assumptions; changes do not stack.');
  await expect(proposal.getByRole('list', { name: 'Removed assumptions' })).toContainText(
    `Optional purchase · ${dateLabel(dateAt(initial.anchorDate, 16))} · ₹123.45 Saved → ₹2,000.00 Reported`);
  await proposal.getByRole('list', { name: 'Planning assumptions' }).locator('summary').filter({ hasText: 'Terms for this change' }).click();
  await expect(proposal.getByRole('list', { name: 'Planning assumptions' })).toContainText('Consent saved for this occurrence');
  await expect(consent).not.toBeChecked();
  await expect(consent).toHaveAccessibleName(/including removals, unconditionally—not dependent on uncertain income or payee agreement/);
  await consent.check();
  await page.getByRole('button', { name: 'End conversation', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'End conversation', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await stable(page, ready, 'whole replacement proposal and removals', true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-whole-proposal.png'), fullPage: true });
  const confirmed = await actOnPlan(page, 'Accept planning assumptions', removals,
    { type: 'acceptPreview', previewId: removals.preview!.id, confirmed: true, consentScope: 'unconditional' });
  await expect(proposal).toHaveCount(0);
  expect(confirmed.accepted!.adjustments.map(item => item.eventId)).toEqual([adjustments[0].eventId]);
  expect(confirmed.facts).toEqual(baseline.facts);
  expect(confirmed.accepted!.plan.firstGap).toEqual(baseline.plan.firstGap);
  expect(confirmed.accepted!.plan.closingPaise).toBe(1900000);
  await expect(page.getByRole('listitem', { name: 'Card', exact: true })).toContainText('Reported outstanding: ₹90,000.00');
  await expect(page.getByRole('article', { name: 'Cash gap and timing risk', exact: true })).toContainText('₹7,000.00');
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await ended(page);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Money in this plan', exact: true }).locator('.money-metric-closing')).toContainText(money(confirmed.accepted!.plan.closingPaise).replace(/\.00$/, ''));
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
  await page.getByRole('button', { name: 'Start talking' }).click();
  const ready = await connected(page);
  const empty = await current(page);
  await expect(page.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
  const initial = await submit(page, empty, { type: 'updateFacts', changes: { expectedRevision: empty.revision, coverage: { income: 'none' } } });
  expect(initial.plan.decisionAssessment!.nextActionId).toBe('clarify:opening');
  await expect(page.getByRole('article', { name: 'Available opening cash', exact: true })).toContainText('Unknown');
  const deferred = await actOnPlan(page, 'I cannot confirm this now', initial,
    { type: 'respondToAction', actionId: initial.plan.decisionAssessment!.nextActionId!, response: 'unavailable' });
  expect(deferred.plan.decisionAssessment!.nextActionId).toBe('clarify:coverage');
  const question = deferred.plan.decisionAssessment!.uncertainties!.find(item => item.id === deferred.plan.decisionAssessment!.nextQuestionId)!;
  await expect(page.locator('.workspace-questions').getByText(question.question, { exact: true })).toBeVisible();
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
  await stable(page, ready, 'unavailable answers preserve unknown cash', true);
  const questions = page.getByRole('region', { name: 'Other open checks', exact: true });
  for (const item of assessment.uncertainties!) await expect(questions).toContainText(item.question);
  await page.screenshot({ path: testInfo.outputPath('provider-double-unavailable-answers.png'), fullPage: true });
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await ended(page);
  await expect(page.getByRole('article', { name: 'Available opening cash', exact: true })).toContainText('Unknown');
  expect(await current(page)).toEqual(qualified);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
});

test('provider double: close a preview without declining its cut, then explicitly decline and retain the real early gap', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  await page.getByRole('button', { name: 'Start talking' }).click();
  const ready = await connected(page);
  const initial = await current(page);
  const baseline = await submit(page, initial, { type: 'replaceFacts', facts: {
    opening: { amount: '1000', status: 'exact' }, reserve: '0',
    coverage: { income: 'none', essential: 'reviewed', debt: 'none', optional: 'reviewed' }, records: [
      { id: 'purchase', label: 'Purchase', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '800', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once', certainty: 'exact' } },
      { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false,
        amount: { amount: '500', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 3), recurrence: 'once', certainty: 'exact' } },
      { id: 'trip', label: 'Trip', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '100', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 9), recurrence: 'once', certainty: 'exact' } },
    ],
  } });
  const assessment = baseline.plan.decisionAssessment!;
  const action = assessment.actions!.find(item => item.id === assessment.nextActionId)!;
  const choice = assessment.choices!.find(item => item.id === action.choiceId)!;
  expect(action.kind).toBe('previewChange');
  expect(baseline.plan.firstGap).toEqual({ date: dateAt(initial.anchorDate, 3), amountPaise: 30000 });
  const controls = page.locator('.workspace-questions > li').filter({ has: page.getByText(action.question, { exact: true }) });
  const adjustments = choice.adjustmentAmounts.map(item => ({ eventId: item.eventId, amount: decimal(item.amountPaise) }));
  const pending = await submit(page, baseline, { type: 'previewAdjustments', adjustments });
  const proposal = page.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText('Reject saves your refusal of this proposal. Close preview only puts it aside; it is not a refusal.');
  const discarded = await actOnPlan(page, 'Close preview', pending, { type: 'discardPreview', previewId: pending.preview!.id });
  await expect(proposal).toHaveCount(0);
  expect(discarded.facts).toEqual(baseline.facts);
  expect(discarded.facts.decision!.responses).toEqual([]);
  expect(discarded.plan.decisionAssessment!.nextActionId).toBe(action.id);
  await expect(controls.getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
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
  await expect(page.locator('.workspace-questions > li > p').filter({ hasText: next.question })).toHaveText(next.question);
  await expect(page.getByRole('article', { name: 'Cash gap and timing risk', exact: true })).toContainText('₹300.00');
  await expect(page.getByLabel('Saved answers', { exact: true })).toContainText('Declined cuts are not assumed.');
  await expect(controls.getByRole('button', { name: 'Do not suggest this cut' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await stable(page, ready, 'declined cut and unresolved rent gap', true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-declined-cut.png'), fullPage: true });
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await ended(page);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true }).click();
  const step = page.getByRole('button', { name: 'Discuss payment options', exact: true });
  await step.click();
  const steps = page.getByRole('dialog', { name: 'Your next step', exact: true });
  await expect(steps).toContainText('Rent');
  await expect(steps).toContainText(next.question);
  expect(await steps.evaluate(element => element.matches(':modal'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(steps).toBeHidden();
  await expect(step).toBeFocused();
  expect(await current(page)).toEqual(declined);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
});

test('provider-double: overlapping purchase refusal shows visible guidance without mutation over real HTTP/SSE', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  const picture = page.getByRole('region', { name: 'Your financial picture', exact: true });
  await expect(picture.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start talking' }).click();
  const ready = await connected(page);
  await expect(picture.getByText(/Your session is saved|Your answer is saved/)).toHaveCount(0);
  const initial = await current(page);
  const baseline = await submit(page, initial, { type: 'replaceFacts', facts: {
    opening: { amount: '1000', status: 'exact' }, reserve: '0',
    coverage: { income: 'none', essential: 'reviewed', debt: 'none', optional: 'reviewed' }, records: [
      { id: 'purchase', label: 'Purchase', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '800', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 1), recurrence: 'once', certainty: 'exact' } },
      { id: 'rent', label: 'Rent', kind: 'essential', autoDebit: false,
        amount: { amount: '500', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 3), recurrence: 'once', certainty: 'exact' } },
      { id: 'trip', label: 'Trip', kind: 'optional', autoDebit: false, controllability: 'controllable',
        amount: { amount: '100', status: 'exact' }, schedule: { date: dateAt(initial.anchorDate, 9), recurrence: 'once', certainty: 'exact' } },
    ],
  } });
  const assessment = baseline.plan.decisionAssessment!;
  const action = assessment.actions!.find(item => item.id === assessment.nextActionId)!;
  const choice = assessment.choices!.find(item => item.id === action.choiceId)!;
  expect(action.kind).toBe('previewChange');
  expect(choice.kind).toBe('reduceOptional');
  expect(choice.adjustmentAmounts).toEqual([{ eventId: `purchase:${dateAt(initial.anchorDate, 1)}`, amountPaise: 0 }]);
  expect(baseline.plan.firstGap).toEqual({ date: dateAt(initial.anchorDate, 3), amountPaise: 30000 });
  const controls = picture.locator('.workspace-questions > li').filter({ has: page.getByText(action.question, { exact: true }) });
  const pending = await submit(page, baseline, { type: 'previewAdjustments',
    adjustments: [{ eventId: choice.adjustmentAmounts[0].eventId, amount: '500' }] });
  expect(pending.facts).toEqual(baseline.facts);
  expect(pending.plan).toEqual(baseline.plan);
  expect(pending.accepted).toBeNull();
  const proposal = picture.getByRole('region', { name: 'Spending change preview', exact: true });
  await expect(proposal).toContainText('₹800.00 Reported → ₹500.00 Proposed');
  await expect(controls.locator(':scope > p').filter({ hasText: action.question })).toHaveText(action.question);
  await expect(proposal.getByRole('checkbox')).not.toBeChecked();
  const commands: Command[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/session/commands' && request.method() === 'POST') commands.push(request.postDataJSON() as Command);
  });
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/commands' && response.request().method() === 'POST');
  await controls.getByRole('button', { name: 'Do not suggest this cut' }).click();
  const conflict = await response;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'stalePreview', snapshot: pending });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({ commandId: expect.any(String), expectedRevision: pending.revision,
    operation: { type: 'respondToAction', actionId: action.id, response: 'declined' } });
  const feedback = page.getByRole('complementary', { name: 'Notifications' }).getByRole('alert', { name: 'Action needs attention' });
  await expect(feedback).toContainText('Your answer was not saved because the open proposal differs from this suggested cut. Review the proposal or choose “Reject preview” before answering again.');
  await expect(picture.getByRole('alert')).toHaveCount(0);
  await expect(feedback.getByRole('button', { name: 'Review Money', exact: true })).toBeDisabled();
  // Mobile device scale can clip a fractional pixel at the panel border.
  await expect(feedback).toBeInViewport({ ratio: 0.99 });
  const feedbackBounds = await feedback.boundingBox();
  expect(feedbackBounds).not.toBeNull();
  expect(feedbackBounds!.y).toBeGreaterThanOrEqual(-1);
  expect(feedbackBounds!.y + feedbackBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await expect(feedback).not.toHaveClass(/sr-only/);
  await expect(page.getByText(/no longer available to accept|Pending proposal differs from this choice/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry same action' })).toHaveCount(0);
  await expect(controls.getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
  await expect(proposal.getByRole('button', { name: 'Reject preview' })).toBeEnabled();
  await expect(proposal.getByRole('checkbox')).not.toBeChecked();
  await expect(proposal.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
  await expect(picture.getByLabel('Saved answers', { exact: true })).toHaveCount(0);
  await expect(picture.getByRole('article', { name: 'Available opening cash', exact: true })).toContainText('₹1,000.00');
  await expect(picture.getByRole('listitem', { name: 'Purchase', exact: true })).toContainText('₹800.00');
  await expect(picture.getByRole('article', { name: 'Cash gap and timing risk', exact: true })).toContainText('₹300.00');
  expect(await current(page)).toEqual(pending);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  await stable(page, ready, 'global overlapping refusal feedback without financial reflow', true);
  await page.screenshot({ path: testInfo.outputPath('provider-double-overlap-conflict.png'), fullPage: true });
  await page.getByRole('button', { name: 'Minimize notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Review proposed change', exact: true }).click();
  await expect(proposal.getByRole('heading', { name: 'Spending change preview', exact: true })).toBeFocused();
  expect(await current(page)).toEqual(pending);
  const discarded = await actOnPlan(page, 'Close preview', pending, { type: 'discardPreview', previewId: pending.preview!.id });
  await expect(proposal).toHaveCount(0);
  await expect(feedback).toHaveCount(0);
  expect(discarded.facts).toEqual(baseline.facts);
  expect(discarded.facts.decision!.responses).toEqual([]);
  expect(discarded.plan).toEqual(baseline.plan);
  expect(discarded.accepted).toEqual(pending.accepted);
  expect(discarded.revision).toBe(pending.revision);
  expect(discarded.preview).toBeNull();
  expect(discarded.plan.decisionAssessment!.nextActionId).toBe(action.id);
  await expect(controls.getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
  await expect(picture.getByLabel('Saved answers', { exact: true })).toHaveCount(0);
  await expect(picture.getByText(/Preview rejected|Your answer is saved/)).toHaveCount(0);
  expect(commands.map(command => command.operation)).toEqual([
    { type: 'respondToAction', actionId: action.id, response: 'declined' },
    { type: 'discardPreview', previewId: pending.preview!.id },
  ]);
  expect(commands[1].commandId).not.toBe(commands[0].commandId);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await ended(page);
  expect(await current(page)).toEqual(discarded);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
});

test('provider double: three recovery notices stay actionable in Privacy and Recent changes without moving the plan', async ({ page }) => {
  await page.goto('/app');
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start talking', exact: true }).click();
  const before = await connected(page);
  const initial = await current(page);
  const saved = await submit(page, initial, { type: 'replaceFacts', facts: { ...draftFacts(initial), opening: { amount: '123.45', status: 'exact' } } });
  const corrected = await submit(page, saved, { type: 'replaceFacts', facts: { ...draftFacts(saved), opening: { amount: '678.90', status: 'exact' } } });
  await expect(page.getByRole('article', { name: 'Available opening cash', exact: true })).toContainText('₹678.90');
  await expect(page.getByRole('button', { name: 'Recent changes', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const client = window.voiceFixture.clients[0];
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', name: 'Assistant', local: false });
    client.callbacks.onBotStartedSpeaking!();
  });
  await expect(page.locator('.voice-status')).toHaveText('Speaking');
  const bodies: string[] = [];
  await page.route('**/api/session/commands', async route => {
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) {
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBe(200);
      await route.abort('connectionreset');
    } else await route.fallback();
  });
  await page.getByRole('button', { name: 'I cannot confirm this now', exact: true }).click();
  const notifications = page.getByRole('complementary', { name: 'Notifications' });
  const pending = notifications.getByRole('alert', { name: 'Save not confirmed', exact: true });
  await expect(pending).toHaveAttribute('data-severity', 'critical');
  await expect(pending.getByRole('button', { name: 'Dismiss Save not confirmed' })).toHaveCount(0);
  await expect(pending.getByRole('button', { name: 'Retry same action', exact: true })).toBeEnabled();
  const committed = await current(page);
  expect(committed.revision).toBe(corrected.revision + 1);
  await page.locator('audio').evaluate(element => (element as HTMLAudioElement).pause());
  await expect(notifications.getByRole('status', { name: 'Assistant audio paused' })).toBeVisible();
  await page.getByRole('button', { name: 'Profile menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(notifications.getByRole('status', { name: 'A conversation is open' })).toBeVisible();
  await expect(notifications.locator('.toast')).toHaveCount(3);
  await expect(notifications.locator('.toast').first()).toHaveAccessibleName('Save not confirmed');
  await stable(page, before, 'three notices do not reflow the main journey', true);
  for (const title of ['Privacy', 'Recent changes']) {
    await notifications.getByRole('button', { name: 'Minimize notifications', exact: true }).click();
    await (title === 'Privacy' ? page.locator('.site-footer') : page).getByRole('button', { name: title, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await modal(page, dialog, title, before);
    await dialog.getByRole('button', { name: /^Important notifications \(3\)$/ }).click();
    await expect(dialog.getByRole('complementary', { name: 'Notifications' })).toHaveCount(1);
    await toastPlacement(page);
    const retry = pending.getByRole('button', { name: 'Retry same action', exact: true });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport({ ratio: .99 });
    await retry.click({ trial: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(notifications.locator('.toast')).toHaveCount(3);
    await stable(page, before, `${title} preserves recovery and layout`, true);
  }
  await pending.getByRole('button', { name: 'Retry same action', exact: true }).click();
  await expect(pending).toHaveCount(0);
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(await current(page)).toEqual(committed);
  await notifications.getByRole('button', { name: 'Resume audio', exact: true }).click();
  await expect(page.locator('.voice-status')).toHaveText('Speaking');
  await notifications.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(notifications).toBeHidden();
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
});

test('provider double: previous-call information auto-dismisses without starting capture or leaving inline warnings', async ({ page, voice }, info) => {
  test.skip(info.project.name !== 'desktop', 'One real-duration dismissal check; recovery layouts run on all device projects.');
  const response = await page.request.post('/api/session', { data: {}, maxRedirects: 0 });
  expect(response.status()).toBe(200);
  await page.route('**/api/session/call', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { callId: null, status: 'error', cleanupConfirmed: true, message: 'private previous-call diagnostic' } satisfies CallState });
    else await route.fallback();
  });
  await page.goto('/app');
  const notice = page.getByRole('complementary', { name: 'Notifications' }).getByRole('status', { name: 'Previous conversation stopped' });
  await expect(notice).toBeVisible();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(page.locator('.voice-status')).toHaveText('Ready when you are');
  const before = await geometry(page);
  await expect(page.locator('main')).not.toContainText('The previous conversation stopped with an error.');
  await expect(page.locator('body')).not.toContainText('private previous-call diagnostic');
  await expect(notice.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await page.mouse.move(0, 0);
  await page.getByRole('heading', { level: 1 }).focus();
  await expect(notice).toHaveCount(0, { timeout: 10000 });
  await stable(page, before, 'informational toast dismissal');
  expect(await page.evaluate(() => window.voiceFixture.clients.length)).toBe(0);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Start talking', exact: true })).toBeEnabled();
});

test('provider double: official WebGL Orb renders five states, owned audio uniforms and a frozen reduced-motion canvas', async ({ page, voice }, info) => {
  await page.addInitScript(() => {
    window.orbProbe = new WeakMap();
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    const pixel = new Uint8Array(4);
    /** Capture rendered orb frames and audio uniforms for visual-state assertions. */
    WebGL2RenderingContext.prototype.drawArrays = function (mode, first, count) {
      draw.call(this, mode, first, count);
      const canvas = this.canvas;
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.matches('canvas.aui-voice-orb')) return;
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram | null;
      if (!program) return;
      // Read the native draw before the browser discards the non-preserved framebuffer.
      this.readPixels(Math.floor(this.drawingBufferWidth / 2), Math.floor(this.drawingBufferHeight / 2),
        1, 1, this.RGBA, this.UNSIGNED_BYTE, pixel);
      window.orbProbe.set(canvas, {
        frames: (window.orbProbe.get(canvas)?.frames ?? 0) + 1,
        state: canvas.getAttribute('data-state'), volume: Number(canvas.parentElement!.getAttribute('data-volume')),
        time: this.getUniform(program, this.getUniformLocation(program, 'u_time')!) as number,
        speed: this.getUniform(program, this.getUniformLocation(program, 'u_speed')!) as number,
        amplitude: this.getUniform(program, this.getUniformLocation(program, 'u_amplitude')!) as number,
        pixel: Array.from(pixel),
      });
    };
  });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  const orb = page.locator('.call-orb');
  const canvas = orb.locator('canvas.aui-voice-orb');
  await expect(canvas).toHaveCount(1);
  const node = await canvas.elementHandle();

  /** Verify the existing orb canvas visibly renders the requested voice state. */
  async function rendered(state: 'idle' | 'connecting' | 'listening' | 'speaking' | 'muted') {
    await expect(canvas).toHaveAttribute('data-state', state);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
      const frame = window.orbProbe.get(element);
      return { state: frame?.state, drawn: !!frame && frame.frames > 0 && frame.pixel.every(channel => channel > 0) };
    })).toEqual({ state, drawn: true });
    expect(await canvas.evaluate((element, original) => element === original, node)).toBe(true);
    await expect(orb.locator('svg')).toHaveCount(0);
    // CSS must not add perpetual motion on top of the native WebGL renderer.
    expect(await orb.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations === Infinity).length)).toBe(0);
    return (await canvas.evaluate((element: HTMLCanvasElement) => window.orbProbe.get(element)))!;
  }

  /** Wait for the orb's animated parameters to reach their expected targets. */
  async function settled(speed: number, amplitude: number) {
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => window.orbProbe.get(element)?.speed), { timeout: 10000 }).toBeCloseTo(speed, 2);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => window.orbProbe.get(element)?.amplitude), { timeout: 10000 }).toBeCloseTo(amplitude, 2);
  }

  /** Emit an audio-level sample and verify the orb renders its expected volume. */
  async function sample(source: 'local' | 'remote', value: number, expected = value, participant = 'assistant') {
    let frame: Awaited<ReturnType<typeof rendered>> | undefined;
    await expect.poll(async () => {
      frame = await canvas.evaluate(async (element: HTMLCanvasElement, { source, value, participant }) => {
        const frames = window.orbProbe.get(element)?.frames ?? 0;
        const callbacks = window.voiceFixture.clients[0].callbacks;
        if (source === 'local') callbacks.onLocalAudioLevel!(value);
        else callbacks.onRemoteAudioLevel!(value, { id: participant, name: 'Synthetic participant', local: false });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const frame = window.orbProbe.get(element);
        return frame && frame.frames > frames ? frame : undefined;
      }, { source, value, participant });
      return frame?.volume;
    }).toBe(expected);
    return frame!;
  }

  await expect(orb).toHaveAttribute('data-state', 'idle');
  await expect(orb).toHaveAttribute('data-volume', '0');
  await expect(orb).toHaveAttribute('role', 'img');
  await expect(orb).toHaveAccessibleName('Ready when you are');
  await rendered('idle');
  await settled(.15, .04);
  const renderer = await readFile(new URL('../../src/components/assistant-ui/elements/voice.tsx', import.meta.url), 'utf8');
  const shaders = [...renderer.matchAll(/const (?:VERT|FRAG)_SRC = `([\s\S]*?)`;/g)].map(match => match[1]);
  expect(shaders).toHaveLength(2);
  const native = await canvas.evaluate((element: HTMLCanvasElement) => {
    const gl = element.getContext('webgl2')!;
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    return { linked: gl.getProgramParameter(program, gl.LINK_STATUS) as boolean,
      shaders: gl.getAttachedShaders(program)!.map(shader => ({ source: gl.getShaderSource(shader), compiled: gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean })),
      colors: ['u_color0', 'u_color1', 'u_color2'].map(name => Array.from(gl.getUniform(program, gl.getUniformLocation(program, name)!) as Float32Array)),
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
      expectedWidth: Math.round(element.getBoundingClientRect().width * devicePixelRatio),
      expectedHeight: Math.round(element.getBoundingClientRect().height * devicePixelRatio) };
  });
  expect(native.linked).toBe(true);
  expect(native.shaders).toHaveLength(2);
  expect(native.shaders.every(shader => shader.compiled)).toBe(true);
  expect(native.shaders.map(shader => shader.source)).toEqual(expect.arrayContaining(shaders));
  for (const [index, color] of [[.15, .75, .55], [.3, .9, .7], [.1, .55, .4]].entries())
    for (const [channel, value] of color.entries()) expect(native.colors[index][channel]).toBeCloseTo(value, 6);
  expect(native.width).toBe(native.expectedWidth);
  expect(native.height).toBe(native.expectedHeight);
  await expect(page.locator('.voice-emblem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect microphone', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({ clients: window.voiceFixture.clients.length, tracks: window.voiceFixture.tracks.length }))).toEqual({ clients: 0, tracks: 0 });
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(0);
  expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
  await page.screenshot({ path: info.outputPath('provider-double-orb-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start talking', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
  await rendered('connecting');
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  expect((await sample('local', .6, 0)).volume).toBe(0);
  await page.screenshot({ path: info.outputPath('provider-double-orb-connecting.png'), fullPage: true });
  const before = await connected(page);
  const snapshot = await current(page);
  await rendered('listening');
  await settled(.4, .14);
  expect((await sample('local', .6, 0)).volume).toBe(0);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserStartedSpeaking!());
  await expect(orb).toHaveAttribute('data-state', 'userSpeaking');
  await rendered('listening');
  const spoken = await sample('local', .6);
  expect(spoken.volume).toBeCloseTo(.6);
  expect(spoken.amplitude).toBeCloseTo(.14 + .6 * .12, 2);
  expect(spoken.speed).toBeCloseTo(.4 + .6 * .4, 2);
  await stable(page, before, 'local audio metering');
  await page.screenshot({ path: info.outputPath('provider-double-orb-live.png'), fullPage: true });
  const silent = await sample('local', 0);
  expect(silent.amplitude).toBeLessThan(spoken.amplitude);
  expect(silent.speed).toBeLessThan(spoken.speed);
  expect((await sample('local', .6)).volume).toBeCloseTo(.6);
  await expect.poll(() => orb.getAttribute('data-volume'), { timeout: 2000 }).toBe('0');
  await settled(.4, .14);
  await expect(page.locator('.voice-status')).toHaveText('Listening to you');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserStartedSpeaking!());
  await expect(orb).toHaveAttribute('data-state', 'muted');
  await rendered('muted');
  expect((await sample('local', .6, 0)).volume).toBe(0);
  await settled(.06, .015);
  await page.screenshot({ path: info.outputPath('provider-double-orb-muted.png'), fullPage: true });
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onUserStoppedSpeaking!(); callbacks.onBotStartedSpeaking!();
  });
  await expect(page.locator('.voice-status')).toHaveText('Assistant audio unavailable');
  await rendered('idle');
  expect((await sample('remote', .6, 0)).volume).toBe(0);
  expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).srcObject)).toBeNull();
  await page.evaluate(() => {
    const client = window.voiceFixture.clients[0];
    client.callbacks.onBotConnected!({ id: 'assistant', name: 'Assistant', local: false });
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', name: 'Assistant', local: false });
  });
  await expect.poll(() => page.locator('audio').evaluate(element => {
    const player = element as HTMLAudioElement;
    return !player.paused && player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && (player.srcObject as MediaStream | null)?.getAudioTracks()[0]?.readyState === 'live';
  })).toBe(true);
  await expect(orb).toHaveAttribute('data-state', 'assistantSpeaking');
  await rendered('speaking');
  await settled(1.4, .35);
  expect((await sample('remote', .6, 0, 'unattached-participant')).volume).toBe(0);
  expect((await sample('local', .6, 0)).volume).toBe(0);
  const assistant = await sample('remote', .6);
  expect(assistant.volume).toBeCloseTo(.6);
  expect(assistant.amplitude).toBeCloseTo(.35 + .6 * .12, 2);
  expect(assistant.speed).toBeCloseTo(1.4 + .6 * .4, 2);
  await expect.poll(() => orb.getAttribute('data-volume'), { timeout: 2000 }).toBe('0');
  await settled(1.4, .35);
  await expect(page.locator('.voice-status')).toHaveText('Speaking');
  await stable(page, before, 'audible assistant metering');
  await page.screenshot({ path: info.outputPath('provider-double-orb-assistant.png'), fullPage: true });
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.locator('.voice-status')).toHaveText('Speaking');
  await expect(orb).toHaveAccessibleName('Speaking');
  await rendered('muted');
  expect((await sample('remote', .6, 0)).volume).toBe(0);
  expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await rendered('speaking');
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserStartedSpeaking!());
  await expect(orb).toHaveAttribute('data-state', 'interrupted');
  await rendered('listening');
  expect((await sample('remote', .6, 0)).volume).toBe(0);
  expect((await sample('local', .6)).volume).toBeCloseTo(.6);
  await expect.poll(() => orb.getAttribute('data-volume'), { timeout: 2000 }).toBe('0');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => window.orbProbe.get(element)?.time)).toBe(0);
  const frozen = await rendered('listening');
  const duringSpeech = await canvas.evaluate(async (element: HTMLCanvasElement) => {
    window.voiceFixture.clients[0].callbacks.onLocalAudioLevel!(.6);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.orbProbe.get(element);
  });
  expect(duringSpeech).toEqual(frozen);
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onBotStoppedSpeaking!(); callbacks.onUserStoppedSpeaking!(); callbacks.onBotLlmStarted!();
  });
  await expect(orb).toHaveAttribute('data-state', 'processing');
  await rendered('listening');
  await expect(orb).toHaveAttribute('data-volume', '0');
  await expect(canvas).toBeVisible();
  // Reduced motion freezes the official shader instead of substituting a renderer.
  await expect(canvas).toHaveCSS('transform', 'none');
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'End conversation', exact: true })).toBeInViewport({ ratio: 1 });
  await stable(page, before, 'reduced-motion thinking');
  await page.screenshot({ path: info.outputPath('provider-double-orb-reduced-motion.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => window.orbProbe.get(element)?.time)).toBeGreaterThan(0);
  await stable(page, before, 'native processing renderer preserves compact geometry');
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotLlmStopped!());
  await expect(orb).toHaveAttribute('data-state', 'listening');
  await rendered('listening');
  expect(await current(page)).toEqual(snapshot);
  await node!.dispose();
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await ended(page);
  expect(await current(page)).toEqual(snapshot);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(1);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(1);
});

test('provider double: paused capture keeps the Orb muted during audible assistant speech', async ({ page }) => {
  await page.goto('/app');
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start talking', exact: true }).click();
  const before = await connected(page);
  const snapshot = await current(page);
  await page.evaluate(() => {
    const client = window.voiceFixture.clients[0];
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', name: 'Assistant', local: false });
    client.callbacks.onBotStartedSpeaking!();
  });
  const canvas = page.locator('canvas.aui-voice-orb');
  await expect(canvas).toHaveAttribute('data-state', 'speaking');
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onUserMuteStarted!();
    callbacks.onRemoteAudioLevel!(.6, { id: 'assistant', name: 'Assistant', local: false });
  });
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
  await expect(canvas).toHaveAttribute('data-state', 'muted');
  await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserMuteStopped!());
  await expect(canvas).toHaveAttribute('data-state', 'speaking');
  await stable(page, before, 'paused capture during assistant speech');
  expect(await current(page)).toEqual(snapshot);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
});

test('provider double: live caption times survive partial speech and financial SSE without entering saved History', async ({ page }) => {
  await page.route('**/api/settings', async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const settings = await response.json() as Settings;
    await route.fulfill({ response, json: { ...settings, timezone: 'Asia/Kolkata', voiceAvailable: true, voiceUnavailableReason: null } satisfies Settings });
  });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start talking', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onConnected!(); callbacks.onBotReady!({ version: '2.1.0' });
  });
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  const live = page.getByRole('region', { name: 'Live caption', exact: true });
  const savedHistory = page.getByRole('region', { name: 'History', exact: true });
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    for (const [text, timestamp] of [['Later reported figure', '2026-09-11T04:00:02.000Z'], ['Earlier reported figure', '2026-09-11T04:00:01.000Z'], ['Current reported figure', '2026-09-11T04:00:03.000Z']])
      callbacks.onUserTranscript!({ text, timestamp, final: true, user_id: 'fixture-user' });
  });
  await expect(live.locator('time')).toHaveAttribute('datetime', '2026-09-11T04:00:03.000Z');
  await expect(live.locator('time')).toHaveText('09:30:03');
  await expect(live.locator('time')).toHaveAttribute('title', /Asia\/Kolkata/);
  await expect(live).toContainText('Current reported figure');
  await expect(savedHistory).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
  await expect(savedHistory.getByRole('navigation', { name: 'Saved conversations', exact: true })).toHaveText('No conversations yet.');
  await expect(savedHistory).not.toContainText(/Earlier reported figure|Later reported figure|Current reported figure/);
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  await savedHistory.getByRole('link', { name: 'Return to call', exact: true }).last().click();
  await expect(live).toContainText('Current reported figure');
  await expect(live.locator('time')).toHaveAttribute('datetime', '2026-09-11T04:00:03.000Z');
  const observed = await page.evaluate(() => {
    const before = Date.now();
    window.voiceFixture.clients[0].callbacks.onBotOutput!({ text: 'Synthetic assistant words', segment_id: 90, will_be_spoken: true,
      spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Synthetic', remaining_text: ' assistant words' } });
    return { before, after: Date.now() };
  });
  await expect(live).toContainText('Synthetic');
  const time = (await live.locator('time').getAttribute('datetime'))!;
  expect(Date.parse(time)).toBeGreaterThanOrEqual(observed.before);
  expect(Date.parse(time)).toBeLessThanOrEqual(observed.after);
  await expect(live.locator('time')).toHaveText(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(time)));
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotOutput!({ text: 'Synthetic assistant words', segment_id: 90, will_be_spoken: true,
    spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Synthetic assistant', remaining_text: ' words' } }));
  await expect(live).toContainText('Synthetic assistant');
  await expect(live.locator('time')).toHaveAttribute('datetime', time);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onBotOutput!({ text: 'Synthetic assistant words', segment_id: 90, will_be_spoken: true, spoken_status: 'completed' }));
  await expect(live.locator('time')).toHaveAttribute('datetime', time);
  await expect(live.getByText('Synthetic assistant words', { exact: true })).toBeVisible();
  await expect(savedHistory).toHaveCount(0);
  const initial = await current(page);
  const saved = await submit(page, initial, { type: 'replaceFacts', facts: { ...draftFacts(initial), opening: { amount: '123.45', status: 'exact' } } });
  await expect(page.getByRole('article', { name: saved.workspace!.cards!.find(card => card.template === 'cash')!.title, exact: true })).toContainText(money(saved.facts.opening.amountPaise));
  // Financial cards can grow the mobile page; caption-only updates must not.
  const before = await geometry(page);
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserTranscript!({ text: `Current long caption: ${'Synthetic words with readable wrapping. '.repeat(60)}`,
    timestamp: '2026-09-11T04:00:04.000Z', final: true, user_id: 'fixture-user' }));
  await expect(live).toContainText('Current long caption:');
  expect(await live.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight >= 56)).toBe(true);
  await live.focus();
  await page.keyboard.press('End');
  await expect.poll(() => live.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await stable(page, before, 'long live caption after visiting saved History');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
  await expect(savedHistory.getByRole('navigation', { name: 'Saved conversations', exact: true })).toHaveText('No conversations yet.');
  await expect(savedHistory).not.toContainText(/Earlier reported figure|Later reported figure|Current reported figure|Synthetic assistant words|Current long caption:|Synthetic words with readable wrapping/);
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  await savedHistory.getByRole('link', { name: 'Return to call', exact: true }).last().click();
  await expect(live).toContainText('Current long caption:');
  await expect(live.locator('time')).toHaveAttribute('datetime', '2026-09-11T04:00:04.000Z');
  await stable(page, before, 'history return retains live caption and financial picture');
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await ended(page);
  expect(await current(page)).toEqual(saved);
});

test('provider double: live capture, interruption, bounded captions, disconnection and clean retry', async ({ page, voice }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  await expect(page.locator('.voice-status')).toHaveText('Ready when you are');
  await page.getByRole('button', { name: 'Start talking' }).click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients[0]?.connections.length ?? 0)).toBe(1);
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onConnected!(); callbacks.onBotReady!({ version: '2.1.0' });
  });
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  const ready = await geometry(page);
  const snapshot = await current(page);
  const events = () => page.locator('.voice-status');
  await page.evaluate(() => {
    const track = window.voiceFixture.clients[0].tracks().local.audio!;
    track.enabled = false; track.dispatchEvent(new Event('mute'));
  });
  await expect(events()).toHaveText('Microphone not connected');
  await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
  await stable(page, ready, 'capture stopped');
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserStartedSpeaking!());
  await expect(events()).not.toContainText(/Listening|listening/);
  await page.evaluate(() => {
    const track = window.voiceFixture.clients[0].tracks().local.audio!;
    track.enabled = true; track.dispatchEvent(new Event('unmute'));
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
  await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'muted');
  await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
  await stable(page, ready, 'listening paused');
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onUserMuteStopped!();
    callbacks.onBotLlmStarted!();
  });
  await expect(events()).toHaveText('Thinking');
  await stable(page, ready, 'generating');
  await page.evaluate(() => {
    const client = window.voiceFixture.clients[0];
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', name: 'Assistant', local: false });
    const callbacks = client.callbacks;
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
  const live = page.getByRole('region', { name: 'Live caption', exact: true });
  const captionBounds = (await live.boundingBox())!;
  const parentBounds = (await page.locator('.conversation').boundingBox())!;
  const end = page.getByRole('button', { name: 'End conversation', exact: true });
  await end.focus();
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    for (let index = 0; index < 29; index++) callbacks.onUserTranscript!({ text: `Synthetic caption ${index}: ${'these are fabricated test words, not a recording. '.repeat(6)}`, final: true, timestamp: new Date(Date.UTC(2026, 8, 11, 4, 0, index)).toISOString(), user_id: 'fixture-user' });
    callbacks.onUserTranscript!({ text: 'Synthetic partial words', final: false, timestamp: '2026-09-11T04:01:00.000Z', user_id: 'fixture-user' });
    callbacks.onBotOutput!({ text: 'Synthetic generated but unspoken text', will_be_spoken: false, spoken_status: 'completed' });
  });
  const savedHistory = page.getByRole('region', { name: 'History', exact: true });
  const saved = savedHistory.getByRole('navigation', { name: 'Saved conversations', exact: true });
  await expect(savedHistory).toHaveCount(0);
  await expect(live).toContainText('Synthetic partial words');
  await expect(end).toBeFocused();
  await stable(page, ready, '29 growing captions and interim words');
  const grown = (await live.boundingBox())!;
  const parent = (await page.locator('.conversation').boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(grown[key] - captionBounds[key]), `Live caption ${key}`).toBeLessThanOrEqual(1);
    expect(Math.abs(parent[key] - parentBounds[key]), `Conversation ${key}`).toBeLessThanOrEqual(1);
  }
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeFocused();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(saved).toHaveAttribute('aria-busy', 'false');
  await expect(saved).toHaveText('No conversations yet.');
  await expect(saved.getByRole('link')).toHaveCount(0);
  await expect(savedHistory).not.toContainText(/Synthetic spoken prefix\.|Unspoken tail\.|Synthetic caption|these are fabricated test words|Synthetic partial words|Synthetic generated but unspoken text/);
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic generated but unspoken text', { exact: true })).toHaveCount(0);
  const search = savedHistory.getByRole('searchbox', { name: 'Search conversations', exact: true });
  await search.focus();
  await page.evaluate(() => window.voiceFixture.clients[0].callbacks.onUserTranscript!({
    text: 'Synthetic caption while reading history', final: true, timestamp: '2026-09-11T04:02:00.000Z', user_id: 'fixture-user',
  }));
  await expect(saved).toHaveAttribute('aria-busy', 'false');
  await expect(saved).toHaveText('No conversations yet.');
  await expect(savedHistory).not.toContainText(/Synthetic spoken prefix\.|Unspoken tail\.|Synthetic caption|these are fabricated test words|Synthetic partial words|Synthetic generated but unspoken text/);
  await expect(search).toBeFocused();
  await savedHistory.getByRole('link', { name: 'Return to call', exact: true }).last().click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(live).toContainText('Synthetic caption while reading history');
  await expect(live.locator('time')).toHaveAttribute('datetime', '2026-09-11T04:02:00.000Z');
  await expect(savedHistory).toHaveCount(0);
  await expect(events()).toHaveText('Listening');
  expect(await page.evaluate(() => ({ clients: window.voiceFixture.clients.length,
    connections: window.voiceFixture.clients[0].connections.length, disconnects: window.voiceFixture.clients[0].disconnects,
    live: window.voiceFixture.tracks.every(track => track.readyState === 'live'), playing: !document.querySelector('audio')!.paused })))
    .toEqual({ clients: 1, connections: 1, disconnects: 0, live: true, playing: true });
  await stable(page, ready, 'reading history and returning to the live call');
  const privacy = page.locator('.site-footer').getByRole('button', { name: 'Privacy', exact: true });
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
  await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
  await expect(page.getByRole('alert', { name: 'Connection lost', exact: true })).toContainText('Check your internet connection, then reconnect.');
  await stable(page, ready, 'disconnected');
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(await page.evaluate(() => window.voiceFixture.clients[0].disconnects)).toBe(1);
  await page.evaluate(() => { window.voiceFixture.connectError = true; });
  await page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect' }).click();
  await expect(events()).toHaveText('Unable to connect');
  await expect(page.locator('canvas.aui-voice-orb')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.call-orb')).toHaveAttribute('data-volume', '0');
  await expect(page.getByRole('alert')).toContainText('Check your connection and microphone');
  await stable(page, ready, 'connection failed');
  await expect(live).toContainText('Captions appear here');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(saved).toHaveText('No conversations yet.');
  await expect(savedHistory).not.toContainText(/Synthetic spoken prefix\.|Unspoken tail\.|Synthetic caption|these are fabricated test words|Synthetic partial words|Synthetic generated but unspoken text/);
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Minimize notifications', exact: true }).click();
  await savedHistory.getByRole('link', { name: 'Talk to Isha', exact: true }).last().click();
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(await page.evaluate(() => window.voiceFixture.clients[1].disconnects)).toBe(1);
  await page.evaluate(() => { window.voiceFixture.connectError = false; });
  await page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect' }).click();
  await expect.poll(() => page.evaluate(() => window.voiceFixture.clients.reduce((count, client) => count + client.connections.length, 0))).toBe(3);
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients.at(-1)!.callbacks;
    callbacks.onConnected!(); callbacks.onBotReady!({ version: '2.1.0' });
  });
  await expect(page.locator('.voice-status')).toHaveText('Listening');
  // A disposed client's late events must not resurrect its captions or connection state.
  await page.evaluate(() => {
    const callbacks = window.voiceFixture.clients[0].callbacks;
    callbacks.onBotReady!({ version: '2.1.0' });
    callbacks.onUserTranscript!({ text: 'Stale synthetic caption', final: true, timestamp: '2026-09-11T04:03:00.000Z', user_id: 'fixture-user' });
    callbacks.onDisconnected!();
  });
  await expect(events()).toHaveText('Listening');
  await expect(page.getByText('Stale synthetic caption', { exact: true })).toHaveCount(0);
  await stable(page, ready, 'retry ignores disposed client events');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true }).click();
  await expect(saved).toHaveText('No conversations yet.');
  await expect(savedHistory).not.toContainText(/Stale synthetic caption|Synthetic spoken prefix\.|Unspoken tail\.|Synthetic caption|these are fabricated test words|Synthetic partial words|Synthetic generated but unspoken text/);
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  await savedHistory.getByRole('link', { name: 'Return to call', exact: true }).last().click();
  await expect(events()).toHaveText('Listening');
  await expect(live).toContainText('Captions appear here');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.evaluate(() => {
    const client = window.voiceFixture.clients[2];
    client.emitTrack(client.tracks().local.audio!.clone(), { id: 'assistant', name: 'Assistant', local: false });
    const callbacks = client.callbacks;
    callbacks.onUserTranscript!({ text: `Synthetic enlarged-text caption: ${'These are test words for readable wrapping. '.repeat(12)}`, final: true, timestamp: '2026-09-11T04:04:00.000Z', user_id: 'fixture-user' });
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
  await ended(page);
  await expect(page.locator('.voice-status')).toHaveText('Conversation ended');
  const reconnect = page.locator('.conversation-controls').getByRole('button', { name: 'Reconnect', exact: true });
  await expect(reconnect).toBeEnabled();
  await reconnect.scrollIntoViewIfNeeded();
  await expect(reconnect).toBeInViewport({ ratio: 0.99 });
  expect(await current(page)).toEqual(snapshot);
  expect(await page.evaluate(() => window.voiceFixture.clients.map(client => client.disconnects))).toEqual([1, 1, 1]);
  expect(await page.evaluate(() => window.voiceFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.voiceFixture.destroyed)).toBe(0);
  expect(voice.calls.filter(method => method === 'POST')).toHaveLength(3);
  expect(voice.calls.filter(method => method === 'DELETE')).toHaveLength(3);
});
