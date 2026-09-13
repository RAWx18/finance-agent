// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

// Only synthetic user capture is replaced. SDK, transport, remote tracks and playback stay real.
export function installMicrophone(payload) {
  const NativeAudioContext = globalThis.AudioContext;
  let testAudioContext;
  let destination;
  let silenceSource;
  const tracks = [];
  const peers = [];
  const meters = new Map();
  const events = [];
  const counts = {};
  const injections = [];
  const energyTimes = [];
  const sources = new Set();
  let lastEnergyAt = 0;
  let energySamples = 0;
  let peak = 0;

  function receive(value, depth = 0) {
    if (depth > 9 || value === null) return;
    if (typeof value === 'string') {
      if (value.length > 200000 || !['{', '['].includes(value[0])) return;
      try { receive(JSON.parse(value), depth + 1); } catch { /* Non-JSON transport data. */ }
      return;
    }
    if (typeof value !== 'object') return;
    if (value.type === 'conversation-state' && ['waiting', 'active'].includes(value.state)
      && Number.isSafeInteger(value.sequence)) {
      events.push({ state: value.state, sequence: value.sequence, at: Date.now() });
      if (events.length > 40) events.shift();
      return;
    }
    if (['bot-ready', 'bot-started-speaking', 'bot-stopped-speaking', 'bot-output',
      'bot-tts-text', 'user-transcription', 'error'].includes(value.type)) {
      counts[value.type] = (counts[value.type] ?? 0) + 1;
      return;
    }
    for (const nested of Object.values(value).slice(0, 30)) receive(nested, depth + 1);
  }
  addEventListener('message', event => receive(event.data));
  const PeerConnection = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = new Proxy(PeerConnection, { construct(target, args) {
    const peer = Reflect.construct(target, args);
    peers.push(peer);
    peer.addEventListener('datachannel', event => event.channel.addEventListener('message', message => receive(message.data)));
    return peer;
  } });
  const Socket = globalThis.WebSocket;
  globalThis.WebSocket = new Proxy(Socket, { construct(target, args) {
    const socket = Reflect.construct(target, args);
    socket.addEventListener('message', event => receive(event.data));
    return socket;
  } });

  function input() {
    if (!testAudioContext) {
      testAudioContext = new NativeAudioContext({ sampleRate: payload.sampleRate });
      destination = testAudioContext.createMediaStreamDestination();
      destination.channelCount = 1;
      // A physical microphone supplies silent frames between utterances as well.
      silenceSource = testAudioContext.createConstantSource();
      silenceSource.offset.value = 0;
      silenceSource.connect(destination);
      silenceSource.start();
    }
    return testAudioContext;
  }
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.audio) return capture(constraints);
    await input().resume();
    const stream = constraints.video ? await capture({ ...constraints, audio: false }) : new MediaStream();
    const track = destination.stream.getAudioTracks()[0].clone();
    tracks.push(track);
    track.addEventListener('unmute', () => { void input().resume(); });
    stream.addTrack(track);
    return stream;
  };
  // Continue may resume an existing disabled track rather than request another stream.
  addEventListener('pointerdown', () => { if (testAudioContext) void testAudioContext.resume(); }, true);
  addEventListener('online', () => { if (testAudioContext) void testAudioContext.resume(); });

  const timer = setInterval(() => {
    for (const audio of document.querySelectorAll('audio')) {
      const stream = audio.srcObject;
      if (!stream?.getAudioTracks?.().some(track => track.readyState === 'live')) continue;
      if (!meters.has(stream)) {
        const context = new NativeAudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        const source = context.createMediaStreamSource(stream);
        const silence = context.createGain();
        silence.gain.value = 0;
        source.connect(analyser).connect(silence).connect(context.destination);
        void context.resume();
        meters.set(stream, { context, analyser, source, silence, data: new Float32Array(1024), rms: 0 });
      }
      const meter = meters.get(stream);
      meter.analyser.getFloatTimeDomainData(meter.data);
      meter.rms = Math.sqrt(meter.data.reduce((sum, value) => sum + value * value, 0) / meter.data.length);
      peak = Math.max(peak, meter.rms);
      if (meter.rms > 0.0001 && !audio.paused && !audio.muted && audio.volume > 0) {
        lastEnergyAt = Date.now();
        energySamples++;
        energyTimes.push(lastEnergyAt);
        if (energyTimes.length > 1000) energyTimes.shift();
      }
    }
  }, 25);

  globalThis.continuousVoice = {
    enabled: () => tracks.some(track => track.readyState === 'live' && track.enabled && !track.muted),
    async play(chunks) {
      if (!this.enabled()) return null;
      await input().resume();
      let start = testAudioContext.currentTime + 0.025;
      const began = start;
      const first = injections.length;
      for (const { name, gap = 0 } of chunks) {
        const bytes = Uint8Array.from(atob(payload.samples[name]), character => character.charCodeAt(0));
        const pcm = new DataView(bytes.buffer);
        const buffer = testAudioContext.createBuffer(1, bytes.length / 2, payload.sampleRate);
        const channel = buffer.getChannelData(0);
        for (let index = 0; index < channel.length; index++) channel[index] = pcm.getInt16(index * 2, true) / 32768;
        const source = testAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        source.addEventListener('ended', () => { sources.delete(source); source.disconnect(); });
        sources.add(source);
        source.start(start);
        injections.push({ name, at: Date.now() + (start - testAudioContext.currentTime) * 1000,
          durationMs: buffer.duration * 1000, gapMs: gap * 1000 });
        start += buffer.duration + gap;
      }
      return { durationMs: (start - began) * 1000 + 25, count: chunks.length,
        firstAt: injections[first].at, firstDurationMs: injections[first].durationMs };
    },
    async snapshot(includeEnergy = false) {
      const rtp = [];
      for (const peer of peers) {
        for (const report of (await peer.getStats()).values()) {
          if (['inbound-rtp', 'outbound-rtp'].includes(report.type) && (report.kind ?? report.mediaType) === 'audio')
            rtp.push({ direction: report.type, bytes: report.bytesReceived ?? report.bytesSent ?? 0,
              energy: report.totalAudioEnergy ?? 0 });
        }
      }
      const audio = [...document.querySelectorAll('audio')].map(element => ({
        playing: !element.paused && !element.muted && element.volume > 0,
        paused: element.paused, muted: element.muted, volume: element.volume,
        rms: meters.get(element.srcObject)?.rms ?? 0,
      }));
      return { enabled: this.enabled(), liveTracks: tracks.filter(track => track.readyState === 'live').length,
        ui: { state: document.querySelector('.voice-status-panel [data-state]')?.getAttribute('data-state'),
          status: document.querySelector('.voice-status')?.textContent,
          capturing: document.querySelector('.voice-status-panel')?.getAttribute('data-capturing') },
        rtp, transport: peers.map(peer => peer.connectionState), audio, lastEnergyAt, energySamples,
        peak, events, counts, injections,
        spokenCaptionCharacters: [...document.querySelectorAll('.live-caption[data-speaker="Assistant"] p')]
          .reduce((total, element) => total + element.textContent.length, 0),
        ...(includeEnergy ? { energyTimes } : {}) };
    },
    async close() {
      clearInterval(timer);
      for (const source of sources) { source.stop(); source.disconnect(); }
      for (const track of tracks) track.stop();
      silenceSource?.stop(); silenceSource?.disconnect();
      destination?.stream.getTracks().forEach(track => track.stop());
      await testAudioContext?.close();
      await Promise.all([...meters.values()].map(meter => meter.context.close()));
    },
  };
}

