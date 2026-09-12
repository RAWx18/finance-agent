// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

// Native capture, transport and playback are observed, never resolved or replaced with test media.
export function observeLifecycle() {
  const tracks = new Set();
  const peers = new Set();
  const meters = new Map();
  let pending = 0;
  let firstActiveAt = null;
  let firstEnergyAt = null;
  let peak = 0;
  // Chromium omits unload keepalive requests from Playwright's network events.
  const fetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const response = fetch.call(this, input, init);
    if (input === '/api/session/call' && init?.method === 'DELETE') {
      const { callId } = JSON.parse(init.body);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId))
        sessionStorage.setItem('voice-lifecycle-end', JSON.stringify({ callId, keepalive: init.keepalive === true, cancellable: !!init.signal }));
    }
    return response;
  };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    pending++;
    try {
      const stream = await capture(constraints);
      for (const track of stream.getTracks()) tracks.add(track);
      return stream;
    } finally { pending--; }
  };
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function () {
    const track = clone.call(this);
    if (tracks.has(this)) tracks.add(track);
    return track;
  };
  const Peer = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = new Proxy(Peer, { construct(target, args) {
    const peer = Reflect.construct(target, args);
    peers.add(peer);
    return peer;
  } });
  const now = () => performance.timeOrigin + performance.now();
  const ui = () => ({
    phase: document.querySelector('.conversation')?.getAttribute('data-phase') ?? null,
    capturing: document.querySelector('.voice-status-panel')?.getAttribute('data-capturing') === 'true',
  });
  setInterval(() => {
    if (!firstActiveAt && ui().phase === 'active' && ui().capturing) firstActiveAt = now();
    for (const [stream, meter] of meters) {
      if (stream.getTracks().every(track => track.readyState === 'ended')) {
        meter.source.disconnect();
        void meter.context.close();
        meters.delete(stream);
      }
    }
    for (const audio of document.querySelectorAll('audio')) {
      const stream = audio.srcObject;
      if (!stream?.getAudioTracks?.().some(track => track.readyState === 'live' && !tracks.has(track))) continue;
      if (!meters.has(stream)) {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        const source = context.createMediaStreamSource(stream);
        source.connect(analyser);
        void context.resume();
        meters.set(stream, { context, source, analyser, data: new Float32Array(1024) });
      }
      const meter = meters.get(stream);
      meter.analyser.getFloatTimeDomainData(meter.data);
      const rms = Math.sqrt(meter.data.reduce((sum, value) => sum + value * value, 0) / meter.data.length);
      peak = Math.max(peak, rms);
      if (rms > 0.0001 && meter.context.state === 'running' && !audio.paused && !audio.muted && audio.volume > 0)
        firstEnergyAt ??= now();
    }
  }, 20);
  globalThis.lifecycle = {
    reset() {
      firstActiveAt = firstEnergyAt = null;
      peak = 0;
      sessionStorage.removeItem('voice-lifecycle-end');
      for (const entry of performance.getEntriesByType('mark'))
        if (entry.name.startsWith('voice:')) performance.clearMarks(entry.name);
    },
    snapshot() {
      for (const peer of peers) for (const sender of peer.getSenders()) if (sender.track) tracks.add(sender.track);
      return {
        ui: ui(), pending,
        liveTracks: [...tracks].filter(track => track.readyState === 'live').length,
        enabledTracks: [...tracks].filter(track => track.readyState === 'live' && track.enabled && !track.muted).length,
        peers: [...peers].map(peer => peer.connectionState),
        playing: [...document.querySelectorAll('audio')].some(audio => audio.srcObject && !audio.paused && !audio.muted),
        firstActiveAt, firstEnergyAt, peak,
        marks: Object.fromEntries(performance.getEntriesByType('mark')
          .filter(entry => /^voice:(start|mic-request|mic-ready|setup-request|setup-ready|join-request|join-ready|connect|bot-ready|end|local-stop|end-request|end-confirmed)$/.test(entry.name))
          .map(entry => [entry.name.slice(6), performance.timeOrigin + entry.startTime])),
      };
    },
  };
}

