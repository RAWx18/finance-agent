// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: {
  'allow-billable': { type: 'boolean' },
  audio: { type: 'string' },
  'synthetic-login': { type: 'boolean' },
  url: { type: 'string', default: 'http://localhost:8000' },
} });
assert.equal(values['allow-billable'], true, 'Explicit --allow-billable is required.');
assert.ok(values.audio && existsSync(values.audio), 'Provide the synthetic microphone WAV with --audio.');
const origin = new URL(values.url).origin;
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use an isolated local application.');

const browser = await chromium.launch({ headless: true, args: [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${resolve(values.audio)}`,
  '--autoplay-policy=no-user-gesture-required',
] });
const context = await browser.newContext({ baseURL: origin, permissions: ['microphone'], serviceWorkers: 'block' });
await context.setExtraHTTPHeaders({ Origin: origin });
const page = await context.newPage();
page.setDefaultTimeout(60000);
let stage = 'startup';
let room;
let session = false;
const errors = [];
const requests = [];
const safe = text => text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[TOKEN]')
  .replace(/https?:\/\/\S+/g, '[URL]').slice(0, 300);
page.on('pageerror', error => errors.push({ name: error.name, message: safe(error.message) }));
page.on('response', async response => {
  if (response.url().startsWith(`${origin}/api/`)) requests.push({
    path: new URL(response.url()).pathname, method: response.request().method(), status: response.status(),
  });
  if (response.url() === `${origin}/api/session/call` && response.request().method() === 'POST' && response.ok()) {
    const join = await response.json();
    room = new URL(join.url).pathname.slice(1);
  }
});

try {
  await context.addInitScript(() => {
    globalThis.voiceProbe = { peers: [], tracks: [] };
    const PeerConnection = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = new Proxy(PeerConnection, { construct(target, args) {
      const connection = Reflect.construct(target, args);
      globalThis.voiceProbe.peers.push(connection);
      return connection;
    } });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints);
      globalThis.voiceProbe.tracks.push(...stream.getTracks());
      return stream;
    };
  });
  if (values['synthetic-login']) {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/app`);
    console.log(JSON.stringify({ check: 'login', mode: 'testOnlyGoogleIdentity', passed: true }));
  }
  const settings = await context.request.get('/api/settings');
  assert.equal(settings.status(), 200);
  assert.equal((await settings.json()).voiceAvailable, true);
  assert.equal((await context.request.get('/api/session')).status(), 404);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  stage = 'connect';
  session = true;
  await page.getByRole('button', { name: 'Start talking', exact: true }).click();
  await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'active', { timeout: 60000 });
  console.log(JSON.stringify({ check: 'daily_browser_ready', passed: true }));
  stage = 'remoteAudio';
  await page.waitForFunction(() => {
    const audio = document.querySelector('audio');
    return audio?.srcObject?.getAudioTracks().some(track => track.readyState === 'live') && audio.currentTime > 0;
  }, undefined, { timeout: 30000 });
  await expect.poll(async () => {
    const state = await context.request.get('/api/session/call');
    return (await state.json()).status;
  }, { timeout: 15000 }).toBe('active');
  stage = 'spokenFacts';
  await expect.poll(async () => {
    const response = await context.request.get('/api/session');
    assert.equal(response.status(), 200);
    return (await response.json()).facts.opening.amountPaise;
  }, { timeout: 75000 }).toBe(600000);
  console.log(JSON.stringify({ check: 'spoken_fact_saved', openingPaise: 600000, passed: true }));
  stage = 'spokenCorrection';
  await expect.poll(async () => {
    const response = await context.request.get('/api/session');
    return (await response.json()).facts.opening.amountPaise;
  }, { timeout: 60000 }).toBe(650000);
  await expect(page.locator('main')).toContainText('₹6,500.00');
  console.log(JSON.stringify({ check: 'spoken_correction_and_card', openingPaise: 650000, passed: true }));
  stage = 'mediaStats';
  const stats = [];
  for (const frame of page.frames()) {
    stats.push(...await frame.evaluate(async () => {
      const results = [];
      for (const connection of globalThis.voiceProbe?.peers ?? []) {
        for (const report of (await connection.getStats()).values()) {
          if ((report.type === 'inbound-rtp' || report.type === 'outbound-rtp') && (report.kind === 'audio' || report.mediaType === 'audio')) {
            results.push({ type: report.type, bytes: report.bytesReceived ?? report.bytesSent ?? 0,
              energy: report.totalAudioEnergy ?? null });
          }
        }
      }
      return results;
    }));
  }
  assert.ok(stats.some(report => report.type === 'inbound-rtp' && report.bytes > 0), 'No inbound audio bytes.');
  assert.ok(stats.some(report => report.type === 'outbound-rtp' && report.bytes > 0), 'No outbound audio bytes.');
  console.log(JSON.stringify({ check: 'daily_webrtc_media', passed: true, streams: stats }));
  const words = await page.locator('.captions').innerText();
  assert.ok(words.includes('Assistant') && words.includes('You'), 'Actual speech captions missing.');
  stage = 'end';
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect.poll(async () => (await (await context.request.get('/api/session/call')).json()).status,
    { timeout: 30000 }).toBe('ended');
  assert.equal(await page.evaluate(() => globalThis.voiceProbe.tracks.every(track => track.readyState === 'ended')), true);
  assert.equal(await page.locator('audio').evaluate(audio => audio.srcObject === null), true);
  assert.equal(errors.length, 0, 'Browser JavaScript errors occurred.');
  console.log(JSON.stringify({ check: 'daily_call_ended', passed: true, microphoneStopped: true, room }));
} catch (error) {
  console.error(JSON.stringify({ check: 'live_voice_failure', stage, errorType: error.name,
    phase: await page.locator('.conversation').getAttribute('data-phase').catch(() => null),
    alerts: await page.getByRole('alert').allTextContents().catch(() => []),
    browserErrors: errors, requests: requests.slice(-12) }));
  process.exitCode = 1;
} finally {
  if (session) {
    const end = await context.request.delete('/api/session/call', { timeout: 30000 }).catch(() => null);
    const result = end?.ok() ? await end.json() : null;
    let cleaned = end?.status() === 404 || (result && ['ended', 'idle', 'error'].includes(result.status));
    if (cleaned) cleaned = (await context.request.delete('/api/session', { timeout: 10000 })).ok();
    console.log(JSON.stringify({ check: 'synthetic_session_cleanup', passed: !!cleaned, room }));
    if (!cleaned) process.exitCode = 1;
  }
  await context.close();
  await browser.close();
}