async function run(values) {
  const payload = JSON.parse(readFileSync(values.samples, 'utf8'));
  assert.equal(payload.sampleRate, 16000);
  assert.equal(Object.keys(payload.samples).length, values.phase === 'demo' ? 8 : 7);
  assert.match(payload.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  for (const sample of Object.values(payload.samples)) {
    assert.equal(typeof sample, 'string');
    assert.match(sample, /^[A-Za-z0-9+/]+={0,2}$/);
    const length = Buffer.from(sample, 'base64').length;
    assert.ok(length > 0 && length <= 640000 && length % 2 === 0);
  }
  const origin = new URL(values.url).origin;
  const browser = await chromium.launch({ headless: true, args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ] });
  let context;
  let page;
  let stage = 'startup';
  let signedIn = false;
  let monitor;
  const browserErrors = [];
  const responses = [];
  const started = Date.now();
  const report = (check, details = {}) => console.log(JSON.stringify({ check, elapsedMs: Date.now() - started, ...details }));
  let aborted = false;
  const abort = () => { aborted = true; void page?.close().catch(() => undefined); };
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const deadline = setTimeout(abort, values['initial-wait'] ? 500000 : 350000);
  const media = async (includeEnergy = false) => {
    const frames = [];
    for (const frame of page.frames()) {
      const snapshot = await frame.evaluate(include => globalThis.continuousVoice?.snapshot(include), includeEnergy).catch(() => null);
      if (snapshot) frames.push(snapshot);
    }
    return frames;
  };
  const api = async path => {
    assert.equal(aborted, false);
    const response = await context.request.get(path, { timeout: 5000 });
    assert.equal(response.status(), 200);
    return response.json();
  };
  const checkpoint = async check => report(check, { passed: true,
    pipeline: await api('/__test/voice'), media: await media() });
  const energy = async after => {
    await expect.poll(async () => (await media()).some(frame => frame.lastEnergyAt > after
      && frame.audio.some(audio => audio.playing && audio.rms > 0.0001)),
    { timeout: 35000, intervals: [50, 100] }).toBe(true);
  };
  const spoken = async after => {
    await expect.poll(async () => page.locator('.live-caption[data-speaker="Assistant"] time').evaluateAll(
      (elements, after) => elements.some(element => Date.parse(element.dateTime) >= after), after),
    { timeout: 35000, intervals: [100] }).toBe(true);
    await energy(after);
  };
  const quiet = async (silenceMs = 1000, statusTimeout = 45000) => {
    await expect(page.locator('.voice-status')).toHaveText('Listening', { timeout: statusTimeout });
    await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'true');
    await expect.poll(async () => {
      const last = Math.max(...(await media()).map(frame => frame.lastEnergyAt));
      return last > 0 && Date.now() - last >= silenceMs;
    }, { timeout: 20000 }).toBe(true);
  };
  const play = async (chunks, bargeIn = false) => {
    await expect.poll(async () => (await media()).some(frame => frame.enabled), { timeout: 10000 }).toBe(true);
    const candidates = [];
    for (const frame of page.frames()) {
      if (await frame.evaluate(() => globalThis.continuousVoice?.enabled()).catch(() => false)) candidates.push(frame);
    }
    assert.equal(candidates.length, 1, 'Expected exactly one microphone-owning frame');
    if (bargeIn) await energy(Date.now() - 100);
    const injection = await candidates[0].evaluate(chunks => globalThis.continuousVoice.play(chunks), chunks);
    assert.ok(injection);
    report(stage, { action: 'microphone', ...injection });
    await page.waitForTimeout(injection.durationMs);
    if (bargeIn) assert.ok((await media(true)).some(frame => frame.energyTimes.some(at =>
      at >= injection.firstAt && at <= injection.firstAt + injection.firstDurationMs)), 'No real audio overlap');
  };
  const facts = async (amount, dated = true) => {
    await expect.poll(async () => {
      const snapshot = await api('/api/session');
      return snapshot.facts.opening.amountPaise === amount && snapshot.facts.records.some(record =>
        record.kind === 'essential' && /rent/i.test(record.label) && record.amount.amountPaise === 200000
        && (!dated || record.schedule.date === payload.dueDate));
    }, { timeout: 35000 }).toBe(true);
  };
  try {
    context = await browser.newContext({ baseURL: origin, permissions: ['microphone'], serviceWorkers: 'block' });
    await context.setExtraHTTPHeaders({ Origin: origin });
    await context.addInitScript(installMicrophone, payload);
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => browserErrors.push(['TypeError', 'ReferenceError', 'SyntaxError'].includes(error.name) ? error.name : 'Error'));
    page.on('response', response => {
      if (response.url().startsWith(`${origin}/api/`)) {
        responses.push({ status: response.status(), method: response.request().method() });
        if (responses.length > 20) responses.shift();
      }
    });
    stage = 'login';
    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/app`);
    signedIn = true;
    let sampling = false;
    let signature;
    let samples = 0;
    monitor = setInterval(async () => {
      if (sampling || samples >= 200) return;
      sampling = true;
      try {
        const pipeline = await api('/__test/voice');
        const current = JSON.stringify({ stage, pipeline });
        if (current !== signature) {
          signature = current;
          samples++;
          report('pipelineStage', { stage, pipeline });
        }
      } catch { /* Stage assertions report probe failures without private response bodies. */ }
      finally { sampling = false; }
    }, 300);
    assert.equal((await api('/api/settings')).voiceAvailable, true);
    assert.equal((await context.request.get('/api/session')).status(), 404);
    stage = 'botReadyAndAudibleGreeting';
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Start talking', exact: true }).click();
    await expect(page.locator('.conversation')).toHaveAttribute('data-phase', 'active', { timeout: 60000 });
    await expect.poll(async () => (await api('/__test/voice')).ready).toBe(true);
    await energy(started);
    await expect(page.locator('.live-caption[data-speaker="Assistant"] p')).not.toBeEmpty();
    await checkpoint(stage);
    await quiet();

    if (values['initial-wait']) {
      const call = await api('/api/session/call');
      const snapshot = await api('/api/session');
      for (let cycle = 1; cycle <= 2; cycle++) {
        stage = `initialWaitingContinue${cycle}`;
        await expect.poll(async () => (await api('/__test/voice')).waiting,
          { timeout: 75000, intervals: [500] }).toBe(true);
        await expect.poll(async () => (await media()).every(frame => !frame.enabled)).toBe(true);
        await expect(page.locator('.voice-status')).toHaveText('Paused');
        const resumedAt = Date.now();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect.poll(async () => (await api('/__test/voice')).waiting).toBe(false);
        await spoken(resumedAt);
        await quiet();
        assert.equal((await api('/api/session/call')).callId, call.callId);
        assert.deepEqual((await api('/api/session')).facts, snapshot.facts);
        assert.equal((await api('/__test/voice')).metrics.tool_calls ?? 0, 0);
        assert.equal((await api('/__test/voice')).metrics.user_turns ?? 0, 0);
        await checkpoint(stage);
      }
    }

    if (values.phase === 'recovery') {
      stage = 'typedFinancialFixture';
      const snapshot = await api('/api/session');
      const saved = await context.request.post('/api/session/commands', { data: {
        commandId: randomUUID(), expectedRevision: snapshot.revision,
        operation: { type: 'replaceFacts', facts: {
          opening: { amount: '6500', status: 'exact' }, reserve: '0',
          coverage: { income: 'notDiscussed', essential: 'reported', optional: 'notDiscussed', debt: 'notDiscussed' },
          records: [{ id: randomUUID(), kind: 'essential', label: 'Rent', amount: { amount: '2000', status: 'exact' },
            schedule: { date: payload.dueDate, recurrence: 'once' } }],
        } },
      } });
      assert.equal(saved.status(), 200);
      await facts(650000);
      await play([{ name: 'followup' }]);
      await spoken(Date.now());
      await checkpoint(stage);
    } else {
      stage = 'pausedMultifactAndFiller';
      const pausedAt = Date.now();
      const beforePauses = (await api('/__test/voice')).metrics;
      const revision = (await api('/api/session')).revision;
      await play([{ name: 'cash', gap: 1.2 }, { name: 'filler', gap: 2 }, { name: 'rent' }]);
      const afterPauses = (await api('/__test/voice')).metrics;
      assert.equal(afterPauses.model_requests ?? 0, beforePauses.model_requests ?? 0,
        'Inference started before the paused thought finished');
      assert.equal(afterPauses.published_audio, beforePauses.published_audio,
        'Assistant spoke during the paused thought');
      await facts(600000, values.phase !== 'demo');
      await spoken(pausedAt);
      assert.equal((await api('/api/session')).revision, revision + 1, 'Multi-fact capture was not atomic');
      if (values.phase === 'demo') assert.equal((await api('/api/session')).facts.decision.responses
        .some(response => response.response === 'unavailable' && response.actionId.endsWith(':schedule.date')), false,
      'Unclear recognition was incorrectly treated as an unavailable answer');
      await checkpoint(stage);
      await quiet(100);
      stage = 'postBotFinishFollowup';
      await play([{ name: 'followup' }]);
      await spoken(Date.now());
      if (values.phase === 'demo') await facts(600000);
      await checkpoint(stage);

      stage = 'audibleBargeInAndCorrection';
      await energy(Date.now() - 150);
      await play([{ name: 'no', gap: 0.25 }, { name: 'stop', gap: 0.4 }, { name: 'correction' }], true);
      const correctedAt = Date.now();
      await facts(650000);
      await spoken(correctedAt);
      await expect(page.locator('main')).toContainText('₹6,500.00');
      const userText = (await api('/__test/voice?diagnostics=true')).syntheticDialogue
        .filter(message => message.role === 'user').map(message => message.content);
      assert.match(userText.join(' '), /\bno\b/i);
      assert.match(userText.join(' '), /\bstop\b/i);
      await checkpoint(stage);
    }
    await quiet();

    if (values.phase === 'demo') {
      const saved = await api('/api/session');
      const outcome = saved.plan.decisionAssessment.outcome;
      assert.equal(saved.plan.projectionPartial, false);
      assert.equal(saved.plan.closingPaise, 450000);
      assert.equal(outcome.branch, 'fits');
      assert.equal(outcome.readiness, 'ready');
      assert.equal(saved.facts.records.length, 1);
      await expect(page.locator('main')).toContainText('₹6,500.00');
      report('demoOutcome', { passed: true, closingPaise: saved.plan.closingPaise, outcome,
        dialogue: (await api('/__test/voice?diagnostics=true')).syntheticDialogue });

      stage = 'planSummary';
      const beforeSummary = await api('/__test/voice');
      const summaryAt = Date.now();
      await play([{ name: 'summary' }]);
      await spoken(summaryAt);
      await quiet(1500, 90000);
      const afterSummary = await api('/__test/voice?diagnostics=true');
      const summary = afterSummary.syntheticDialogue.filter(message => message.role === 'assistant').at(-1)?.content ?? '';
      assert.equal(afterSummary.waiting, false, 'Plan summary entered Paused');
      assert.equal(afterSummary.metrics.waiting ?? 0, beforeSummary.metrics.waiting ?? 0, 'Plan summary paused the response');
      assert.equal(afterSummary.metrics.errors ?? 0, beforeSummary.metrics.errors ?? 0, 'Plan summary raised a pipeline error');
      assert.ok(summary.length >= 300, `Plan summary too short to exercise long synthesis (${summary.length} chars)`);
      assert.deepEqual((await api('/api/session')).facts, saved.facts, 'Plan summary changed saved facts');
      report('planSummary', { passed: true, chars: summary.length, spokenMs: Date.now() - summaryAt,
        publishedAudio: afterSummary.metrics.published_audio - beforeSummary.metrics.published_audio,
        synthesisContexts: afterSummary.metrics.synthesis_contexts - beforeSummary.metrics.synthesis_contexts });
      await checkpoint(stage);
    }

    stage = 'thinkingPause';
    const beforeThinking = await api('/__test/voice');
    await page.waitForTimeout(6000);
    assert.equal((await api('/__test/voice')).metrics.model_requests, beforeThinking.metrics.model_requests);
    assert.equal((await api('/__test/voice')).waiting, false);
    await expect(page.locator('.voice-status')).toHaveText('Listening');
    assert.ok(!(await page.locator('.conversation').innerText()).toLowerCase().includes('svgsvg'),
      'Unexpected SVG text in the conversation');
    await checkpoint(stage);

    const exercised = await api('/__test/voice');
    for (const counter of ['model_requests', 'model_text', 'tool_calls', 'synthesis_contexts',
      'synthesis_audio', 'published_audio', 'user_starts', 'user_turns']) assert.ok(exercised.metrics[counter] > 0, counter);

    if (values.phase !== 'baseline' && values.phase !== 'demo') {
      stage = 'serverInactivityWaiting';
      const call = await api('/api/session/call');
      const snapshot = await api('/api/session');
      const silentAt = Math.max(...(await media()).map(frame => frame.lastEnergyAt));
      await expect.poll(async () => (await api('/__test/voice')).waiting,
        { timeout: 90000, intervals: [500] }).toBe(true);
      const waiting = (await media()).flatMap(frame => frame.events).filter(event => event.state === 'waiting').at(-1);
      assert.ok(waiting, 'No real RTVI conversation-state waiting event');
      assert.ok(waiting.at - silentAt >= 55000, 'Waiting occurred before the real 60-second inactivity interval');
      await checkpoint(stage);
      stage = 'sameCallContinue';
      await page.getByRole('button', { name: /^Continue(?: conversation)?$/ }).click();
      await expect.poll(async () => (await api('/__test/voice')).waiting).toBe(false);
      assert.equal((await api('/api/session/call')).callId, call.callId);
      await expect.poll(async () => (await media()).some(frame => frame.events.some(event =>
        event.state === 'active' && event.sequence > waiting.sequence)), { timeout: 10000 }).toBe(true);
      await play([{ name: 'followup' }]);
      await spoken(Date.now());
      await facts(650000);
      assert.deepEqual((await api('/api/session')).facts, snapshot.facts);
      await checkpoint(stage);
      await quiet();

      stage = 'networkLossAndReconnect';
      await context.setOffline(true);
      try {
        await page.waitForFunction(() => !navigator.onLine);
        await page.waitForTimeout(4000);
        report('offlineTransportObservation', { media: await media() });
      } finally { await context.setOffline(false); }
      await page.waitForFunction(() => navigator.onLine);
      const beforeReconnect = await api('/api/session/call');
      const dropped = await context.request.post('/__test/connection', { data: {} });
      assert.equal(dropped.status(), 200);
      await expect.poll(async () => (await media()).every(frame => frame.liveTracks === 0),
        { timeout: 25000 }).toBe(true);
      await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
      let reconnected = false;
      await expect.poll(async () => {
        const reconnect = page.locator('.conversation').getByRole('button', { name: 'Reconnect', exact: true });
        if (!reconnected && await reconnect.isVisible() && await reconnect.isEnabled()) {
          reconnected = true;
          await reconnect.click();
        }
        return await page.locator('.conversation').getAttribute('data-phase') === 'active'
          && (await api('/api/session/call')).status === 'active';
      }, { timeout: 45000 }).toBe(true);
      assert.equal(reconnected, true, 'A real closed event stream must require explicit reconnect');
      assert.notEqual((await api('/api/session/call')).callId, beforeReconnect.callId);
      assert.equal((await api('/api/session')).sessionId, snapshot.sessionId);
      await facts(650000);
      await expect.poll(async () => (await api('/__test/voice')).ready).toBe(true);
      await play([{ name: 'followup' }]);
      await spoken(Date.now());
      assert.deepEqual((await api('/api/session')).facts, snapshot.facts);
      await checkpoint(stage);
      report('networkRecovery', { explicitReconnect: reconnected, passed: true });
    }

    stage = 'realMediaAndPipeline';
    const observed = await media();
    const rtp = observed.flatMap(frame => frame.rtp);
    assert.ok(rtp.some(report => report.direction === 'inbound-rtp' && report.bytes > 0));
    assert.ok(rtp.some(report => report.direction === 'outbound-rtp' && report.bytes > 0));
    const pipeline = await api('/__test/voice');
    assert.equal(pipeline.metrics.errors ?? 0, 0);
    assert.equal(browserErrors.length, 0);
    await checkpoint(stage);
    stage = 'endAndRelease';
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    await expect.poll(async () => (await api('/api/session/call')).status, { timeout: 30000 }).toBe('ended');
    await expect.poll(async () => (await media()).every(frame => frame.liveTracks === 0)).toBe(true);
    assert.equal(await page.locator('audio').evaluate(audio => audio.srcObject === null), true);
    report(stage, { passed: true });
  } catch (error) {
    report('continuousVoiceFailure', { stage, passed: false,
      exceptionType: ['TimeoutError', 'AssertionError', 'TypeError'].includes(error.name) ? error.name : 'Error',
      assertion: String(error.message).slice(0, 1200),
      pipeline: context ? await api('/__test/voice?diagnostics=true').catch(() => null) : null,
      media: page ? await media().catch(() => []) : [], browserErrors, responses,
      syntheticFacts: signedIn ? (await api('/api/session').catch(() => null))?.facts : null,
      syntheticCaptions: page ? await page.locator('.live-caption p').allTextContents().catch(() => []) : [] });
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    let cleaned = true;
    if (context) {
      await context.setOffline(false).catch(() => undefined);
      if (signedIn) {
        const current = await context.request.get('/api/session/call', { timeout: 6000 }).catch(() => null);
        let call = current?.ok() ? await current.json() : null;
        if (call?.callId) {
          const end = await context.request.delete('/api/session/call', { data: { callId: call.callId }, timeout: 30000 }).catch(() => null);
          call = end?.ok() ? await end.json() : null;
        }
        cleaned = current?.status() === 404 || (call?.cleanupConfirmed === true && ['idle', 'ended', 'error'].includes(call.status));
        if (cleaned) {
          const response = await context.request.delete('/api/session', { timeout: 6000 }).catch(() => null);
          cleaned &&= !!response && [200, 404].includes(response.status());
        }
      }
      const logout = await context.request.post('/api/auth/logout', { data: {}, timeout: 6000 }).catch(() => null);
      cleaned &&= logout?.status() === 204;
      if (page) for (const frame of page.frames()) await frame.evaluate(() => globalThis.continuousVoice?.close()).catch(() => undefined);
      await context.close().catch(() => { cleaned = false; });
    }
    await browser.close().catch(() => { cleaned = false; });
    report('syntheticSessionAndLogoutCleanup', { passed: cleaned });
    if (!cleaned) process.exitCode = 1;
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      'allow-billable': { type: 'boolean' }, phase: { type: 'string', default: 'lifecycle' },
      'initial-wait': { type: 'boolean' },
      samples: { type: 'string' }, url: { type: 'string' },
    } }));
    assert.equal(values['allow-billable'], true);
    assert.ok(['baseline', 'demo', 'lifecycle', 'recovery'].includes(values.phase));
    assert.ok(values.samples && values.url);
    const url = new URL(values.url);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(url.port && url.port !== '8000');
    assert.ok(!url.username && !url.password && !url.search && !url.hash);
  } catch {
    console.error(JSON.stringify({ check: 'arguments', passed: false,
      usage: '--allow-billable --phase baseline|demo|lifecycle|recovery --samples PATH --url ISOLATED_LOOPBACK_URL' }));
    process.exitCode = 1;
    return;
  }
  try { await run(values); }
  catch (error) {
    console.error(JSON.stringify({ check: 'harnessFailure', passed: false, error: String(error?.message ?? error).slice(0, 300) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();