async function run(values) {
  const origin = new URL(values.url).origin;
  // Headless-shell does not implement native permission overrides; prompts need visible Chromium.
  const browser = await chromium.launch({ channel: 'chromium', headless: values.mode !== 'prompt', args: [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${values.audio}`,
    '--autoplay-policy=no-user-gesture-required',
  ] });
  let context;
  let page;
  let monitor;
  let stage = 'login';
  let cycle = 0;
  let lastProbe = null;
  let lastMedia = [];
  let callId = null;
  let signedIn = false;
  let passed = false;
  const callIds = new Set();
  const requests = [];
  const errors = [];
  const report = (check, details = {}) => console.log(JSON.stringify({ check, cycle, mode: values.mode, ...details }));
  let aborted = false;
  const abort = () => { aborted = true; void page?.close().catch(() => undefined); };
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const deadline = setTimeout(abort, values.cycles * 180000 - 50000);
  const probe = async (diagnostics = false) => {
    const response = await context.request.get(`/__test/lifecycle${diagnostics ? '?diagnostics=true' : ''}`, { timeout: 2500 });
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.factory, 'lifecycle');
    lastProbe = body;
    return body;
  };
  const media = async () => {
    lastMedia = (await Promise.all(page.frames().map(frame => frame.evaluate(() => globalThis.lifecycle?.snapshot())
      .catch(() => null)))).filter(Boolean);
    return lastMedia;
  };
  const until = async (check, milliseconds = 10000) => {
    const end = Date.now() + milliseconds;
    do {
      if (await check()) return;
      await page.waitForTimeout(80);
    } while (Date.now() < end);
    throw new Error('Lifecycle deadline');
  };
  const measurements = frames => {
    const marks = frames.find(frame => frame.marks.start)?.marks ?? {};
    const start = marks.start;
    const active = frames.find(frame => frame.firstActiveAt)?.firstActiveAt;
    const energy = Math.min(...frames.filter(frame => frame.firstEnergyAt).map(frame => frame.firstEnergyAt));
    return {
      timingsMs: {
        ...Object.fromEntries(Object.entries(marks).map(([name, at]) => [name, Math.round(at - start)])),
        activeUiCapturing: active && start ? Math.round(active - start) : null,
        firstRemoteAudio: Number.isFinite(energy) && start ? Math.round(energy - start) : null,
        endToLocalStop: marks.end && marks['local-stop'] ? Math.round(marks['local-stop'] - marks.end) : null,
        endToConfirmed: marks.end && marks['end-confirmed'] ? Math.round(marks['end-confirmed'] - marks.end) : null,
      },
      media: frames.map(({ ui, pending, liveTracks, enabledTracks, peers, playing, peak }) =>
        ({ ui, pending, liveTracks, enabledTracks, peers, playing, peak })),
    };
  };
  const released = async () => {
    const frames = await media();
    const state = (await probe()).call;
    return frames.length > 0 && frames.every(frame => !frame.liveTracks && !frame.playing && frame.peers.every(value => value === 'closed'))
      && (!state || state.callId === callId && state.cleanupConfirmed
        && ['ended', 'error'].includes(state.status) && state.task.done
        && (!state.workerTask.present || state.workerTask.done)
        && (!state.pipelineTask.present || state.pipelineTask.done));
  };
  try {
    context = await browser.newContext({ baseURL: origin, serviceWorkers: 'block' });
    await context.setExtraHTTPHeaders({ Origin: origin });
    await context.addInitScript(observeLifecycle);
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(['TypeError', 'ReferenceError', 'SyntaxError'].includes(error.name) ? error.name : 'Error'));
    page.on('request', request => {
      if (request.url() !== `${origin}/api/session/call` || request.method() !== 'POST') return;
      try {
        const id = request.postDataJSON()?.callId;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          callId = id;
          callIds.add(id);
        }
      } catch { /* Diagnostics retain only the validated request identity, never its full body. */ }
    });
    page.on('response', response => {
      if (response.url() === `${origin}/api/session/call`) {
        requests.push({ method: response.request().method(), status: response.status() });
        if (requests.length > 20) requests.shift();
      }
    });
    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/app`);
    signedIn = true;
    await probe();
    const response = await context.request.get('/api/settings');
    assert.equal(response.status(), 200);
    const settings = await response.json();
    assert.equal(settings.voiceAvailable, true);
    report('configuration', { startupSeconds: settings.voiceStartupSeconds,
      shutdownSeconds: settings.voiceShutdownSeconds, cycleBoundSeconds: 180 });
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    const permission = setting => cdp.send('Browser.setPermission', {
      permission: { name: 'microphone' }, setting, origin, browserContextId: targetInfo.browserContextId,
    });
    let sampling = false;
    let signature;
    monitor = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      try {
        const state = await probe();
        const current = JSON.stringify({ ...state.call, secondsSinceAdmission: undefined });
        if (current !== signature) {
          signature = current;
          report('lifecycleStage', { stage, lifecycle: state });
        }
      } catch { /* The last successful probe remains available when the event loop is stuck. */ }
      finally { sampling = false; }
    }, 750);
    for (cycle = 1; cycle <= values.cycles; cycle++) {
      const timer = setTimeout(abort, 125000);
      try {
        stage = 'microphone';
        const admitted = callIds.size;
        const observed = (await probe()).callsObserved;
        if (values.mode === 'prompt') await context.clearPermissions();
        else await permission(values.mode === 'denied' ? 'denied' : 'granted');
        await expect(page.getByRole('button', { name: /^(Start conversation|Start talking|Reconnect)$/ })).toBeVisible();
        if (await page.getByRole('button', { name: 'Start conversation', exact: true }).isVisible())
          await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
        await Promise.all(page.frames().map(frame => frame.evaluate(() => globalThis.lifecycle?.reset()).catch(() => undefined)));
        await page.getByRole('button', { name: /^(Start talking|Reconnect)$/ }).click();
        if (values.mode === 'denied') {
          await expect(page.getByText('Microphone access denied', { exact: true })).toBeVisible();
          await until(released);
          assert.equal(callIds.size, admitted);
          assert.equal((await probe()).callsObserved, observed);
        } else if (values.mode === 'prompt') {
          await until(async () => (await media()).some(frame => frame.pending > 0));
          assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' })).state), 'prompt');
          assert.equal(callIds.size, admitted);
          stage = 'endDuringPermission';
          await page.getByRole('button', { name: 'End conversation', exact: true }).click();
          await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'ended');
          assert.ok((await media()).some(frame => frame.pending > 0));
          await until(released);
          report(stage, { passed: true, permissionStillPending: true,
            ...measurements(await media()), lifecycle: await probe() });
          // Navigation dismisses the real browser prompt; no synthetic device promise is resolved.
          await page.reload({ waitUntil: 'domcontentloaded' });
          await until(async () => (await media()).every(frame => frame.pending === 0) && await released());
          assert.equal(callIds.size, admitted);
          assert.equal((await probe()).callsObserved, observed);
        } else {
          stage = 'activeUiCapturing';
          await until(async () => {
            const frames = await media();
            assert.ok(!frames.some(frame => ['ended', 'error'].includes(frame.ui.phase)));
            return frames.some(frame => frame.ui.phase === 'active' && frame.ui.capturing)
              && frames.some(frame => frame.enabledTracks > 0);
          }, 100000);
          assert.equal(callIds.size, admitted + 1);
          report(stage, { passed: true, temperature: cycle === 1 ? 'cold' : 'warm', callId,
            ...measurements(await media()), lifecycle: await probe() });
          stage = 'firstRemoteAudio';
          await until(async () => (await media()).some(frame => frame.firstEnergyAt), 20000);
          report(stage, { passed: true, callId, ...measurements(await media()), lifecycle: await probe() });
          stage = values.mode === 'refresh' ? 'refresh' : 'end';
          const endAt = Date.now();
          if (values.mode === 'refresh') await page.reload({ waitUntil: 'domcontentloaded' });
          else await page.getByRole('button', { name: 'End conversation', exact: true }).click();
          const termination = await page.evaluate(() => JSON.parse(sessionStorage.getItem('voice-lifecycle-end') ?? 'null'));
          assert.deepEqual(termination, { callId, keepalive: true, cancellable: false });
          await until(released, (settings.voiceShutdownSeconds + 5) * 1000);
          assert.equal(callIds.size, admitted + 1);
          report(stage, { passed: true, ownedEndRequest: true, releaseMs: Date.now() - endAt, callId,
            ...measurements(await media()), lifecycle: await probe() });
        }
        assert.deepEqual(errors, []);
        report('cycle', { passed: true, ...measurements(await media()), lifecycle: await probe() });
      } finally { clearTimeout(timer); }
    }
    passed = true;
  } catch (error) {
    clearInterval(monitor);
    const diagnostics = signedIn ? await probe(true).catch(() => null) : null;
    report('failure', { passed: false, stage, callId, exceptionType: error.name === 'AssertionError' ? 'AssertionError' : 'Error',
      diagnosticsAvailable: !!diagnostics, lifecycle: diagnostics ?? lastProbe,
      ...measurements(await media().catch(() => lastMedia)), requests, browserErrors: errors });
  } finally {
    clearInterval(monitor);
    clearTimeout(deadline);
    // Request identities remain available even when POST fails or never returns credentials.
    let cleanup = true;
    for (const id of callIds) {
      try {
        const response = await context.request.delete('/api/session/call', {
          data: { callId: id }, timeout: aborted ? 750 : 14000,
        });
        const state = await response.json();
        cleanup &&= response.status() === 200 && state.callId === id && state.cleanupConfirmed === true;
      } catch { cleanup = false; }
    }
    await context?.close().catch(() => { cleanup = false; });
    await browser.close().catch(() => { cleanup = false; });
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    report('browserCleanup', { passed: cleanup, calls: callIds.size });
    passed &&= cleanup;
  }
  return passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      'allow-billable': { type: 'boolean', default: false },
      cycles: { type: 'string', default: '2' }, mode: { type: 'string', default: 'cycles' },
      url: { type: 'string' }, audio: { type: 'string' },
    } });
    assert.equal(values['allow-billable'], true);
    assert.ok(['1', '2'].includes(values.cycles));
    assert.ok(['cycles', 'denied', 'prompt', 'refresh'].includes(values.mode));
    assert.ok(values.url && values.audio && existsSync(values.audio));
    process.exitCode = await run({ ...values, cycles: Number(values.cycles) });
  } catch {
    console.log(JSON.stringify({ passed: false, check: 'runner', requirement: 'Use the managed Python runner with --allow-billable.' }));
    process.exitCode = 1;
  }
}
