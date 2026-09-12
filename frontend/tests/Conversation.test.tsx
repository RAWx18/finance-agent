// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode, useState } from 'react';
import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceError, RTVIEvent } from '@pipecat-ai/client-js';
import type { Participant, PipecatClientOptions } from '@pipecat-ai/client-js';
import type { DailyTransportConstructorOptions } from '@pipecat-ai/daily-transport';
import type { DailyEventObjectParticipant } from '@daily-co/daily-js';
import { Conversation } from '../src/Conversation';
import type { Transcript } from '../src/Captions';
import type { VoiceOrbState } from '../src/components/assistant-ui/elements/voice';
import { ToastViewport } from '../src/Toast';
import * as toast from '../src/Toast';
import { api, ApiError } from '../src/api';
import { settings, snapshot } from './fixtures';

const sdk = vi.hoisted(() => ({
  options: null as PipecatClientOptions | null,
  transportOptions: null as DailyTransportConstructorOptions | null,
  constructionError: null as Error | null,
  initDevices: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), destroy: vi.fn(),
  tracks: vi.fn(),
  dailyOn: vi.fn(), dailyOff: vi.fn(),
  clients: [] as { tracks: () => { local: { audio: MediaStreamTrack } }; disconnect: () => Promise<void> }[],
  enableMic: vi.fn(), sendClientMessage: vi.fn(), enabled: true,
  listeners: new Map<string, (track: MediaStreamTrack, participant?: Participant) => void>(),
}));
const orb = vi.hoisted(() => vi.fn());
vi.mock('../src/components/assistant-ui/elements/voice', async (original) => {
  const module = await original<typeof import('../src/components/assistant-ui/elements/voice')>();
  return { ...module, VoiceOrb: (props: ComponentProps<typeof module.VoiceOrb>) => {
    orb(props);
    return <module.VoiceOrb {...props} />;
  } };
});
vi.mock('@pipecat-ai/client-js', async (original) => ({
  ...await original<typeof import('@pipecat-ai/client-js')>(),
  PipecatClient: class {
    constructor(options: PipecatClientOptions) { if (sdk.constructionError) throw sdk.constructionError; sdk.options = options; sdk.clients.push(this); }
    initDevices = sdk.initDevices;
    connect = sdk.connect;
    disconnect = sdk.disconnect;
    enableMic = sdk.enableMic;
    sendClientMessage = sdk.sendClientMessage;
    tracks = sdk.tracks;
    get isMicEnabled() { return sdk.enabled; }
    on(name: string, callback: (track: MediaStreamTrack, participant?: Participant) => void) { sdk.listeners.set(name, callback); }
  },
}));
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: class {
  constructor(options: DailyTransportConstructorOptions) { sdk.transportOptions = options; }
  dailyCallClient = { destroy: sdk.destroy, on: sdk.dailyOn, off: sdk.dailyOff };
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const join = { callId: '31272278-5d9e-4712-848b-e148ac8f47ba' as const, url: 'https://room.daily.co/test', token: 'short-lived-test-token', expiresAt: '2026-09-11T05:00:00Z' };
const remote: Participant = { id: 'bot', name: 'Assistant', local: false };
function track(kind = 'audio', readyState = 'live') { return Object.assign(new EventTarget(), { kind, readyState, muted: false, enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack; }
function show(props: Partial<ComponentProps<typeof Conversation>> = {}) {
  const onStarted = vi.fn();
  const onBusyChange = vi.fn();
  const onPhaseChange = vi.fn();
  const onPrepare = vi.fn();
  const onSettings = vi.fn();
  const onTranscriptChange = vi.fn<(transcript: Transcript) => void>();
  const options: ComponentProps<typeof Conversation> = { settings: { ...settings, voiceAvailable: true }, disabled: false,
    onStarted, onBusyChange, presentation: 'session', onPrepare, onPhaseChange, onSettings, onTranscriptChange, ...props };
  const view = render(<><Conversation {...options} /><ToastViewport /></>);
  return { ...view, onStarted, onBusyChange, onPhaseChange, onPrepare, onSettings, onTranscriptChange,
    get transcript() { return onTranscriptChange.mock.lastCall![0]; },
    change(changes: Partial<ComponentProps<typeof Conversation>>) {
      Object.assign(options, changes);
      view.rerender(<><Conversation {...options} /><ToastViewport /></>);
    } };
}
function panel() { return within(screen.getByRole('region', { name: 'Your conversation' })); }
function expectOrb(state: VoiceOrbState, volume: number, runtime: string = state) {
  expect(orb).toHaveBeenLastCalledWith({ state, volume, variant: 'emerald' });
  const image = panel().getByRole('img');
  expect(image).toHaveClass('call-orb');
  expect(image).toHaveAttribute('data-state', runtime);
  expect(image).toHaveAttribute('data-volume');
  expect(Number(image.getAttribute('data-volume'))).toEqual(volume);
  expect(image.querySelector('canvas.aui-voice-orb')).toHaveAttribute('data-state', state);
}
async function start() {
  await userEvent.click(panel().getByRole('button', { name: /^(Start talking|Reconnect)$/ }));
  await waitFor(() => expect(sdk.connect).toHaveBeenCalled());
}
function ready() { act(() => sdk.options!.callbacks!.onBotReady!({ version: '2.1.0' })); }
async function hear(bot = track()) { await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(bot, remote)); return bot; }

beforeEach(() => {
  orb.mockClear();
  join.expiresAt = new Date(Date.now() + 3600000).toISOString();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(join.callId);
  vi.spyOn(performance, 'mark').mockImplementation(() => ({} as PerformanceMark));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  sdk.options = null; sdk.transportOptions = null; sdk.constructionError = null; sdk.listeners.clear(); sdk.enabled = true;
  sdk.clients.length = 0;
  for (const method of [sdk.initDevices, sdk.connect, sdk.disconnect]) method.mockReset().mockResolvedValue(undefined);
  sdk.destroy.mockReset().mockImplementation(() => { throw new Error('Calls to destroy() are disabled.'); });
  sdk.tracks.mockReset().mockReturnValue({ local: { audio: track() } });
  sdk.enableMic.mockReset().mockImplementation((enabled: boolean) => { sdk.enabled = enabled; });
  sdk.sendClientMessage.mockReset();
  sdk.dailyOn.mockReset(); sdk.dailyOff.mockReset();
  vi.spyOn(api, 'start').mockResolvedValue(snapshot());
  vi.spyOn(api, 'startCall').mockImplementation(async callId => ({ ...join, callId }));
  vi.spyOn(api, 'endCall').mockImplementation(async callId => ({ callId, status: 'ended', cleanupConfirmed: true, message: null }));
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', cleanupConfirmed: true, message: null });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.stubGlobal('MediaStream', class { constructor(private tracks: MediaStreamTrack[]) {} getTracks() { return this.tracks; } });
});

describe('owned lifecycle deadlines and background cleanup', () => {
  it.each(['timeout', 'connected', 'ready'] as const)('bounds active transport reconnection and handles %s', async outcome => {
    const view = show(); await start(); ready();
    const events = sdk.options!.callbacks!;
    const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    vi.useFakeTimers();
    try {
      act(() => events.onTransportStateChanged!('connecting'));
      expect(panel().getByRole('status')).toHaveTextContent(/^Reconnecting$/);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      act(() => events.onTransportStateChanged!('connecting'));
      if (outcome === 'connected') act(() => events.onConnected!());
      else if (outcome === 'ready') act(() => events.onTransportStateChanged!('ready'));
      await act(async () => vi.advanceTimersByTimeAsync(settings.voiceStartupSeconds * 1000 - 1000));
      if (outcome === 'timeout') {
        expect(screen.getByRole('alert', { name: 'Connection timed out' })).toBeVisible();
        expect(microphone.stop).toHaveBeenCalled();
        expect(api.endCall).toHaveBeenCalledExactlyOnceWith(join.callId, expect.any(AbortSignal));
        expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
      } else {
        expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
        expect(microphone.stop).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
      }
      expect(api.startCall).toHaveBeenCalledOnce();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it.each(['response', 'before connect'] as const)('ends expired media credentials at %s without discarding the plan', async stage => {
    if (stage === 'response') vi.mocked(api.startCall).mockRejectedValueOnce(new ApiError(410, { code: 'callExpired', message: 'Call expired.' }));
    else vi.mocked(api.startCall).mockResolvedValueOnce({ ...join, expiresAt: new Date(Date.now() - 1).toISOString() });
    const view = show();
    await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    expect(await screen.findByRole('status', { name: 'Call expired' })).toHaveTextContent('saved figures');
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(api.endCall).toHaveBeenCalledExactlyOnceWith(join.callId, expect.any(AbortSignal));
    expect(view.onStarted).toHaveBeenCalledWith(snapshot());
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(screen.queryByText('Conversation unavailable')).not.toBeInTheDocument();
  });

  it('stops an expired active call without automatic token renewal or a replacement room', async () => {
    vi.useFakeTimers();
    const view = show();
    try {
      vi.mocked(api.startCall).mockResolvedValueOnce({ ...join, expiresAt: new Date(Date.now() + 30000).toISOString() });
      await act(async () => fireEvent.click(panel().getByRole('button', { name: 'Start talking' })));
      ready();
      const microphone = sdk.tracks().local.audio as MediaStreamTrack;
      await act(async () => vi.advanceTimersByTimeAsync(30000));
      expect(screen.getByRole('status', { name: 'Call expired' })).toBeVisible();
      expect(microphone.stop).toHaveBeenCalled();
      expect(api.startCall).toHaveBeenCalledOnce();
      expect(api.endCall).toHaveBeenCalledExactlyOnceWith(join.callId, expect.any(AbortSignal));
      expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it.each(['resolve', 'reject'] as const)('allows reconnect before permission settles and isolates its late %s', async settlement => {
    const devices = deferred<void>(); sdk.initDevices.mockReturnValueOnce(devices.promise);
    const view = show();
    await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    const events = sdk.options!.callbacks!;
    const onTrack = sdk.listeners.get(RTVIEvent.TrackStarted)!;
    const late = track();
    sdk.clients[0].tracks = () => ({ local: { audio: late } });
    const disconnect = vi.fn().mockResolvedValue(undefined); sdk.clients[0].disconnect = disconnect;
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    expect(late.stop).toHaveBeenCalled();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    vi.mocked(crypto.randomUUID).mockReturnValue('e2639293-b514-436d-b359-88637e030142');
    await start(); ready();
    await act(async () => { if (settlement === 'resolve') devices.resolve(); else devices.reject(new Error('Late permission')); });
    act(() => { events.onBotReady!({ version: '2.1' }); events.onDisconnected!(); onTrack(late, { ...remote, local: true }); });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(microphone.stop).not.toHaveBeenCalled();
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(api.startCall).toHaveBeenCalledExactlyOnceWith('e2639293-b514-436d-b359-88637e030142');
    expect(api.endCall).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('sends owned DELETE before a late room %s and never ends the replacement', async settlement => {
    const room = deferred<typeof join>(); vi.mocked(api.startCall).mockReturnValueOnce(room.promise);
    sdk.disconnect.mockReturnValueOnce(new Promise(() => undefined));
    show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(api.startCall).toHaveBeenCalledOnce());
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    expect(api.endCall).toHaveBeenCalledExactlyOnceWith(join.callId, expect.any(AbortSignal));
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    vi.mocked(crypto.randomUUID).mockReturnValue('e2639293-b514-436d-b359-88637e030142');
    await start(); ready();
    await act(async () => { if (settlement === 'resolve') room.resolve(join); else room.reject(new TypeError('Late room')); });
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(api.endCall).toHaveBeenCalledOnce();
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
  });

  it('disposes a late transport resolution on its own client after reconnect', async () => {
    const connection = deferred<void>(); sdk.connect.mockReturnValueOnce(connection.promise);
    show(); await start();
    const late = track(); sdk.clients[0].tracks = () => ({ local: { audio: late } });
    const disconnect = vi.fn().mockResolvedValue(undefined); sdk.clients[0].disconnect = disconnect;
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    await start(); ready();
    await act(async () => connection.resolve());
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(late.stop).toHaveBeenCalled(); expect(microphone.stop).not.toHaveBeenCalled();
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(api.endCall).toHaveBeenCalledOnce();
  });

  it.each(['devices', 'session', 'updates', 'room', 'transport', 'BotReady'] as const)('bounds hung %s using configured deadlines without claiming readiness', async stage => {
    const pending = new Promise<never>(() => undefined);
    if (stage === 'devices') sdk.initDevices.mockReturnValueOnce(pending);
    if (stage === 'session') vi.mocked(api.start).mockReturnValueOnce(pending);
    if (stage === 'room') vi.mocked(api.startCall).mockReturnValueOnce(pending);
    if (stage === 'transport') sdk.connect.mockReturnValueOnce(pending);
    const view = show({ updatesReady: stage !== 'updates' });
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(panel().getByRole('button', { name: 'Start talking' })));
      if (stage === 'BotReady') act(() => { sdk.options!.callbacks!.onConnected!(); sdk.options!.callbacks!.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 1 }); });
      const seconds = settings.voiceStartupSeconds + (stage === 'room' ? settings.voiceShutdownSeconds : 0);
      await act(async () => vi.advanceTimersByTimeAsync(seconds * 1000 - 1));
      expect(view.onPhaseChange).toHaveBeenLastCalledWith('connecting');
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByRole('alert', { name: 'Connection timed out' })).toBeVisible();
      expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
      expect(view.onPhaseChange).not.toHaveBeenCalledWith('active');
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('clears startup deadline only on BotReady and emits ordered non-sensitive timing marks', async () => {
    const view = show();
    vi.useFakeTimers();
    const marks = vi.spyOn(performance, 'mark');
    try {
      await act(async () => fireEvent.click(panel().getByRole('button', { name: 'Start talking' })));
      ready();
      await act(async () => vi.advanceTimersByTimeAsync(settings.voiceStartupSeconds * 2000));
      expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
      await act(async () => fireEvent.click(panel().getByRole('button', { name: 'End conversation' })));
      expect(marks.mock.calls.map(([name]) => name)).toEqual([
        'voice:start', 'voice:mic-request', 'voice:mic-ready', 'voice:setup-request', 'voice:setup-ready',
        'voice:join-request', 'voice:join-ready', 'voice:connect', 'voice:bot-ready', 'voice:end', 'voice:local-stop', 'voice:end-request', 'voice:end-confirmed',
      ]);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('bounds an unanswered DELETE, stops media immediately, and retries the same identity', async () => {
    const release = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValueOnce(release.promise);
    const view = show(); await start(); ready();
    const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    vi.useFakeTimers();
    try {
      act(() => fireEvent.click(panel().getByRole('button', { name: 'End conversation' })));
      expect(microphone.stop).toHaveBeenCalled();
      expect(screen.getByText('Your microphone is off. Confirming the call ended.')).toBeVisible();
      await act(async () => vi.advanceTimersByTimeAsync(settings.voiceShutdownSeconds * 1000));
      expect(screen.getByRole('alert', { name: 'Call ending not confirmed' })).toBeVisible();
      expect(vi.mocked(api.endCall).mock.calls[0][1]?.aborted).toBe(true);
      await act(async () => fireEvent.click(panel().getByRole('button', { name: 'Retry ending call' })));
      expect(api.endCall).toHaveBeenNthCalledWith(2, join.callId, expect.any(AbortSignal));
      expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
      await act(async () => release.resolve({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null }));
      expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it.each(['ending', 'ended', 'error'] as const)('requires explicit cleanup confirmation for a refreshed %s call', async status => {
    const callId = 'e2639293-b514-436d-b359-88637e030142';
    vi.mocked(api.call).mockResolvedValueOnce({ callId, status, cleanupConfirmed: false, message: null });
    show({ sessionId: snapshot().sessionId });
    await panel().findByRole('button', { name: 'Retry ending call' });
    expect(sdk.initDevices).not.toHaveBeenCalled();
    await userEvent.click(panel().getByRole('button', { name: 'Retry ending call' }));
    expect(api.endCall).toHaveBeenCalledExactlyOnceWith(callId, expect.any(AbortSignal));
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
  });

  it.each(['ending', 'ended', 'error'] as const)('does not treat an unconfirmed DELETE %s as safe to reconnect', async status => {
    vi.mocked(api.endCall).mockResolvedValueOnce({ callId: join.callId, status, cleanupConfirmed: false, message: null });
    show(); await start(); ready();
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    expect(panel().getByRole('button', { name: 'Retry ending call' })).toBeEnabled();
    expect(screen.getByRole('alert', { name: 'Call ending not confirmed' })).toBeVisible();
    expect(panel().queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('rejects mismatched join and termination identities without connecting', async () => {
    vi.mocked(api.startCall).mockResolvedValueOnce({ ...join, callId: 'e2639293-b514-436d-b359-88637e030142' });
    vi.mocked(api.endCall).mockResolvedValueOnce({ callId: 'e2639293-b514-436d-b359-88637e030142', status: 'ended', cleanupConfirmed: true, message: null });
    show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await panel().findByRole('button', { name: 'Retry ending call' });
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(api.endCall).toHaveBeenCalledExactlyOnceWith(join.callId, expect.any(AbortSignal));
  });

  it('bounds a hung refresh check and discovers its call ID before retrying termination', async () => {
    vi.mocked(api.call).mockReturnValueOnce(new Promise(() => undefined));
    vi.useFakeTimers();
    const view = show({ sessionId: snapshot().sessionId });
    try {
      await act(async () => vi.advanceTimersByTimeAsync(settings.voiceStartupSeconds * 1000));
      expect(panel().getByRole('button', { name: 'Retry ending call' })).toBeEnabled();
      expect(vi.mocked(api.call).mock.calls[0][0]?.aborted).toBe(true);
      vi.mocked(api.call).mockResolvedValueOnce({ callId: join.callId, status: 'ending', cleanupConfirmed: false, message: null });
      await act(async () => fireEvent.click(panel().getByRole('button', { name: 'Retry ending call' })));
      expect(api.endCall).toHaveBeenCalledExactlyOnceWith(join.callId, expect.any(AbortSignal));
      expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    } finally { view.unmount(); vi.useRealTimers(); }
  });
});

describe('Daily microphone acknowledgement', () => {
  const participant = (local = true): DailyEventObjectParticipant => ({ action: 'participant-updated',
    participant: { local, session_id: local ? 'consumer' : 'bot', audio: sdk.enabled } } as DailyEventObjectParticipant);

  it.each(['toggle', 'Continue'] as const)('refreshes %s only after local audio settles without track events', async action => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    sdk.enableMic.mockImplementation(() => undefined);
    const view = show(); await start(); ready();
    expect(sdk.dailyOn).toHaveBeenCalledOnce();
    const [event, acknowledge] = sdk.dailyOn.mock.lastCall!;
    expect(event).toBe('participant-updated');
    const tracks = [...sdk.listeners.entries()];
    if (action === 'toggle') {
      await userEvent.click(panel().getByRole('button', { name: 'Mute microphone' }));
      expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    } else {
      act(() => sdk.options!.callbacks!.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 1 }));
      expect(panel().getByRole('status')).toHaveTextContent(/^Paused$/);
    }
    expect(sdk.enableMic).toHaveBeenLastCalledWith(false);
    act(() => { sdk.enabled = false; Object.assign(microphone, { enabled: false }); acknowledge(participant()); });
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    if (action === 'toggle') await userEvent.click(panel().getByRole('button', { name: 'Unmute microphone' }));
    else {
      await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
      expect(sdk.enableMic).toHaveBeenCalledTimes(1);
      act(() => sdk.options!.callbacks!.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 2 }));
    }
    expect(sdk.enableMic).toHaveBeenLastCalledWith(true);
    expect(sdk.enabled).toBe(false);
    expect(panel().getByRole('status')).toHaveTextContent(/^Microphone muted$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    act(() => { sdk.enabled = true; Object.assign(microphone, { enabled: true }); acknowledge(participant(false)); });
    expect(panel().getByRole('status')).toHaveTextContent(/^Microphone muted$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    act(() => acknowledge(participant()));
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(panel().getByRole('button', { name: 'Mute microphone' })).toHaveAttribute('aria-pressed', 'false');
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'true');
    expect(sdk.tracks().local.audio).toBe(microphone);
    expect([...sdk.listeners.entries()]).toEqual(tracks);
    expect(sdk.connect).toHaveBeenCalledOnce(); expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(api.startCall).toHaveBeenCalledOnce();
    expect(sdk.disconnect).not.toHaveBeenCalled(); expect(sdk.destroy).not.toHaveBeenCalled();
  });

  it('unsubscribes before End completes and ignores queued participant events after End and a new attempt', async () => {
    const ending = deferred<void>(); sdk.disconnect.mockReturnValueOnce(ending.promise);
    const view = show(); await start(); ready();
    const [event, stale] = sdk.dailyOn.mock.lastCall!;
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    expect(sdk.dailyOff).toHaveBeenCalledExactlyOnceWith(event, stale);
    act(() => stale(participant()));
    expect(panel().getByRole('status')).toHaveTextContent(/^Conversation ended$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    await act(async () => ending.resolve());
    act(() => stale(participant()));
    expect(panel().getByRole('status')).toHaveTextContent(/^Conversation ended$/);
    sdk.enabled = false; sdk.tracks.mockReturnValue({ local: { audio: track() } });
    await start(); ready();
    expect(panel().getByRole('status')).toHaveTextContent(/^Microphone muted$/);
    act(() => { sdk.enabled = true; stale(participant()); });
    expect(panel().getByRole('status')).toHaveTextContent(/^Microphone muted$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    act(() => sdk.dailyOn.mock.lastCall![1](participant()));
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(sdk.dailyOn).toHaveBeenCalledTimes(2);
    expect(sdk.destroy).not.toHaveBeenCalled();
  });

  it('removes the same participant listener on unmount and ignores its queued event', async () => {
    const view = show(); await start(); ready();
    const [event, stale] = sdk.dailyOn.mock.lastCall!;
    view.unmount();
    expect(sdk.dailyOff).toHaveBeenCalledExactlyOnceWith(event, stale);
    const notifications = view.onPhaseChange.mock.calls.length;
    act(() => stale(participant()));
    expect(view.onPhaseChange).toHaveBeenCalledTimes(notifications);
    await waitFor(() => expect(sdk.disconnect).toHaveBeenCalledOnce());
    expect(sdk.destroy).not.toHaveBeenCalled();
  });
});

describe('server-controlled conversation waiting', () => {
  function state(state: 'active' | 'waiting', sequence: number) {
    act(() => sdk.options!.callbacks!.onServerMessage!({ type: 'conversation-state', state, sequence }));
  }

  it.each([false, true])('rejects late captions until Continue is acknowledged (pending: %s)', async continuing => {
    const view = show(); await start(); ready(); state('active', 1);
    const events = sdk.options!.callbacks!;
    act(() => events.onBotOutput!({ text: 'Your saved figures', segment_id: 1, spoken_status: 'in-progress',
      spoken_progress: { accumulated_text: 'Your saved figures', remaining_text: ' are ready.' } }));
    state('waiting', 2);
    if (continuing) await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    const transcript = structuredClone(view.transcript);
    act(() => {
      events.onUserTranscript!({ text: 'Delayed final', timestamp: 'late-final', user_id: 'me', final: true });
      events.onUserTranscript!({ text: 'Delayed interim', timestamp: 'late-interim', user_id: 'me', final: false });
      events.onBotOutput!({ text: 'Obsolete amount: 9000', segment_id: 2, spoken_status: 'completed' });
    });
    expect(view.transcript).toEqual(transcript);
    expect(screen.getByRole('region', { name: 'Live caption' })).toHaveTextContent('Your saved figures');
    if (!continuing) await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    state('active', 3);
    act(() => events.onBotOutput!({ text: 'Current response', segment_id: 3, spoken_status: 'completed' }));
    expect(screen.getByRole('region', { name: 'Live caption' })).toHaveTextContent('Current response');
    expect(sdk.connect).toHaveBeenCalledOnce(); expect(api.endCall).not.toHaveBeenCalled();
  });

  it('distinguishes an unfinished response from inactivity without claiming a connection failure', async () => {
    const view = show(); await start(); ready(); state('active', 1);
    act(() => sdk.options!.callbacks!.onServerMessage!({ type: 'conversation-state', state: 'waiting', sequence: 2, reason: 'response' }));
    expect(screen.getByText('The assistant did not finish a response. Continue to try again.')).toBeVisible();
    expect(panel().getByRole('status')).toHaveTextContent(/^Paused$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    expect(sdk.sendClientMessage).not.toHaveBeenCalled();
    expect(screen.queryByText(/check your connection/i)).not.toBeInTheDocument();
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    state('active', 3);
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(screen.queryByText('The assistant did not finish a response. Continue to try again.')).not.toBeInTheDocument();
  });

  it('keeps short pauses active and gates same-call Continue on a real active acknowledgment', async () => {
    const view = show(); await start(); ready(); await hear();
    const client = sdk.options;
    const events = sdk.options!.callbacks!;
    state('active', 1);
    act(() => {
      events.onUserTranscript!({ text: 'Rent is due tomorrow', final: true, timestamp: 'rent', user_id: 'me' });
      events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.7); events.onUserStoppedSpeaking!();
    });
    vi.useFakeTimers();
    try {
      act(() => vi.advanceTimersByTime(65_000));
      expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
      expect(panel().queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
    const stream = view.container.querySelector('audio')!.srcObject;
    state('waiting', 2);
    expect(panel().getByRole('status')).toHaveTextContent(/^Paused$/);
    expect(screen.getByText('Continue when you’re ready.')).toBeVisible();
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('active');
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(view.container.querySelector('.conversation')).toHaveAttribute('data-running', 'true');
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    expect(sdk.enabled).toBe(false);
    expect(view.container.querySelector('audio')!.muted).toBe(true);
    expect(view.container.querySelector('audio')!.srcObject).toBe(stream);
    expect(panel().queryByRole('button', { name: 'Unmute microphone' })).not.toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Continue' }).textContent).toBe('');
    expect(panel().getByRole('button', { name: 'Continue' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    act(() => {
      events.onUserStartedSpeaking!(); events.onBotStartedSpeaking!(); events.onBotLlmStarted!();
      events.onLLMFunctionCallInProgress!({ tool_call_id: 'waiting-tool' });
      events.onLocalAudioLevel!(1); events.onRemoteAudioLevel!(1, remote);
      fireEvent.pause(view.container.querySelector('audio')!);
      fireEvent.playing(view.container.querySelector('audio')!);
    });
    expectOrb('muted', 0, 'paused');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    state('active', 3);
    expect(sdk.enabled).toBe(false);
    expect(panel().getByRole('status')).toHaveTextContent(/^Paused$/);
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    expect(sdk.sendClientMessage).toHaveBeenCalledExactlyOnceWith('continue-conversation', { sequence: 2 });
    expect(panel().getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(panel().getByRole('button', { name: 'End conversation' })).toBeEnabled();
    expect(sdk.enabled).toBe(false);
    expect(panel().getByRole('status')).toHaveTextContent(/^Paused$/);
    state('active', 1); state('waiting', 2);
    expect(sdk.enabled).toBe(false);
    await act(async () => state('active', 3));
    expect(sdk.enabled).toBe(true);
    act(() => { events.onLLMFunctionCallInProgress!({ tool_call_id: 'active-tool' }); events.onLLMFunctionCallStopped!({ tool_call_id: 'active-tool', cancelled: false }); });
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(view.container.querySelector('audio')!.muted).toBe(false);
    expect(screen.getByText('Rent is due tomorrow')).toBeVisible();
    expect(sdk.options).toBe(client);
    expect(sdk.connect).toHaveBeenCalledOnce(); expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(api.start).toHaveBeenCalledOnce(); expect(api.startCall).toHaveBeenCalledOnce();
    expect(api.endCall).not.toHaveBeenCalled(); expect(sdk.disconnect).not.toHaveBeenCalled();
    state('waiting', 2);
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    act(() => events.onBotStartedSpeaking!());
    expect(panel().getByRole('status')).toHaveTextContent(/^Speaking$/);
  });

  it.each([null, [], 'waiting', {}, { type: 'other', state: 'waiting', sequence: 2 },
    { type: 'conversation-state', state: 'paused', sequence: 2 },
    ...[undefined, '2', 0, -1, 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(sequence => ({ type: 'conversation-state', state: 'waiting', sequence }))
  ])('ignores malformed or out-of-order server data %j', async data => {
    show(); await start(); ready(); state('active', 1);
    act(() => sdk.options!.callbacks!.onServerMessage!(data));
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(sdk.enableMic).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
  });

  it('does not acquire devices before a gesture or claim readiness from the initial server message', async () => {
    show(); expect(sdk.options).toBeNull(); expect(sdk.initDevices).not.toHaveBeenCalled();
    await start(); state('waiting', 2); state('active', 1);
    expect(panel().getByRole('status')).toHaveTextContent(/^Connecting$/);
    expect(sdk.enableMic).not.toHaveBeenCalled();
    ready(); expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    state('waiting', 2); expect(panel().getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it.each(['same', 'replacement', 'ended'] as const)('handles expected microphone stopping and resumes the %s track from SDK state', async kind => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    sdk.enableMic.mockImplementation(enabled => {
      sdk.enabled = enabled;
      Object.assign(microphone, { enabled });
      if (!enabled) {
        if (kind === 'ended') { Object.assign(microphone, { readyState: 'ended' }); microphone.dispatchEvent(new Event('ended')); }
        sdk.listeners.get(RTVIEvent.TrackStopped)!(microphone, { ...remote, local: true });
      }
    });
    show(); await start(); ready(); state('active', 1); state('waiting', 2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    const replacement = kind === 'same' ? microphone : track();
    sdk.tracks.mockReturnValue({ local: { audio: replacement } });
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    state('active', 3);
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    act(() => { sdk.options!.callbacks!.onUserStartedSpeaking!(); sdk.options!.callbacks!.onLocalAudioLevel!(0.6); });
    expectOrb('listening', 0.6, 'userSpeaking');
    expect(replacement.stop).not.toHaveBeenCalled();
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    expect(replacement.stop).toHaveBeenCalled();
    expect(api.endCall).toHaveBeenCalledOnce();
  });

  it('ignores a delayed expected stop of the persistent microphone but still fails on real device loss after resuming', async () => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    show(); await start(); ready(); state('active', 1); state('waiting', 2);
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    state('active', 3);
    act(() => sdk.listeners.get(RTVIEvent.TrackStopped)!(microphone, { ...remote, local: true }));
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(sdk.disconnect).not.toHaveBeenCalled();
    act(() => { Object.assign(microphone, { readyState: 'ended' }); microphone.dispatchEvent(new Event('ended')); });
    expect(await screen.findByRole('alert', { name: 'Microphone disconnected' })).toBeVisible();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
  });

  it('does not claim capture while the SDK replaces a stopped microphone after ACK', async () => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    show(); await start(); ready(); state('active', 1); state('waiting', 2);
    act(() => { Object.assign(microphone, { readyState: 'ended' }); microphone.dispatchEvent(new Event('ended')); });
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    state('active', 3);
    expect(panel().getByRole('status')).toHaveTextContent('Microphone not connected');
    expect(sdk.disconnect).not.toHaveBeenCalled();
    const replacement = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(replacement, { ...remote, local: true }));
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    act(() => sdk.listeners.get(RTVIEvent.TrackStopped)!(microphone, { ...remote, local: true }));
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
  });

  it.each(['bot first', 'track first'] as const)('preserves real playback and participant matching across waiting with %s', async order => {
    const view = show(); await start(); ready();
    if (order === 'bot first') act(() => sdk.options!.callbacks!.onBotConnected!(remote));
    const bot = await hear();
    if (order === 'track first') act(() => sdk.options!.callbacks!.onBotConnected!(remote));
    state('active', 1); state('waiting', 2);
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    await act(async () => state('active', 3));
    act(() => sdk.options!.callbacks!.onBotStartedSpeaking!());
    expect(panel().getByRole('status')).toHaveTextContent(/^Speaking$/);
    expect((view.container.querySelector('audio')!.srcObject as MediaStream).getTracks()).toEqual([bot]);
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(track(), { ...remote, id: 'other-participant' }));
    expect((view.container.querySelector('audio')!.srcObject as MediaStream).getTracks()).toEqual([bot]);
  });

  it('primes live playback in the Continue gesture but never claims Speaking when resumed playback is blocked', async () => {
    const view = show(); await start(); ready(); await hear(); state('active', 1); state('waiting', 2);
    vi.mocked(HTMLMediaElement.prototype.play).mockClear().mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(view.container.querySelector('audio')!.muted).toBe(true);
    expect(panel().queryByRole('button', { name: 'Resume audio' })).not.toBeInTheDocument();
    await act(async () => state('active', 3));
    act(() => sdk.options!.callbacks!.onBotStartedSpeaking!());
    expect(panel().getByRole('status')).toHaveTextContent('Assistant audio paused');
    expect(panel().getByRole('button', { name: 'Resume audio' })).toBeEnabled();
    expect(panel().getByRole('button', { name: 'Resume audio' }).textContent).toBe('');
    expect(panel().getByRole('button', { name: 'Resume audio' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expectOrb('muted', 0, 'paused');
    vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValue();
    await userEvent.click(panel().getByRole('button', { name: 'Resume audio' }));
    expect(panel().getByRole('status')).toHaveTextContent(/^Speaking$/);
  });

  it('offers same-sequence retry if sending Continue throws without ending or enabling the microphone', async () => {
    show(); await start(); ready(); state('active', 1); state('waiting', 2);
    sdk.sendClientMessage.mockImplementationOnce(() => { throw new Error('private transport message'); });
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('No response yet. Try Continue again.')).toBeVisible();
    expect(sdk.enabled).toBe(false); expect(sdk.disconnect).not.toHaveBeenCalled();
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    expect(sdk.sendClientMessage).toHaveBeenLastCalledWith('continue-conversation', { sequence: 2 });
    state('active', 3);
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
  });

  it('resynchronizes a Continue overtaken by a newer waiting sequence without enabling capture', async () => {
    show(); await start(); ready(); state('active', 1); state('waiting', 2);
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    state('waiting', 4); state('active', 3); state('active', 5);
    expect(sdk.enabled).toBe(false);
    expect(panel().getByRole('button', { name: 'Continue' })).toBeEnabled();
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    expect(sdk.sendClientMessage).toHaveBeenLastCalledWith('continue-conversation', { sequence: 4 });
    state('active', 5);
    expect(sdk.enabled).toBe(true);
    expect(api.startCall).toHaveBeenCalledOnce();
  });

  it('offers retry after a missing ACK without assuming active and accepts a delayed real ACK', async () => {
    const view = show(); await start(); ready(); state('active', 1); state('waiting', 2);
    vi.useFakeTimers();
    try {
      fireEvent.click(panel().getByRole('button', { name: 'Continue' }));
      act(() => vi.advanceTimersByTime(9999));
      expect(panel().getByRole('button', { name: 'Continue' })).toBeDisabled();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText('No response yet. Try Continue again.')).toBeVisible();
      expect(panel().getByRole('button', { name: 'Continue' })).toBeEnabled();
      expect(sdk.enabled).toBe(false);
      expect(panel().getByRole('status')).toHaveTextContent(/^Paused$/);
      fireEvent.click(panel().getByRole('button', { name: 'Continue' }));
      expect(sdk.sendClientMessage).toHaveBeenCalledTimes(2);
      expect(sdk.sendClientMessage).toHaveBeenLastCalledWith('continue-conversation', { sequence: 2 });
      state('active', 3);
      expect(sdk.enabled).toBe(true);
      act(() => vi.advanceTimersByTime(10_000));
      expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
      expect(screen.queryByText('No response yet. Try Continue again.')).not.toBeInTheDocument();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it.each([false, true])('ends waiting safely and ignores late ACKs even after another attempt (pending: %s)', async pending => {
    show(); await start(); ready(); state('active', 1); state('waiting', 2);
    const callbacks = sdk.options!.callbacks!;
    if (pending) await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    expect(panel().getByRole('status')).toHaveTextContent(/^Conversation ended$/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    act(() => callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 3 }));
    expect(sdk.enabled).toBe(false);
    await start(); ready(); state('active', 1); state('waiting', 2);
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    act(() => callbacks.onServerMessage!({ type: 'conversation-state', state: 'active', sequence: 5 }));
    expect(panel().getByRole('status')).toHaveTextContent(/^Paused$/);
    expect(sdk.enabled).toBe(false);
    state('active', 3);
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(api.startCall).toHaveBeenCalledTimes(2);
  });

  it.each([{ updatesLost: true }, { sessionIssue: 'expired' as const }, { sessionId: 'other-session' }])('preserves financial safety while waiting: %j', async change => {
    const view = show(); await start(); ready(); state('active', 1); state('waiting', 2);
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    view.change(change);
    state('active', 3);
    await waitFor(() => expect(sdk.disconnect).toHaveBeenCalledOnce());
    expect(sdk.enabled).toBe(false);
    expect(panel().queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  it('distinguishes recoverable RTVI errors from fatal failures and normal waiting', async () => {
    show(); await start(); ready(); state('active', 1);
    const error = { label: 'rtvi-ai', id: 'error', type: 'error', data: { error: 'private provider details', fatal: false } };
    act(() => sdk.options!.callbacks!.onError!(error));
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(sdk.disconnect).not.toHaveBeenCalled();
    state('waiting', 2);
    await userEvent.click(panel().getByRole('button', { name: 'Continue' }));
    act(() => sdk.options!.callbacks!.onError!(error));
    expect(panel().getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(sdk.enabled).toBe(false);
    expect(sdk.disconnect).not.toHaveBeenCalled();
    act(() => sdk.options!.callbacks!.onError!({ ...error, data: { ...error.data, fatal: true } }));
    expect(await screen.findByRole('alert', { name: 'Conversation stopped' })).toBeVisible();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(screen.queryByText('private provider details')).not.toBeInTheDocument();
  });
});

describe('release recovery: owned audio and financial safety', () => {
  it('immediately silences current speech and capture on lost updates, ignores late SDK events, and requires explicit restart', async () => {
    const release = deferred<Awaited<ReturnType<typeof api.endCall>>>();
    vi.mocked(api.endCall).mockReturnValueOnce(release.promise);
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    const view = show(); await start(); ready(); const remoteTrack = await hear();
    const events = sdk.options!.callbacks!;
    act(() => events.onBotStartedSpeaking!());
    expect(panel().getByRole('status')).toHaveTextContent(/^Speaking$/);
    view.change({ updatesLost: true, disabled: true });
    expect(microphone.stop).toHaveBeenCalled();
    expect(remoteTrack.stop).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(view.container.querySelector('audio')!.srcObject).toBeNull();
    act(() => { events.onBotReady!({ version: '2.1.0' }); events.onBotOutput!({ text: 'Stale advice', spoken_status: 'completed' }); });
    expect(screen.queryByText('Stale advice')).not.toBeInTheDocument();
    const late = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(late, remote));
    expect(late.stop).toHaveBeenCalledOnce();
    await act(async () => release.resolve({ callId: join.callId, status: 'ended', cleanupConfirmed: true, message: null }));
    expect(screen.queryByRole('status', { name: 'Conversation stopped' })).not.toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    view.change({ updatesLost: false, disabled: false });
    expect(screen.getByRole('status', { name: 'Conversation stopped' })).toHaveTextContent('Your microphone is off.');
    expect(api.startCall).toHaveBeenCalledOnce();
    await userEvent.click(panel().getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(api.startCall).toHaveBeenCalledTimes(2));
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(sdk.destroy).not.toHaveBeenCalled();
  });

  it.each([false, true])('waits for first financial snapshot before creating a room and supports ending that wait (end: %s)', async end => {
    const view = show({ updatesReady: false });
    await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(view.onStarted).toHaveBeenCalledOnce());
    expect(api.startCall).not.toHaveBeenCalled();
    if (end) {
      await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
      await waitFor(() => expect(sdk.disconnect).toHaveBeenCalledOnce());
    }
    view.change({ updatesReady: true, sessionId: snapshot().sessionId });
    if (end) expect(api.startCall).not.toHaveBeenCalled();
    else await waitFor(() => expect(api.startCall).toHaveBeenCalledOnce());
  });
});

describe('real SDK integration boundary', () => {
  it('prepares without microphone access and keeps the audio element mounted across presentations', async () => {
    function Journey() {
      const [presentation, setPresentation] = useState<'landing' | 'ready' | 'session'>('landing');
      return <><Conversation settings={{ ...settings, voiceAvailable: true }} disabled={false} presentation={presentation}
        onPrepare={() => setPresentation('ready')} onPhaseChange={(phase) => { if (phase === 'connecting') setPresentation('session'); }}
        onStarted={vi.fn()} onBusyChange={vi.fn()} onSettings={vi.fn()} /><ToastViewport /></>;
    }
    const view = render(<Journey />);
    const player = view.container.querySelector('audio');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(screen.getByRole('heading', { name: 'Your conversation' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/^Ready when you are$/);
    expect(screen.queryByText('By connecting, you share audio with the assistant.')).not.toBeInTheDocument();
    expect(screen.getByText('Captions appear here')).toBeVisible();
    const hooks = ['.conversation', '#conversation-heading', '.call-header', '.voice-status-panel', '.voice-status-copy', '.voice-status-hint', '.conversation-controls', '.live-caption'];
    const regions = hooks.map(selector => view.container.querySelector(selector));
    for (const region of regions) expect(region).not.toBeNull();
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    expect(screen.getByRole('img', { name: 'Ready when you are' })).toHaveAttribute('data-state', 'idle');
    expect(view.container.querySelector('.voice-emblem, .voice-feedback, .voice-notice')).toBeNull();
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(sdk.options).toBeNull();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(view.container.querySelector('audio')).toBe(player);
    await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
    expect(screen.getByRole('heading', { name: 'Your conversation' })).toBeVisible();
    expect(view.container.querySelector('audio')).toBe(player);
    expect(screen.getByRole('status')).toHaveTextContent(/^Connecting$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    hooks.forEach((selector, index) => expect(view.container.querySelector(selector)).toBe(regions[index]));
    ready();
    expect(screen.getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'true');
    hooks.forEach((selector, index) => expect(view.container.querySelector(selector)).toBe(regions[index]));
    expect(view.container.querySelector('details, summary')).toBeNull();
  });
  it.each(['ready', 'session'] as const)('keeps %s limited to the orb, current caption and accessible call controls without starting devices', (presentation) => {
    const view = show({ presentation });
    expect(screen.getByRole('heading', { name: 'Your conversation' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/^Ready when you are$/);
    expect(screen.getByRole('region', { name: 'Live caption' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Captions appear here')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Conversation transcript' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Conversation captions' })).not.toBeInTheDocument();
    expect(view.container.querySelector('details, summary, .caption-history, .caption-history-scroll, .voice-more')).toBeNull();
    expect(view.container).not.toHaveTextContent(/camera|English|microphone off|Pipecat|Daily|Azure|API_KEY|provider|Voice and AI services/i);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/Figures kept/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Privacy' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    const start = screen.getByRole('button', { name: 'Start talking' });
    expect(start.textContent).toBe('');
    expect(start.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(view.transcript).toEqual({ captions: [], interim: null });
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });
  it('allows unavailable landing preparation without exposing setup diagnostics', async () => {
    const view = show({ presentation: 'landing', settings: { ...settings, voiceAvailable: false, voiceUnavailableReason: 'DAILY_API_KEY private operator diagnostic' } });
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(view.onPrepare).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(view.container.querySelector('.notice, .voice-notice')).toBeNull();
    expect(view.container).not.toHaveTextContent(/DAILY|API_KEY|operator/);
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
  });
  it.each([{ settings: null }, { disabled: true }, { sessionIssue: 'unauthorized' as const }])('disables landing preparation when settings are loading or the parent locks it: %j', async (props) => {
    const view = show({ presentation: 'landing', ...props });
    const button = screen.getByRole('button', { name: 'Start conversation' });
    expect(button).toBeDisabled(); await userEvent.click(button);
    expect(view.onPrepare).not.toHaveBeenCalled(); expect(sdk.initDevices).not.toHaveBeenCalled();
  });
  it('refreshes unavailable settings safely without starting devices or a call', async () => {
    const result = { ...settings, voiceAvailable: true };
    const refresh = vi.spyOn(api, 'settings').mockRejectedValueOnce(new Error('AZURE private details')).mockResolvedValueOnce(result);
    const view = show({ presentation: 'ready', settings: { ...settings, voiceAvailable: false, voiceUnavailableReason: 'DAILY_API_KEY' } });
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled();
    expect(panel().getByRole('status')).toHaveTextContent('Conversations unavailable');
    expect(panel().getByRole('button', { name: 'Check availability' }).textContent).toBe('');
    expect(panel().getByRole('button', { name: 'Check availability' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await userEvent.click(panel().getByRole('button', { name: 'Check availability' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check availability. Check your connection and try again.');
    expect(view.container).not.toHaveTextContent(/AZURE|DAILY|API_KEY|operator/);
    await userEvent.click(panel().getByRole('button', { name: 'Check availability' }));
    expect(refresh).toHaveBeenCalledTimes(2); expect(view.onSettings).toHaveBeenCalledWith(result);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });
  it('ignores an availability response after unmount', async () => {
    const refresh = deferred<typeof settings>();
    const request = vi.spyOn(api, 'settings').mockReturnValue(refresh.promise);
    const view = show({ presentation: 'ready', settings: { ...settings, voiceAvailable: false } });
    await userEvent.click(screen.getByRole('button', { name: 'Check availability' }));
    expect(screen.getByRole('button', { name: 'Checking availability…' })).toBeDisabled();
    view.unmount(); expect(request.mock.calls[0][0]!.aborted).toBe(true);
    await act(async () => refresh.resolve(settings));
    expect(view.onSettings).not.toHaveBeenCalled();
  });
  it('does not claim listening without a local track and stops when its replacement disconnects', async () => {
    const audio = undefined;
    sdk.tracks.mockReturnValue({ local: { audio } });
    show(); await start(); ready();
    expect(screen.getByRole('status')).toHaveTextContent('Microphone not connected');
    act(() => sdk.options!.callbacks!.onUserStartedSpeaking!());
    expect(screen.getByRole('status')).not.toHaveTextContent(/Listening|listening/);
    const microphone = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(microphone, { ...remote, local: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Listening to you');
    act(() => sdk.listeners.get(RTVIEvent.TrackStopped)!(microphone, { ...remote, local: true }));
    expect(await screen.findByRole('alert', { name: 'Microphone disconnected' })).toHaveTextContent('Reconnect your microphone');
    expect(sdk.disconnect).toHaveBeenCalledOnce();
  });
  it('responds to local device ending without a transport stop event and ignores remote/video readiness', async () => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    show(); await start(); ready();
    expect(screen.getByRole('status')).toHaveTextContent('Listening');
    await act(async () => {
      Object.assign(microphone, { readyState: 'ended' }); microphone.dispatchEvent(new Event('ended'));
      sdk.listeners.get(RTVIEvent.TrackStarted)!(track('video'), { ...remote, local: true });
      sdk.listeners.get(RTVIEvent.TrackStarted)!(track(), remote);
    });
    expect(await screen.findByRole('alert', { name: 'Microphone disconnected' })).toHaveTextContent('conversation has stopped');
    expect(sdk.disconnect).toHaveBeenCalledOnce();
  });
  it('uses connection events rather than resolved promises to claim a connection', async () => {
    const view = show(); await start();
    expect(screen.getByRole('status')).toHaveTextContent(/^Connecting$/);
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('connecting');
    act(() => sdk.options!.callbacks!.onConnected!());
    expect(screen.getByRole('status')).toHaveTextContent(/^Connecting to assistant$/);
    expect(screen.getByRole('img', { name: 'Connecting to assistant' })).toHaveAttribute('data-state', 'connecting');
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
    ready(); expect(view.onPhaseChange).toHaveBeenLastCalledWith('active');
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await waitFor(() => expect(view.onPhaseChange).toHaveBeenLastCalledWith('ended'));
    expect(view.onPhaseChange.mock.calls.map(([phase]) => phase)).toEqual(['idle', 'connecting', 'active', 'ending', 'ended']);
    expect(view.onStarted).toHaveBeenCalledOnce();
  });
  it('gives actual interruption precedence and preserves spoken prefixes against late output', async () => {
    show(); await start(); ready(); await hear();
    const events = sdk.options!.callbacks!;
    act(() => {
      events.onBotStartedSpeaking!();
      events.onBotOutput!({ text: 'First words never spoken tail', segment_id: 7, will_be_spoken: true, spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'First words', remaining_text: 'never spoken tail' } });
      events.onUserStartedSpeaking!();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Interrupted · listening');
    expect(screen.getByText('Go ahead')).toBeVisible();
    act(() => {
      events.onBotStoppedSpeaking!();
      events.onBotOutput!({ text: 'First words never spoken tail', segment_id: 7, will_be_spoken: true, spoken_status: 'completed' });
    });
    expect(screen.getByText('First words')).toBeVisible();
    expect(screen.queryByText('First words never spoken tail')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Interrupted · listening');
    act(() => events.onUserStoppedSpeaking!());
    expect(screen.getByRole('status')).toHaveTextContent(/^Listening$/);
    await userEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(screen.getByText('Unmute to speak')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument();
  });
  it('tracks overlapping real tool operations without inventing thinking after a user turn', async () => {
    show(); await start(); ready(); const events = sdk.options!.callbacks!;
    act(() => { events.onUserStartedSpeaking!(); events.onUserStoppedSpeaking!(); });
    expect(screen.getByRole('status')).toHaveTextContent(/^Listening$/);
    act(() => {
      events.onLLMFunctionCallStarted!({ function_name: 'read_state' });
      events.onLLMFunctionCallInProgress!({ tool_call_id: 'one' });
      events.onLLMFunctionCallInProgress!({ tool_call_id: 'two' });
      events.onLLMFunctionCallStopped!({ tool_call_id: 'one', cancelled: false });
    });
    expect(screen.getByRole('status')).toHaveTextContent(/^Thinking$/);
    act(() => events.onLLMFunctionCallStopped!({ tool_call_id: 'two', cancelled: true }));
    expect(screen.getByRole('status')).toHaveTextContent(/^Listening$/);
  });
  it('publishes every finalized caption while showing only live speech without embedded history', async () => {
    const view = show(); await start(); ready(); const events = sdk.options!.callbacks!;
    const end = screen.getByRole('button', { name: 'End conversation' }); end.focus();
    act(() => {
      for (let index = 0; index < 29; index++) events.onUserTranscript!({ text: `Figure ${index}`, final: true, timestamp: String(index), user_id: 'me' });
      events.onUserTranscript!({ text: 'Unfinished words', final: false, timestamp: '30', user_id: 'me' });
      events.onBotOutput!({ text: 'Generated, not spoken', will_be_spoken: false, spoken_status: 'completed' });
      events.onBotOutput!({ text: 'Unknown speech status' });
    });
    expect(view.transcript.captions.map(item => item.text)).toEqual(Array.from({ length: 29 }, (_, index) => `Figure ${index}`));
    expect(view.transcript.interim).toEqual({ text: 'Unfinished words', time: expect.any(Number) });
    expect(screen.queryByText('Figure 0')).not.toBeInTheDocument(); expect(screen.queryByText('Figure 28')).not.toBeInTheDocument();
    expect(screen.getByText('Unfinished words')).toBeVisible();
    expect(screen.queryByText('Generated, not spoken')).not.toBeInTheDocument(); expect(screen.queryByText('Unknown speech status')).not.toBeInTheDocument();
    expect(end).toHaveFocus();
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Unfinished words')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Conversation transcript', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Conversation captions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    act(() => events.onUserTranscript!({ text: 'Finished words', final: true, timestamp: '30', user_id: 'me' }));
    expect(view.transcript.captions.map(item => item.text)).toEqual([...Array.from({ length: 29 }, (_, index) => `Figure ${index}`), 'Finished words']);
    expect(view.transcript.interim).toBeNull();
    expect(screen.queryByText('Unfinished words')).not.toBeInTheDocument();
    expect(screen.getAllByText('Finished words')).toHaveLength(1);
    expect(end).toHaveFocus();
  });
  it('keeps controls and console regions in place through speech, captions, mute and errors', async () => {
    const view = show(); await start(); ready(); await hear();
    const panel = view.container.querySelector<HTMLElement>('.conversation')!;
    const regions = Array.from(panel.children);
    const controls = view.container.querySelector('.conversation-controls')!;
    const end = screen.getByRole('button', { name: 'End conversation' });
    expect(end.textContent).toBe('');
    expect(end.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const mute = screen.getByRole('button', { name: 'Mute microphone' });
    expect(mute.textContent).toBe('');
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    expect(mute.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const live = screen.getByRole('region', { name: 'Live caption' });
    const events = sdk.options!.callbacks!;
    end.focus();
    act(() => {
      events.onBotLlmStarted!();
      events.onUserTranscript!({ text: 'My salary', final: false, timestamp: 'one', user_id: 'me' });
    });
    expect(screen.getByRole('status')).toHaveTextContent(/^Thinking$/);
    expect(end).toHaveFocus();
    act(() => {
      events.onBotLlmStopped!(); events.onBotStartedSpeaking!();
      for (let index = 0; index < 6; index++) events.onUserTranscript!({ text: `Amount ${index}`, final: true, timestamp: String(index), user_id: 'me' });
    });
    expect(screen.getByRole('status')).toHaveTextContent(/^Speaking$/);
    expect(screen.getByText('Speak to interrupt')).toBeVisible();
    expect(within(live).getByText('Amount 5')).toBeVisible();
    expect(view.transcript.captions.map(item => item.text)).toEqual(Array.from({ length: 6 }, (_, index) => `Amount ${index}`));
    expect(screen.queryByRole('list', { name: 'Conversation transcript' })).not.toBeInTheDocument();
    expect(end).toHaveFocus();
    regions.forEach((region, index) => expect(panel.children[index]).toBe(region));
    act(() => { events.onBotStoppedSpeaking!(); events.onUserStartedSpeaking!(); });
    expect(screen.getByRole('status')).toHaveTextContent(/^Listening to you$/);
    await userEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(screen.getByRole('button', { name: 'Unmute microphone' })).toBe(mute);
    expect(mute.textContent).toBe('');
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Unmute to speak')).toBeVisible();
    expect(screen.getByRole('button', { name: 'End conversation' })).toBe(end);
    expect(view.container.querySelector('.conversation-controls')).toBe(controls);
    expect(screen.getByRole('region', { name: 'Live caption' })).toBe(live);
    regions.forEach((region, index) => expect(panel.children[index]).toBe(region));
    act(() => events.onError!({ label: 'rtvi-ai', id: 'error', type: 'error', data: { error: 'private details', fatal: true } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The assistant could not continue. Check your connection and try again.');
    expect(screen.getByRole('status')).toHaveTextContent(/^Unable to connect$/);
    expect(within(panel).getByRole('button', { name: 'Reconnect' }).textContent).toBe('');
    expect(within(panel).getByRole('button', { name: 'Reconnect' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(view.container.querySelector('.voice-status-hint')).toBeEmptyDOMElement();
    regions.forEach((region, index) => expect(panel.children[index]).toBe(region));
    expect(view.container.querySelector('details, summary')).toBeNull();
    expect(view.container.querySelector('.voice-feedback, .voice-notice, .notice')).toBeNull();
    expect(view.container).not.toHaveTextContent(/camera|English|Pipecat|Daily|Azure|provider|private details/i);
  });
  it('keeps starting locked until a previous call is checked or its termination confirmed', async () => {
    const call = deferred<Awaited<ReturnType<typeof api.call>>>(); vi.mocked(api.call).mockReturnValue(call.promise);
    const view = show({ sessionId: snapshot().sessionId });
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => call.reject(new Error('private request diagnostic')));
    expect(panel().getByRole('button', { name: 'Retry ending call' })).toBeEnabled();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true);
    vi.mocked(api.call).mockResolvedValue({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null });
    await userEvent.click(panel().getByRole('button', { name: 'Retry ending call' }));
    await waitFor(() => expect(view.onBusyChange).toHaveBeenLastCalledWith(false));
    expect(sdk.initDevices).not.toHaveBeenCalled();
  });
  it('does not overlap a conflicting existing room and keeps it busy until explicitly ended', async () => {
    vi.mocked(api.startCall).mockRejectedValue(new ApiError(409, { code: 'callExists', message: 'private conflict' }));
    const view = show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await panel().findByRole('button', { name: 'Retry ending call' });
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(api.endCall).not.toHaveBeenCalled(); expect(sdk.connect).not.toHaveBeenCalled();
    vi.mocked(api.call).mockResolvedValue({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null });
    await userEvent.click(panel().getByRole('button', { name: 'Retry ending call' }));
    await waitFor(() => expect(view.onBusyChange).toHaveBeenLastCalledWith(false));
  });
  it('permits retry without invoking forbidden teardown when SDK construction fails before device setup', async () => {
    sdk.constructionError = new Error('Synthetic construction failure');
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    expect(within(await screen.findByRole('alert', { name: 'Could not connect' })).getByText('Check your connection and microphone, then try again.')).toBeVisible();
    expect(sdk.destroy).not.toHaveBeenCalled(); expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
  });
  it('requests devices from the click before session/room creation and waits for BotReady, not connect resolution', async () => {
    const devices = deferred<void>(); sdk.initDevices.mockReturnValue(devices.promise);
    const view = show();
    expect(sdk.options).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    expect(sdk.options).toMatchObject({ enableMic: true, enableCam: false });
    expect(sdk.transportOptions).toEqual({ bufferLocalAudioUntilBotReady: false, dailyConfig: { avoidEval: true } });
    expect(api.startCall).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
    await act(async () => devices.resolve());
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledWith({ url: join.url, token: join.token }));
    expect(view.onStarted).toHaveBeenCalledWith(snapshot());
    expect(screen.getByText('Connecting', { exact: true })).toBeVisible();
    act(() => sdk.options!.callbacks!.onTransportStateChanged!('ready'));
    expect(screen.queryByText('Listening', { exact: true })).not.toBeInTheDocument();
    ready(); expect(screen.getByText('Listening', { exact: true })).toBeVisible();
    expect(vi.mocked(api.start).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.startCall).mock.invocationCallOrder[0]);
  });
  it('attaches only remote audio, handles autoplay rejection and resumes with a user gesture', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('Autoplay blocked', 'NotAllowedError'));
    const view = show(); await start(); ready();
    const player = view.container.querySelector('audio')!;
    const local = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(local, { ...remote, local: true }));
    expect(player.srcObject).toBeFalsy();
    const bot = track();
    await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(bot, remote));
    act(() => sdk.options!.callbacks!.onBotStartedSpeaking!());
    expect(panel().getByRole('status')).toHaveTextContent('Assistant audio paused');
    expect((player.srcObject as MediaStream).getTracks()).toEqual([bot]);
    await userEvent.click(await panel().findByRole('button', { name: 'Resume audio' }));
    expect(screen.queryByRole('button', { name: 'Resume audio' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^Speaking$/);
    act(() => sdk.listeners.get(RTVIEvent.TrackStopped)!(bot, remote));
    expect(player.srcObject).toBeNull();
  });
  it('uses actual speaking/generation events, separates interim text, and excludes unspoken model output', async () => {
    const view = show(); await start(); ready(); await hear();
    const events = sdk.options!.callbacks!;
    act(() => events.onUserStartedSpeaking!()); expect(screen.getByText('Listening to you')).toBeVisible();
    act(() => events.onUserStoppedSpeaking!()); expect(screen.getByText('Listening', { exact: true })).toBeVisible();
    act(() => events.onBotLlmStarted!()); expect(screen.getByText('Thinking')).toBeVisible();
    act(() => events.onBotLlmStopped!()); expect(screen.getByText('Listening', { exact: true })).toBeVisible();
    act(() => events.onUserTranscript!({ text: 'I have', final: false, timestamp: 'one', user_id: 'me' }));
    expect(screen.getByText('I have')).toBeVisible();
    expect(view.transcript).toEqual({ captions: [], interim: { text: 'I have', time: expect.any(Number) } });
    act(() => events.onUserTranscript!({ text: 'I have 500 rupees.', final: true, timestamp: 'one', user_id: 'me' }));
    expect(screen.queryByText('I have', { exact: true })).not.toBeInTheDocument();
    expect(view.transcript.interim).toBeNull();
    act(() => events.onBotOutput!({ text: 'Unspoken generated answer', segment_id: 1, will_be_spoken: true, spoken_status: 'new' }));
    expect(screen.queryByText('Unspoken generated answer')).not.toBeInTheDocument();
    act(() => { events.onBotStartedSpeaking!(); events.onBotOutput!({ text: 'Full future sentence', segment_id: 1, will_be_spoken: true, spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Let’s check', remaining_text: 'the bills.' } }); });
    expect(screen.getByText('Speaking')).toBeVisible(); expect(screen.getByText('Let’s check')).toBeVisible();
    expect(screen.queryByText('Full future sentence')).not.toBeInTheDocument();
    act(() => events.onBotOutput!({ text: 'Let’s check the bills.', segment_id: 1, will_be_spoken: true, spoken_status: 'completed' }));
    expect(view.transcript.captions).toEqual([
      expect.objectContaining({ speaker: 'You', text: 'I have 500 rupees.' }),
      expect.objectContaining({ speaker: 'Assistant', text: 'Let’s check the bills.', pending: false }),
    ]);
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Let’s check the bills.')).toBeVisible();
    act(() => events.onBotStoppedSpeaking!());
    await userEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(sdk.enableMic).toHaveBeenCalledWith(false); expect(screen.getByText('Microphone muted')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Unmute microphone' }));
    expect(sdk.enableMic).toHaveBeenCalledWith(true);
  });
  it('stops tracks, disconnects through Pipecat and ends the backend call on explicit end', async () => {
    const view = show(); await start(); ready(); const bot = track();
    await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(bot, remote));
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await screen.findByText('Conversation ended', { exact: true });
    expect(bot.stop).toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledTimes(1); expect(sdk.destroy).not.toHaveBeenCalled(); expect(api.endCall).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('audio')!.srcObject).toBeNull();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(view.container.querySelector('.voice-status-hint')).toBeEmptyDOMElement();
    expect(screen.getByText('Captions appear here')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Conversation transcript' })).not.toBeInTheDocument();
    act(() => sdk.options!.callbacks!.onBotReady!({ version: '2.1' }));
    expect(screen.getByText('Conversation ended', { exact: true })).toBeVisible();
  });
  it('does not create a provider room after microphone denial', async () => {
    sdk.initDevices.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    expect(within(await screen.findByRole('status', { name: 'Microphone access denied' })).getByText('Allow microphone access in your browser’s site settings, then try again.')).toBeVisible();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
  });
  it.each(['throw', 'reject'] as const)('preserves the device error and unlocks retry when cleanup fails by %s', async (failure) => {
    sdk.initDevices.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const error = new Error('Synthetic teardown failure');
    if (failure === 'throw') sdk.disconnect.mockImplementationOnce(() => { throw error; });
    else sdk.disconnect.mockRejectedValueOnce(error);
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    const view = show();
    await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    expect(within(await screen.findByRole('status', { name: 'Microphone access denied' })).getByText('Allow microphone access in your browser’s site settings, then try again.')).toBeVisible();
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('error');
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(microphone.stop).toHaveBeenCalled(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
    await start(); ready();
    expect(screen.getByRole('status')).toHaveTextContent(/^Listening$/);
  });
  it.each(['throw', 'reject'] as const)('releases the backend room despite a disconnect %s', async (failure) => {
    const view = show(); await start(); ready();
    const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    const error = new Error('Synthetic teardown failure');
    if (failure === 'throw') sdk.disconnect.mockImplementationOnce(() => { throw error; });
    else sdk.disconnect.mockRejectedValueOnce(error);
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await screen.findByText('Conversation ended', { exact: true });
    expect(microphone.stop).toHaveBeenCalled(); expect(api.endCall).toHaveBeenCalledOnce();
    expect(sdk.destroy).not.toHaveBeenCalled(); expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it('stops retained tracks and reports a setup failure even when SDK track access throws', async () => {
    const devices = deferred<void>(); sdk.initDevices.mockReturnValue(devices.promise);
    const view = show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    const microphone = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(microphone, { ...remote, local: true }));
    sdk.tracks.mockImplementation(() => { throw new Error('Synthetic track access failure'); });
    await act(async () => devices.reject(new DOMException('Denied', 'NotAllowedError')));
    expect(within(await screen.findByRole('status', { name: 'Microphone access denied' })).getByText('Allow microphone access in your browser’s site settings, then try again.')).toBeVisible();
    expect(microphone.stop).toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false); expect(api.start).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'] as const)('disconnects after pending devices %s and stops late SDK tracks without events', async (settlement) => {
    const devices = deferred<void>(); sdk.initDevices.mockReturnValue(devices.promise);
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    expect(sdk.disconnect).not.toHaveBeenCalled();
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    await act(async () => { if (settlement === 'resolve') devices.resolve(); else devices.reject(new Error('Synthetic setup failure')); });
    await screen.findByText('Conversation ended', { exact: true });
    expect(microphone.stop).toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(vi.mocked(microphone.stop).mock.invocationCallOrder[0]).toBeLessThan(sdk.disconnect.mock.invocationCallOrder[0]);
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled(); expect(sdk.destroy).not.toHaveBeenCalled();
  });
  it('cancels pending device permission without creating a session and stops a late track', async () => {
    const devices = deferred<void>(); sdk.initDevices.mockReturnValue(devices.promise);
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    const late = track(); act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(late, { ...remote, local: true }));
    await act(async () => devices.resolve());
    await screen.findByText('Conversation ended', { exact: true });
    expect(late.stop).toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });
  it('releases a pending room by identity without waiting for its response', async () => {
    const room = deferred<typeof join>(); vi.mocked(api.startCall).mockReturnValue(room.promise);
    const view = show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(api.startCall).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(api.endCall).toHaveBeenCalledWith(join.callId, expect.any(AbortSignal));
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('ended');
    await act(async () => room.resolve(join));
    await screen.findByText('Conversation ended', { exact: true });
    expect(sdk.connect).not.toHaveBeenCalled(); expect(api.endCall).toHaveBeenCalledTimes(1);
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it('cleans up on unmount while a room is pending', async () => {
    const room = deferred<typeof join>(); vi.mocked(api.startCall).mockReturnValue(room.promise);
    const view = show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(api.startCall).toHaveBeenCalled()); view.unmount();
    await act(async () => room.resolve(join));
    await waitFor(() => expect(api.endCall).toHaveBeenCalledTimes(1)); expect(sdk.connect).not.toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
  });
  it.each([false, true])('stops local tracks synchronously on pagehide (cached: %s) and cleans the attempt listener', async (persisted) => {
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const leaving = deferred<void>(); sdk.disconnect.mockReturnValue(leaving.promise);
    const view = show();
    expect(addListener.mock.calls.filter(([name]) => name === 'pagehide')).toHaveLength(0);
    act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted })));
    expect(sdk.disconnect).not.toHaveBeenCalled();
    await start(); ready();
    const microphone = track(); const device = track(); const bot = track();
    sdk.tracks.mockReturnValue({ local: { audio: device } });
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(microphone, { ...remote, local: true }));
    await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(bot, remote));
    const listener = addListener.mock.calls.find(([name]) => name === 'pagehide')![1];
    act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted })));
    expect(microphone.stop).toHaveBeenCalled(); expect(device.stop).toHaveBeenCalled(); expect(bot.stop).toHaveBeenCalled();
    expect(view.container.querySelector('audio')!.srcObject).toBeNull();
    expect(removeListener).toHaveBeenCalledWith('pagehide', listener);
    expect(sdk.destroy).not.toHaveBeenCalled();
    await act(async () => leaving.resolve());
    await screen.findByText('Disconnected', { exact: true });
    expect(api.endCall).toHaveBeenCalledTimes(1); expect(sdk.destroy).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted })));
    view.unmount(); expect(sdk.disconnect).toHaveBeenCalledTimes(1);
  });
  it('cancels page-exit device permission and stops late tracks without creating a room', async () => {
    const devices = deferred<void>(); sdk.initDevices.mockReturnValue(devices.promise);
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    const late = track(); act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(late, { ...remote, local: true }));
    expect(late.stop).toHaveBeenCalled();
    await act(async () => devices.resolve());
    await screen.findByText('Disconnected', { exact: true });
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
  });
  it('releases a pending room after pagehide without connecting', async () => {
    const room = deferred<typeof join>(); vi.mocked(api.startCall).mockReturnValue(room.promise);
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(api.startCall).toHaveBeenCalled());
    act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await act(async () => room.resolve(join));
    await screen.findByText('Disconnected', { exact: true });
    expect(sdk.connect).not.toHaveBeenCalled(); expect(api.endCall).toHaveBeenCalledTimes(1);
  });
  it('surfaces start failure and retries an unconfirmed backend termination', async () => {
    vi.mocked(api.startCall).mockRejectedValue(new ApiError(503, { code: 'voiceUnavailable', message: 'internal detail' }));
    vi.mocked(api.endCall).mockRejectedValueOnce(new TypeError('Network lost'));
    const view = show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    const retry = await panel().findByRole('button', { name: 'Retry ending call' });
    expect(screen.getByRole('alert', { name: 'Call ending not confirmed' })).toHaveTextContent('Microphone off. We couldn’t confirm the call ended. Retry ending it before starting again.');
    expect(within(screen.getByRole('alert', { name: 'Conversations unavailable' })).getByText('Try again shortly.')).toBeVisible();
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('error');
    await userEvent.click(retry); await panel().findByRole('button', { name: 'Reconnect' });
    expect(screen.queryByRole('alert', { name: 'Call ending not confirmed' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Conversations unavailable' })).toBeVisible();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(api.endCall).toHaveBeenCalledTimes(2);
  });
  it('labels unexpected disconnection honestly and releases resources', async () => {
    show(); await start(); ready();
    act(() => sdk.options!.callbacks!.onDisconnected!());
    await screen.findByText('Disconnected', { exact: true });
    expectOrb('idle', 0, 'disconnected');
    expect(within(screen.getByRole('alert', { name: 'Connection lost' })).getByText('Check your internet connection, then reconnect.')).toBeVisible(); expect(api.endCall).toHaveBeenCalledTimes(1);
  });
  it('does not call a backend error response a successful conclusion', async () => {
    vi.mocked(api.endCall).mockResolvedValue({ callId: join.callId, status: 'error', cleanupConfirmed: true, message: 'Provider failed' });
    show(); await start(); ready();
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await screen.findByText(/conversation stopped with an error/);
    expect(screen.queryByText('Conversation ended', { exact: true })).not.toBeInTheDocument();
  });
  it('treats an active DELETE response as unconfirmed and offers termination retry', async () => {
    vi.mocked(api.endCall).mockResolvedValue({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null });
    show(); await start();
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await panel().findByRole('button', { name: 'Retry ending call' });
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone off. We couldn’t confirm the call ended. Retry ending it before starting again.');
    expect(panel().queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });
  it('handles pipeline errors without exposing provider diagnostics', async () => {
    show(); await start(); ready();
    act(() => sdk.options!.callbacks!.onError!({ label: 'rtvi-ai', id: 'error', type: 'error', data: { error: 'private provider diagnostic', fatal: true } }));
    await screen.findByText(/assistant could not continue/);
    expect(screen.queryByText('private provider diagnostic')).not.toBeInTheDocument();
    expect(api.endCall).toHaveBeenCalledTimes(1);
  });
  it('ignores a cancelled connect rejection after a fresh attempt begins', async () => {
    const connection = deferred<void>(); sdk.connect.mockReturnValueOnce(connection.promise);
    show(); await start();
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await screen.findByText('Conversation ended', { exact: true });
    await userEvent.click(panel().getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(2));
    ready();
    await act(async () => connection.reject(new TypeError('Cancelled connection')));
    expect(screen.getByText('Listening', { exact: true })).toBeVisible();
    expect(api.endCall).toHaveBeenCalledTimes(1);
  });
  it.each(['bot first', 'user first'])('preserves an interrupted spoken prefix when speech stops %s', async (order) => {
    show(); await start(); ready();
    act(() => {
      sdk.options!.callbacks!.onBotOutput!({ text: 'Check the next bill before spending', segment_id: 2, will_be_spoken: true, spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Check the next bill', remaining_text: 'before spending' } });
      if (order === 'user first') sdk.options!.callbacks!.onUserStartedSpeaking!();
      sdk.options!.callbacks!.onBotStoppedSpeaking!();
      if (order === 'bot first') sdk.options!.callbacks!.onUserStartedSpeaking!();
      sdk.options!.callbacks!.onBotOutput!({ text: 'Check the next bill before spending', segment_id: 2, will_be_spoken: true, spoken_status: 'completed' });
    });
    expect(screen.getByText('Check the next bill')).toBeVisible();
    expect(screen.getByRole('heading', { name: `${settings.assistantName} · interrupted` })).toBeVisible();
    expect(screen.queryByText('Check the next bill before spending')).not.toBeInTheDocument();
    act(() => sdk.options!.callbacks!.onUserMuteStarted!());
    expect(screen.getByText('Listening paused')).toBeVisible();
    act(() => sdk.options!.callbacks!.onUserMuteStopped!());
    expect(screen.getByText('Listening', { exact: true })).toBeVisible();
  });
  it('resumes saved figures without opening the microphone, and detects an existing call', async () => {
    vi.mocked(api.call).mockResolvedValue({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null });
    const onBusyChange = vi.fn();
    render(<StrictMode><Conversation settings={settings} sessionId={snapshot().sessionId} disabled={false} onStarted={vi.fn()} onBusyChange={onBusyChange}
      presentation="session" onPrepare={vi.fn()} onPhaseChange={vi.fn()} onSettings={vi.fn()} /><ToastViewport /></StrictMode>);
    await screen.findByText('Another conversation is still open. End it before connecting here.');
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(panel().getByRole('button', { name: 'Retry ending call' })); expect(api.endCall).toHaveBeenCalledTimes(1);
  });
});

describe('media-derived official orb feedback', () => {
  it('maps runtime activity to the five official states, with microphone mute taking precedence over audible speech', async () => {
    const release = deferred<Awaited<ReturnType<typeof api.endCall>>>();
    vi.mocked(api.endCall).mockReturnValueOnce(release.promise);
    const view = show();
    const canvas = view.container.querySelector('canvas.aui-voice-orb');
    expectOrb('idle', 0);
    await start(); expectOrb('connecting', 0);
    ready(); expectOrb('listening', 0);
    const events = sdk.options!.callbacks!;
    act(() => events.onBotLlmStarted!());
    expectOrb('listening', 0, 'processing');
    act(() => { events.onBotLlmStopped!(); events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.6); });
    expectOrb('listening', 0.6, 'userSpeaking');
    act(() => events.onUserStoppedSpeaking!());
    await hear();
    act(() => { events.onBotStartedSpeaking!(); events.onRemoteAudioLevel!(0.8, remote); });
    expectOrb('speaking', 0.8, 'assistantSpeaking');
    await userEvent.click(panel().getByRole('button', { name: 'Mute microphone' }));
    act(() => events.onRemoteAudioLevel!(1, remote));
    expectOrb('muted', 0, 'assistantSpeaking');
    expect(panel().getByRole('status')).toHaveTextContent(/^Speaking$/);
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    act(() => events.onTransportStateChanged!('connecting'));
    expectOrb('connecting', 0, 'reconnecting');
    act(() => events.onTransportStateChanged!('ready'));
    expectOrb('muted', 0);
    await userEvent.click(panel().getByRole('button', { name: 'Unmute microphone' }));
    expectOrb('listening', 0);
    act(() => events.onUserMuteStarted!());
    expectOrb('muted', 0, 'paused');
    act(() => events.onUserMuteStopped!());
    expectOrb('listening', 0);
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    expectOrb('idle', 0, 'ending');
    await act(async () => release.resolve({ callId: join.callId, status: 'ended', cleanupConfirmed: true, message: null }));
    expectOrb('idle', 0, 'ended');
    expect(view.container.querySelector('canvas.aui-voice-orb')).toBe(canvas);
    expect(view.container.querySelector('.call-orb svg')).toBeNull();
  });

  it('unmounts only the renderer when hidden while preserving the live call, tracks and captions', async () => {
    const view = show(); await start(); ready(); const bot = await hear();
    const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    const player = view.container.querySelector('audio')!;
    const stream = player.srcObject;
    const canvas = view.container.querySelector('canvas.aui-voice-orb');
    const client = sdk.options;
    view.change({ visible: false });
    const count = orb.mock.calls.length;
    expect(view.container.querySelector('canvas.aui-voice-orb')).toBeNull();
    act(() => {
      sdk.options!.callbacks!.onBotStartedSpeaking!();
      sdk.options!.callbacks!.onRemoteAudioLevel!(0.5, remote);
      sdk.options!.callbacks!.onUserTranscript!({ text: 'Keep my figures', final: true, timestamp: 'hidden', user_id: 'me' });
    });
    expect(view.transcript).toEqual({ captions: [expect.objectContaining({ text: 'Keep my figures', speaker: 'You' })], interim: null });
    expect(orb.mock.calls).toHaveLength(count);
    expect(view.container.querySelector('audio')).toBe(player);
    expect(player.srcObject).toBe(stream);
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('active');
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true);
    view.change({ visible: true });
    expectOrb('speaking', 0.5, 'assistantSpeaking');
    expect(view.container.querySelector('canvas.aui-voice-orb')).not.toBe(canvas);
    expect(screen.getByText('Keep my figures')).toBeVisible();
    expect(sdk.options).toBe(client);
    expect(sdk.connect).toHaveBeenCalledOnce(); expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(sdk.disconnect).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
    expect(microphone.stop).not.toHaveBeenCalled(); expect(bot.stop).not.toHaveBeenCalled();
    expect(player.srcObject).toBe(stream);
  });

  it('requires bot readiness and live capture without duplicating connection status during speech or reconnection', async () => {
    show(); await start(); const events = sdk.options!.callbacks!;
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.8); });
    expectOrb('connecting', 0);
    ready();
    expectOrb('listening', 0);
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    act(() => events.onConnected!());
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expectOrb('listening', 0);
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.6); });
    expectOrb('listening', 0.6, 'userSpeaking');
    act(() => events.onUserStoppedSpeaking!());
    expectOrb('listening', 0);
    act(() => events.onLocalAudioLevel!(1));
    expectOrb('listening', 0);
    act(() => events.onTransportStateChanged!('connecting'));
    expectOrb('connecting', 0, 'reconnecting');
    expect(panel().getByRole('status')).toHaveTextContent(/^Reconnecting$/);
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    act(() => { events.onUserStartedSpeaking!(); events.onBotStartedSpeaking!(); events.onLocalAudioLevel!(1); });
    expectOrb('connecting', 0, 'reconnecting');
    act(() => events.onTransportStateChanged!('ready'));
    expectOrb('listening', 0);
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    act(() => events.onConnected!());
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expectOrb('listening', 0);
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
  });

  it.each([[NaN, 0], [Infinity, 0], [-Infinity, 0], [-1, 0], [0, 0], [2, 1], [0.4, 0.4]])('bounds a local audio sample of %s to %s', async (value, level) => {
    show(); await start(); ready();
    act(() => { sdk.options!.callbacks!.onUserStartedSpeaking!(); sdk.options!.callbacks!.onLocalAudioLevel!(value); });
    expectOrb('listening', level, 'userSpeaking');
  });

  it.each(['mute', 'pause', 'track mute', 'track disabled', 'track ended'])('clears local energy on %s and rejects further samples', async (event) => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    const view = show(); await start(); ready(); const events = sdk.options!.callbacks!;
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.7); });
    expectOrb('listening', 0.7, 'userSpeaking');
    if (event === 'mute') await userEvent.click(panel().getByRole('button', { name: 'Mute microphone' }));
    else act(() => {
      if (event === 'pause') events.onUserMuteStarted!();
      else {
        Object.assign(microphone, event === 'track mute' ? { muted: true } : event === 'track disabled' ? { enabled: false } : { readyState: 'ended' });
        microphone.dispatchEvent(new Event(event === 'track ended' ? 'ended' : 'mute'));
      }
    });
    if (event === 'track ended') {
      expect(await screen.findByRole('alert', { name: 'Microphone disconnected' })).toHaveTextContent('The conversation has stopped');
      await waitFor(() => expect(view.onPhaseChange).toHaveBeenLastCalledWith('error'));
      expectOrb('idle', 0, 'unavailable');
      expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(api.endCall).toHaveBeenCalledOnce();
      act(() => { events.onConnected!(); events.onBotReady!({ version: '2.1' }); events.onRemoteAudioLevel!(1, remote); });
    }
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(1); });
    expectOrb(event === 'mute' || event === 'pause' ? 'muted' : 'idle', 0,
      event === 'mute' ? 'muted' : event === 'pause' ? 'paused' : 'unavailable');
    if (event === 'track ended') {
      expect(view.onPhaseChange).toHaveBeenLastCalledWith('error');
      expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(api.endCall).toHaveBeenCalledOnce();
    }
  });

  it('uses only the attached assistant track during live playback and switches to actual local interruption', async () => {
    const playback = deferred<void>(); vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(playback.promise);
    const view = show(); await start(); ready(); const events = sdk.options!.callbacks!;
    act(() => { events.onBotStartedSpeaking!(); events.onRemoteAudioLevel!(1, remote); });
    expectOrb('idle', 0, 'unavailable');
    const bot = await hear();
    act(() => events.onRemoteAudioLevel!(1, remote));
    expectOrb('muted', 0, 'paused');
    await act(async () => playback.resolve());
    act(() => {
      events.onRemoteAudioLevel!(1, { ...remote, id: 'someone-else' });
      events.onRemoteAudioLevel!(1, { ...remote, local: true });
      events.onLocalAudioLevel!(1);
    });
    expectOrb('speaking', 0, 'assistantSpeaking');
    act(() => events.onRemoteAudioLevel!(0.8, remote));
    expectOrb('speaking', 0.8, 'assistantSpeaking');
    act(() => { events.onUserStartedSpeaking!(); events.onRemoteAudioLevel!(1, remote); });
    expectOrb('listening', 0, 'interrupted');
    act(() => events.onLocalAudioLevel!(0.4));
    expectOrb('listening', 0.4, 'interrupted');
    act(() => events.onUserStoppedSpeaking!());
    expectOrb('speaking', 0, 'assistantSpeaking');
    act(() => events.onRemoteAudioLevel!(0.6, remote));
    fireEvent.pause(view.container.querySelector('audio')!);
    expectOrb('muted', 0, 'paused');
    act(() => events.onRemoteAudioLevel!(1, remote));
    expectOrb('muted', 0, 'paused');
    fireEvent.playing(view.container.querySelector('audio')!);
    act(() => events.onRemoteAudioLevel!(0.5, remote));
    expectOrb('speaking', 0.5, 'assistantSpeaking');
    act(() => { Object.assign(bot, { muted: true }); bot.dispatchEvent(new Event('mute')); events.onRemoteAudioLevel!(1, remote); });
    expectOrb('idle', 0, 'unavailable');
    act(() => { Object.assign(bot, { muted: false, enabled: false }); bot.dispatchEvent(new Event('unmute')); events.onRemoteAudioLevel!(1, remote); });
    expectOrb('idle', 0, 'unavailable');
    act(() => { Object.assign(bot, { enabled: true, readyState: 'ended' }); bot.dispatchEvent(new Event('ended')); events.onRemoteAudioLevel!(1, remote); });
    expectOrb('idle', 0, 'unavailable');
  });

  it('smooths received levels and resets stale energy after 200 ms without inventing a speaking transition', async () => {
    const view = show(); await start(); ready();
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const events = sdk.options!.callbacks!;
      act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.25); });
      clock.mockReturnValue(100);
      act(() => events.onLocalAudioLevel!(0.75));
      const level = 0.25 + 0.5 * (1 - Math.exp(-1));
      expectOrb('listening', expect.closeTo(level, 5), 'userSpeaking');
      act(() => vi.advanceTimersByTime(199));
      expectOrb('listening', expect.closeTo(level, 5), 'userSpeaking');
      act(() => vi.advanceTimersByTime(1));
      expectOrb('listening', 0, 'userSpeaking');
      act(() => events.onLocalAudioLevel!(0.9));
      expectOrb('listening', 0.9, 'userSpeaking');
      act(() => events.onLocalAudioLevel!(NaN));
      expectOrb('listening', 0, 'userSpeaking');
    } finally { view.unmount(); clock.mockRestore(); vi.useRealTimers(); }
  });

  it('does not offer playback recovery for an assistant track that has ended', async () => {
    const published = vi.spyOn(toast, 'notify');
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
    show(); await start(); ready(); const bot = await hear();
    act(() => sdk.options!.callbacks!.onBotStartedSpeaking!());
    await screen.findByRole('status', { name: 'Assistant audio paused' });
    const resume = published.mock.calls.find(([notice]) => notice.id === 'voice:audio')![0].action!;
    act(() => { Object.assign(bot, { readyState: 'ended' }); bot.dispatchEvent(new Event('ended')); });
    expect(panel().getByRole('status')).toHaveTextContent(/^Assistant audio unavailable$/);
    expect(screen.queryByRole('button', { name: 'Resume audio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Assistant audio paused' })).not.toBeInTheDocument();
    await act(async () => { resume.onClick(); sdk.options!.callbacks!.onRemoteAudioLevel!(1, remote); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expectOrb('idle', 0, 'unavailable');
  });
});

describe('caption receipt and speech boundaries', () => {
  it('publishes caption changes to the current parent callback without restarting or publishing on unrelated renders', async () => {
    const view = show();
    expect(view.onTranscriptChange).toHaveBeenCalledWith({ captions: [], interim: null });
    await start(); ready();
    const events = sdk.options!.callbacks!;
    view.onTranscriptChange.mockClear();
    const onTranscriptChange = vi.fn<(transcript: Transcript) => void>();
    view.change({ onTranscriptChange, visible: false });
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.5); });
    expect(onTranscriptChange).not.toHaveBeenCalled();
    act(() => events.onUserTranscript!({ text: 'My rent', final: false, timestamp: 'one', user_id: 'me' }));
    expect(onTranscriptChange).toHaveBeenLastCalledWith({ captions: [], interim: { text: 'My rent', time: expect.any(Number) } });
    act(() => events.onUserTranscript!({ text: 'My rent is 500', final: true, timestamp: 'one', user_id: 'me' }));
    expect(onTranscriptChange).toHaveBeenLastCalledWith({ captions: [expect.objectContaining({ text: 'My rent is 500', speaker: 'You' })], interim: null });
    expect(onTranscriptChange).toHaveBeenCalledTimes(2);
    expect(view.onTranscriptChange).not.toHaveBeenCalled();
    expect(sdk.connect).toHaveBeenCalledOnce(); expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(sdk.disconnect).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-09-11T18:30:05Z', '2026-09-11T18:30:05.000Z'],
    ['2026-09-12T00:00:05+05:30', '2026-09-11T18:30:05.000Z'],
    ['2026-09-11T18:30:05.125Z', '2026-09-11T18:30:05.125Z'],
    ['42', null], ['', null], ['11 September 2026', null], ['2026-02-30T04:00:00Z', null],
    ['2026-13-01T04:00:00Z', null], ['2026-09-11T24:00:00Z', null], ['2026-09-11T04:00:00+99:00', null],
    [undefined, null], [null, null], [NaN, null],
  ])('uses valid ISO server time or receipt time without throwing for %s', async (timestamp, expected) => {
    show({ settings: { ...settings, voiceAvailable: true } }); await start(); ready();
    const receipt = Date.parse('2026-09-11T19:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(receipt);
    expect(() => act(() => sdk.options!.callbacks!.onUserTranscript!({ text: 'My next bill', final: true, timestamp: timestamp as string, user_id: 'me' }))).not.toThrow();
    expect(screen.getByRole('region', { name: 'Live caption' }).querySelector('time')).toHaveAttribute('datetime', expected ?? '2026-09-11T19:00:00.000Z');
    expect(screen.getByText('My next bill')).toBeVisible();
  });

  it('preserves receipt time on corrections and keeps a later-received, earlier-dated caption live', async () => {
    const view = show({ settings: { ...settings, voiceAvailable: true } }); await start(); ready();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-11T05:00:00Z'));
    const events = sdk.options!.callbacks!;
    act(() => events.onUserTranscript!({ text: 'First figure', final: true, timestamp: 'opaque', user_id: 'me' }));
    clock.mockReturnValue(Date.parse('2026-09-11T05:01:00Z'));
    act(() => {
      events.onUserTranscript!({ text: 'Corrected figure', final: true, timestamp: 'opaque', user_id: 'me' });
      events.onUserTranscript!({ text: 'A later receipt', final: true, timestamp: '2026-09-11T04:00:00Z', user_id: 'me' });
    });
    expect(view.transcript.captions).toEqual([
      { id: 'user-me-opaque', speaker: 'You', text: 'Corrected figure', time: Date.parse('2026-09-11T05:00:00Z') },
      { id: 'user-me-2026-09-11T04:00:00Z', speaker: 'You', text: 'A later receipt', time: Date.parse('2026-09-11T04:00:00Z') },
    ]);
    expect(screen.queryByText('Corrected figure')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('A later receipt')).toBeVisible();
    act(() => events.onUserTranscript!({ text: 'Another correction', final: true, timestamp: 'opaque', user_id: 'me' }));
    expect(view.transcript.captions).toHaveLength(2);
    expect(view.transcript.captions[0]).toEqual({ id: 'user-me-opaque', speaker: 'You', text: 'Another correction', time: Date.parse('2026-09-11T05:00:00Z') });
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('A later receipt')).toBeVisible();
  });

  it('timestamps interim speech at its first receipt and excludes blank updates', async () => {
    const view = show(); await start(); ready(); const events = sdk.options!.callbacks!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-11T05:00:00Z'));
    act(() => events.onUserTranscript!({ text: 'I have', final: false, timestamp: 'one', user_id: 'me' }));
    clock.mockReturnValue(Date.parse('2026-09-11T05:01:00Z'));
    act(() => {
      events.onUserTranscript!({ text: 'I have some money', final: false, timestamp: 'two', user_id: 'me' });
      events.onUserTranscript!({ text: '  ', final: false, timestamp: 'three', user_id: 'me' });
    });
    const live = screen.getByRole('region', { name: 'Live caption' });
    expect(within(live).getByText('I have some money')).toBeVisible();
    expect(live.querySelector('time')).toHaveAttribute('datetime', '2026-09-11T05:00:00.000Z');
    expect(view.transcript).toEqual({ captions: [], interim: { text: 'I have some money', time: Date.parse('2026-09-11T05:00:00Z') } });
    act(() => events.onUserTranscript!({ text: 'I have 500 rupees', final: true, timestamp: 'opaque', user_id: 'me' }));
    expect(live.querySelector('time')).toHaveAttribute('datetime', '2026-09-11T05:01:00.000Z');
    act(() => events.onUserTranscript!({ text: '', final: true, timestamp: 'empty', user_id: 'me' }));
    expect(within(live).getByText('I have 500 rupees')).toBeVisible();
    expect(view.transcript).toEqual({ captions: [
      { id: 'user-me-opaque', speaker: 'You', text: 'I have 500 rupees', time: Date.parse('2026-09-11T05:01:00Z') },
    ], interim: null });
  });

  it('keeps unsegmented spoken output together at its first spoken receipt and retains every prior prefix', async () => {
    const view = show(); await start(); ready(); const events = sdk.options!.callbacks!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-11T05:00:00Z'));
    act(() => events.onBotOutput!({ text: 'Check your bills first', will_be_spoken: true, spoken_status: 'new' }));
    expect(screen.queryByText('Check your bills first')).not.toBeInTheDocument();
    clock.mockReturnValue(Date.parse('2026-09-11T05:00:01Z'));
    act(() => events.onBotOutput!({ text: 'Check your bills first', will_be_spoken: true, spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Check', remaining_text: 'your bills first' } }));
    clock.mockReturnValue(Date.parse('2026-09-11T05:00:02Z'));
    act(() => events.onBotOutput!({ text: 'Check your bills first', will_be_spoken: true, spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Check your bills', remaining_text: 'first' } }));
    const live = screen.getByRole('region', { name: 'Live caption' });
    expect(live.querySelector('time')).toHaveAttribute('datetime', '2026-09-11T05:00:01.000Z');
    expect(screen.getAllByText('Check your bills')).toHaveLength(1);
    act(() => events.onUserTranscript!({ text: 'Please wait', final: false, timestamp: 'one', user_id: 'me' }));
    expect(view.transcript).toEqual({ captions: [
      expect.objectContaining({ speaker: 'Assistant', text: 'Check your bills', time: Date.parse('2026-09-11T05:00:01Z'), pending: true }),
    ], interim: { text: 'Please wait', time: Date.parse('2026-09-11T05:00:02Z') } });
    expect(within(live).getByText('Please wait')).toBeVisible();
    expect(screen.queryByText('Check your bills')).not.toBeInTheDocument();
    act(() => {
      events.onBotStoppedSpeaking!(); events.onUserStartedSpeaking!();
      events.onBotOutput!({ text: 'Check your bills first', will_be_spoken: true, spoken_status: 'completed' });
      events.onUserTranscript!({ text: '', final: true, timestamp: 'one', user_id: 'me' });
    });
    expect(within(live).getByText(`${settings.assistantName} · interrupted`)).toBeVisible();
    expect(within(live).getByText('Check your bills')).toBeVisible();
    expect(screen.queryByText('Check your bills first')).not.toBeInTheDocument();
    clock.mockReturnValue(Date.parse('2026-09-11T05:00:03Z'));
    act(() => {
      events.onUserStoppedSpeaking!();
      events.onBotOutput!({ text: 'We can wait', will_be_spoken: true, spoken_status: 'new' });
      events.onBotOutput!({ text: 'We can wait', will_be_spoken: true, spoken_status: 'completed' });
    });
    expect(within(live).getByText('We can wait')).toBeVisible();
    expect(live.querySelector('time')).toHaveAttribute('datetime', '2026-09-11T05:00:03.000Z');
    expect(view.transcript).toEqual({ captions: [
      expect.objectContaining({ speaker: 'Assistant', text: 'Check your bills', time: Date.parse('2026-09-11T05:00:01Z'), pending: false, interrupted: true }),
      expect.objectContaining({ speaker: 'Assistant', text: 'We can wait', time: Date.parse('2026-09-11T05:00:03Z'), pending: false }),
    ], interim: null });
    expect(screen.queryByText('Check your bills')).not.toBeInTheDocument();
  });
});

describe('notice ownership and current actions', () => {
  it.each([
    ['NotFoundError', 'No microphone found', 'Connect a microphone, then try again.'],
    ['NotReadableError', 'Microphone in use', 'Close other calling apps, then try again.'],
  ])('maps %s to a persistent consumer notice before creating a room', async (name, title, message) => {
    const published = vi.spyOn(toast, 'notify');
    sdk.initDevices.mockRejectedValueOnce(new DOMException('private device diagnostic', name));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    const notice = await screen.findByRole('alert', { name: title });
    expect(within(notice).getByText(message)).toBeVisible();
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ title, message, duration: null }));
    expect(view.container).not.toHaveTextContent('private device diagnostic');
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
  });

  it.each([
    ['permissions', 'Microphone access denied', 'Allow microphone access in your browser’s site settings, then try again.'],
    ['not-found', 'No microphone found', 'Connect a microphone, then try again.'],
    ['in-use', 'Microphone in use', 'Close other calling apps, then try again.'],
    ['undefined-mediadevices', 'Microphone unavailable', 'Open this page in a current browser, then try again.'],
  ])('stops live capture for SDK device error %s without showing its diagnostic', async (type, title, message) => {
    const published = vi.spyOn(toast, 'notify');
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    const view = show(); await start(); ready();
    const error = Object.assign(Object.create(DeviceError.prototype) as DeviceError, { type, message: 'private SDK diagnostic' });
    act(() => sdk.options!.callbacks!.onDeviceError!(error));
    expect(microphone.stop).toHaveBeenCalled();
    const notice = await screen.findByRole(type === 'permissions' ? 'status' : 'alert', { name: title });
    expect(within(notice).getByText(message)).toBeVisible();
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ title, message, duration: null }));
    expect(view.container).not.toHaveTextContent('private SDK diagnostic');
    expect(api.endCall).toHaveBeenCalledOnce(); expect(sdk.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a permission notice mounted and makes even a retained retry action respect current visibility and locks', async () => {
    const published = vi.spyOn(toast, 'notify');
    sdk.initDevices.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    const notice = await screen.findByRole('status', { name: 'Microphone access denied' });
    const retry = published.mock.calls.find(([notice]) => notice.id === 'voice:problem')![0].action!;
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ id: 'voice:problem', duration: null }));
    view.change({ disabled: true });
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeDisabled();
    await act(async () => { retry.onClick(); });
    expect(sdk.initDevices).toHaveBeenCalledOnce();
    const prepare = vi.fn();
    view.change({ disabled: false, visible: false, onPrepare: prepare });
    await act(async () => { retry.onClick(); });
    expect(prepare).toHaveBeenCalledOnce(); expect(view.onPrepare).not.toHaveBeenCalled();
    expect(sdk.initDevices).toHaveBeenCalledOnce();
    view.change({ visible: true, presentation: 'landing' });
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(prepare).toHaveBeenCalledTimes(2); expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(screen.getByRole('status', { name: 'Microphone access denied' })).toBeVisible();
    view.change({ presentation: 'ready' });
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce()); ready();
    expect(sdk.initDevices).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status', { name: 'Microphone access denied' })).not.toBeInTheDocument();
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
  });

  it('prepares a hidden conversation without requesting microphone access from its primary action', async () => {
    const view = show({ visible: false });
    await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    expect(view.onPrepare).toHaveBeenCalledOnce(); expect(sdk.initDevices).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    view.change({ visible: true }); await start();
    expect(sdk.initDevices).toHaveBeenCalledOnce();
  });

  it('keeps network recovery actionable until an explicit reconnect', async () => {
    const view = show(); await start(); ready();
    act(() => sdk.options!.callbacks!.onDisconnected!());
    const notice = await screen.findByRole('alert', { name: 'Connection lost' });
    expect(within(notice).getByText('Check your internet connection, then reconnect.')).toBeVisible();
    view.change({ disabled: true });
    expect(within(notice).getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    view.change({ disabled: false });
    expect(screen.getByRole('alert', { name: 'Connection lost' })).toBeVisible();
    await userEvent.click(within(notice).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(2));
    expect(panel().getByRole('status')).toHaveTextContent(/^Reconnecting$/);
    ready();
    expect(screen.queryByRole('alert', { name: 'Connection lost' })).not.toBeInTheDocument();
    expect(api.endCall).toHaveBeenCalledOnce();
  });

  it('uses current availability actions and callbacks without duplicate requests or automatic microphone access', async () => {
    const published = vi.spyOn(toast, 'notify');
    const request = vi.spyOn(api, 'settings').mockRejectedValueOnce(new Error('private availability diagnostic'));
    const view = show({ settings: { ...settings, voiceAvailable: false } });
    await userEvent.click(panel().getByRole('button', { name: 'Check availability' }));
    const notice = await screen.findByRole('alert', { name: 'Could not check availability' });
    const check = published.mock.calls.find(([notice]) => notice.id === 'voice:availability')![0].action!;
    view.change({ visible: false });
    await act(async () => { check.onClick(); });
    expect(view.onPrepare).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
    view.change({ visible: true });
    const result = deferred<typeof settings>(); request.mockReturnValueOnce(result.promise);
    await act(async () => { check.onClick(); check.onClick(); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(within(notice).getByRole('button', { name: 'Check availability' })).toBeDisabled();
    const onSettings = vi.fn(); view.change({ onSettings });
    await act(async () => result.resolve({ ...settings, voiceAvailable: true }));
    expect(onSettings).toHaveBeenCalledWith({ ...settings, voiceAvailable: true });
    expect(view.onSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });

  it.each([{ sessionIssue: 'expired' as const }, { sessionId: 'another-session' }, { updatesLost: true },
    { settings: { ...settings, voiceAvailable: true } }])('aborts availability when its authoritative context changes: %j', async (props) => {
    const result = deferred<typeof settings>(); const request = vi.spyOn(api, 'settings').mockReturnValue(result.promise);
    const view = show({ settings: { ...settings, voiceAvailable: false } });
    await userEvent.click(panel().getByRole('button', { name: 'Check availability' }));
    view.change(props);
    expect(request.mock.calls[0][0]!.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Checking availability…' })).not.toBeInTheDocument();
    await act(async () => result.resolve({ ...settings, voiceAvailable: true }));
    expect(view.onSettings).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not dismiss an unavailable notice for unrelated settings or render changes', async () => {
    vi.mocked(api.startCall).mockRejectedValueOnce(new ApiError(503, { code: 'voiceUnavailable', message: 'private availability diagnostic' }));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await screen.findByRole('alert', { name: 'Conversations unavailable' });
    view.change({ settings: { ...settings, voiceAvailable: true, today: '2026-09-12' } });
    expect(screen.getByRole('alert', { name: 'Conversations unavailable' })).toBeVisible();
    const refresh = vi.spyOn(api, 'settings').mockResolvedValueOnce({ ...settings, voiceAvailable: true });
    await userEvent.click(within(screen.getByRole('alert', { name: 'Conversations unavailable' })).getByRole('button', { name: 'Check availability' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert', { name: 'Conversations unavailable' })).not.toBeInTheDocument();
    expect(sdk.initDevices).toHaveBeenCalledOnce();
  });

  it('clears an unavailable notice on an authoritative availability flip without starting media', async () => {
    vi.mocked(api.startCall).mockRejectedValueOnce(new ApiError(503, { code: 'voiceUnavailable', message: 'private availability diagnostic' }));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await screen.findByRole('alert', { name: 'Conversations unavailable' });
    view.change({ settings: { ...settings, voiceAvailable: false } });
    expect(screen.getByRole('alert', { name: 'Conversations unavailable' })).toBeVisible();
    view.change({ settings: { ...settings, voiceAvailable: true } });
    expect(screen.queryByRole('alert', { name: 'Conversations unavailable' })).not.toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(sdk.initDevices).toHaveBeenCalledOnce(); expect(api.startCall).toHaveBeenCalledOnce();
  });

  it('keeps an availability request pending through unrelated prop changes', async () => {
    const result = deferred<typeof settings>();
    const request = vi.spyOn(api, 'settings').mockReturnValueOnce(result.promise);
    const view = show({ settings: { ...settings, voiceAvailable: false } });
    await userEvent.click(panel().getByRole('button', { name: 'Check availability' }));
    view.change({ settings: { ...settings, voiceAvailable: false, today: '2026-09-12' }, disabled: true });
    view.change({ disabled: false });
    expect(request.mock.calls[0][0]!.aborted).toBe(false);
    expect(panel().getByRole('button', { name: 'Checking availability…' })).toBeDisabled();
    await act(async () => result.resolve({ ...settings, voiceAvailable: true }));
    expect(view.onSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Checking availability…' })).not.toBeInTheDocument();
    expect(sdk.initDevices).not.toHaveBeenCalled();
  });

  it('keeps playback recovery visible and requires a foreground user action to resume it', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
    const view = show(); await start(); ready(); await hear();
    act(() => sdk.options!.callbacks!.onBotStartedSpeaking!());
    const notice = await screen.findByRole('status', { name: 'Assistant audio paused' });
    view.change({ visible: false });
    await userEvent.click(within(notice).getByRole('button', { name: 'Resume audio' }));
    expect(view.onPrepare).toHaveBeenCalledOnce(); expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    view.change({ visible: true, disabled: true });
    expect(within(notice).getByRole('button', { name: 'Resume audio' })).toBeDisabled();
    view.change({ disabled: false });
    await userEvent.click(within(notice).getByRole('button', { name: 'Resume audio' }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status', { name: 'Assistant audio paused' })).not.toBeInTheDocument();
    expect(panel().getByRole('status')).toHaveTextContent(/^Speaking$/);
  });

  it('retains an idle previous-error notice when the open-call notice is cleared', async () => {
    vi.mocked(api.call).mockResolvedValueOnce({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null });
    const view = show({ sessionId: snapshot().sessionId });
    await screen.findByRole('alert', { name: 'A conversation is still open' });
    vi.mocked(api.call).mockResolvedValueOnce({ callId: null, status: 'error', cleanupConfirmed: true, message: 'private call diagnostic' });
    view.change({ sessionId: 'another-session' });
    const notice = await screen.findByRole('status', { name: 'Previous conversation stopped' });
    expect(notice).toHaveTextContent('You can try a new conversation.');
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('idle');
    expect(screen.queryByRole('alert', { name: 'A conversation is still open' })).not.toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Start talking' })).toBeEnabled();
    view.change({ disabled: true }); view.change({ disabled: false });
    expect(screen.getByRole('status', { name: 'Previous conversation stopped' })).toBeVisible();
    expect(view.container).not.toHaveTextContent('private call diagnostic');
    await start();
    expect(screen.queryByRole('status', { name: 'Previous conversation stopped' })).not.toBeInTheDocument();
  });

  it('removes owned notices on unmount and ignores a retained action after disposal', async () => {
    const published = vi.spyOn(toast, 'notify');
    sdk.initDevices.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await screen.findByRole('status', { name: 'Microphone access denied' });
    const retry = published.mock.calls.find(([notice]) => notice.id === 'voice:problem')![0].action!;
    view.unmount(); render(<ToastViewport />);
    await act(async () => { retry.onClick(); });
    expect(screen.queryByRole('status', { name: 'Microphone access denied' })).not.toBeInTheDocument();
    expect(sdk.initDevices).toHaveBeenCalledOnce();
  });
});

describe('terminal session boundaries', () => {
  it('stops media synchronously on financial update loss and waits for explicit recovery', async () => {
    const leaving = deferred<void>(); sdk.disconnect.mockReturnValueOnce(leaving.promise);
    const view = show(); await start(); ready(); const bot = await hear();
    const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    const events = sdk.options!.callbacks!;
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.6); });
    view.change({ updatesLost: true });
    expect(microphone.stop).toHaveBeenCalled(); expect(bot.stop).toHaveBeenCalled();
    expect(view.container.querySelector('audio')!.srcObject).toBeNull();
    expectOrb('idle', 0, 'ending');
    act(() => {
      events.onBotReady!({ version: '2.1' }); events.onLocalAudioLevel!(1);
      events.onUserTranscript!({ text: 'Stale financial words', final: true, timestamp: 'late', user_id: 'me' });
    });
    expect(screen.queryByText('Stale financial words')).not.toBeInTheDocument();
    await act(async () => leaving.resolve());
    expect(screen.queryByRole('status', { name: 'Conversation stopped' })).not.toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    await userEvent.click(panel().getByRole('button', { name: 'Reconnect' }));
    expect(sdk.initDevices).toHaveBeenCalledOnce();
    view.change({ updatesLost: false });
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(screen.getByRole('status', { name: 'Conversation stopped' })).toHaveTextContent('Your microphone is off.');
    expect(sdk.initDevices).toHaveBeenCalledOnce();
    await start(); ready();
    expect(sdk.initDevices).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status', { name: 'Conversation stopped' })).not.toBeInTheDocument();
  });

  it.each([401, 403, 404, 410])('maps HTTP %s to a persistent session notice instead of an unusable reconnect action', async (status) => {
    const published = vi.spyOn(toast, 'notify');
    vi.mocked(api.startCall).mockRejectedValueOnce(new ApiError(status, { code: 'privateCode', message: 'private session diagnostic' }));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    const title = status === 410 ? 'Conversation expired' : status === 404 ? 'Conversation unavailable' : 'Sign-in required';
    const notice = await screen.findByRole('alert', { name: title });
    expect(notice).toHaveTextContent('Reload the page');
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ title, duration: null, dismissible: false, action: undefined }));
    expect(within(notice).queryByRole('button', { name: /Retry|Reconnect/ })).not.toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    expect(panel().queryByRole('button', { name: 'Check availability' })).not.toBeInTheDocument();
    expect(view.container).not.toHaveTextContent(/privateCode|private session diagnostic/);
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(api.endCall).not.toHaveBeenCalled();
    view.change({ disabled: true }); view.change({ disabled: false });
    expect(screen.getByRole('alert', { name: title })).toBeVisible();
    await userEvent.click(panel().getByRole('button', { name: 'Reconnect' }));
    expect(api.startCall).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 410])('does not offer termination retry when a saved-call check returns HTTP %s', async (status) => {
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(status, { code: 'privateCode', message: 'private check diagnostic' }));
    const view = show({ sessionId: snapshot().sessionId });
    await screen.findByRole('alert');
    expect(panel().getByRole('button', { name: 'Start talking' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Retry ending call' })).not.toBeInTheDocument();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
    expect(view.container).not.toHaveTextContent('private check diagnostic');
  });

  it('clears a session-scoped failure only when the parent supplies another session', async () => {
    vi.mocked(api.startCall).mockRejectedValueOnce(new ApiError(401, { code: 'unauthorized', message: 'private auth diagnostic' }));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await screen.findByRole('alert', { name: 'Sign-in required' });
    view.change({ sessionId: snapshot().sessionId });
    await waitFor(() => expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled());
    expect(screen.queryByRole('alert', { name: 'Sign-in required' })).not.toBeInTheDocument();
    await start(); ready();
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
  });

  it.each(['expired', 'deleted', 'unreadable', 'unauthorized'] as const)('stops microphone and playback synchronously when the session is %s', async (sessionIssue) => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    const view = show(); await start(); ready(); const bot = await hear(); const events = sdk.options!.callbacks!;
    act(() => {
      events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.6);
      events.onUserTranscript!({ text: 'Confirmed words', final: true, timestamp: 'one', user_id: 'me' });
    });
    view.change({ sessionIssue });
    expect(microphone.stop).toHaveBeenCalled(); expect(bot.stop).toHaveBeenCalled();
    expect(view.container.querySelector('audio')!.srcObject).toBeNull();
    await waitFor(() => expect(view.onPhaseChange).toHaveBeenLastCalledWith('error'));
    act(() => {
      events.onConnected!(); events.onBotReady!({ version: '2.1' }); events.onUserStartedSpeaking!();
      events.onLocalAudioLevel!(1); events.onRemoteAudioLevel!(1, remote);
      events.onUserTranscript!({ text: 'Stale words', final: true, timestamp: 'two', user_id: 'me' });
      events.onBotOutput!({ text: 'Stale output', spoken_status: 'completed' });
      events.onDisconnected!();
    });
    expectOrb('idle', 0, 'unavailable');
    expect(panel().getByRole('status')).toHaveTextContent(/^Conversation unavailable$/);
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    expect(screen.queryByText('Confirmed words')).not.toBeInTheDocument();
    expect(view.transcript).toEqual({ captions: [], interim: null });
    expect(screen.queryByText(/Stale words|Stale output/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(api.endCall).toHaveBeenCalledOnce();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('does not check or start a session already known to be unauthorized', async () => {
    const view = show({ sessionId: snapshot().sessionId, sessionIssue: 'unauthorized' });
    await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    expect(api.call).not.toHaveBeenCalled(); expect(sdk.initDevices).not.toHaveBeenCalled();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores a pending open-call check after the parent reports session expiry', async () => {
    const call = deferred<Awaited<ReturnType<typeof api.call>>>(); vi.mocked(api.call).mockReturnValueOnce(call.promise);
    const view = show({ sessionId: snapshot().sessionId });
    view.change({ sessionIssue: 'expired' });
    expect(vi.mocked(api.call).mock.calls[0][0]!.aborted).toBe(true);
    await act(async () => call.resolve({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null }));
    expect(screen.queryByRole('button', { name: 'Retry ending call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores a retained termination action after a terminal session issue supersedes its notice', async () => {
    const published = vi.spyOn(toast, 'notify');
    vi.mocked(api.call).mockResolvedValueOnce({ callId: join.callId, status: 'active', cleanupConfirmed: false, message: null });
    const view = show({ sessionId: snapshot().sessionId });
    await screen.findByRole('alert', { name: 'A conversation is still open' });
    const end = published.mock.calls.find(([notice]) => notice.id === 'voice:previous')![0].action!;
    view.change({ sessionIssue: 'unauthorized' });
    await act(async () => { end.onClick(); });
    expect(api.endCall).not.toHaveBeenCalled(); expect(sdk.initDevices).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry ending call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('suppresses a late voice failure and termination retry once the parent owns the session problem', async () => {
    const end = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValueOnce(end.promise);
    const view = show(); await start(); ready();
    act(() => sdk.options!.callbacks!.onDisconnected!());
    await waitFor(() => expect(api.endCall).toHaveBeenCalledOnce());
    view.change({ sessionIssue: 'unauthorized' });
    await act(async () => end.reject(new ApiError(401, { code: 'unauthorized', message: 'private auth diagnostic' })));
    expect(panel().getByRole('status')).toHaveTextContent(/^Conversation unavailable$/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry ending call' })).not.toBeInTheDocument();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('cancellation and stale callbacks', () => {
  it('stops live tracks immediately on unmount, removes their observers and ignores every late SDK callback', async () => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    const remove = vi.spyOn(microphone, 'removeEventListener');
    const view = show(); await start(); ready(); const bot = await hear();
    const events = sdk.options!.callbacks!;
    const started = sdk.listeners.get(RTVIEvent.TrackStarted)!;
    const stopped = sdk.listeners.get(RTVIEvent.TrackStopped)!;
    const player = view.container.querySelector('audio')!;
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.5); });
    view.unmount();
    expect(microphone.stop).toHaveBeenCalled(); expect(bot.stop).toHaveBeenCalled();
    expect(player.srcObject).toBeNull();
    for (const event of ['mute', 'unmute', 'ended']) expect(remove).toHaveBeenCalledWith(event, expect.any(Function));
    await waitFor(() => expect(api.endCall).toHaveBeenCalledOnce());
    const count = orb.mock.calls.length;
    const phases = view.onPhaseChange.mock.calls.length;
    const busy = view.onBusyChange.mock.calls.length;
    const transcripts = view.onTranscriptChange.mock.calls.length;
    const late = track();
    await act(async () => {
      events.onConnected!(); events.onBotReady!({ version: '2.1' }); events.onBotConnected!(remote);
      events.onTransportStateChanged!('ready'); events.onTransportStateChanged!('error'); events.onDisconnected!(); events.onBotDisconnected!(remote);
      events.onUserStartedSpeaking!(); events.onUserStoppedSpeaking!(); events.onBotStartedSpeaking!(); events.onBotStoppedSpeaking!();
      events.onBotLlmStarted!(); events.onBotLlmStopped!(); events.onUserMuteStarted!(); events.onUserMuteStopped!();
      events.onLLMFunctionCallStarted!({ function_name: 'read_state' });
      events.onLLMFunctionCallInProgress!({ tool_call_id: 'stale' }); events.onLLMFunctionCallStopped!({ tool_call_id: 'stale', cancelled: true });
      events.onLocalAudioLevel!(1); events.onRemoteAudioLevel!(1, remote);
      events.onUserTranscript!({ text: 'Stale interim', final: false, timestamp: 'one', user_id: 'me' });
      events.onUserTranscript!({ text: 'Stale transcript', final: true, timestamp: 'one', user_id: 'me' });
      events.onBotOutput!({ text: 'Stale output', spoken_status: 'completed' });
      events.onError!({ label: 'rtvi-ai', id: 'stale', type: 'error', data: { error: 'private stale diagnostic', fatal: true } });
      events.onDeviceError!(Object.assign(Object.create(DeviceError.prototype) as DeviceError, { type: 'permissions' }));
      started(late, { ...remote, local: true }); stopped(bot, remote);
      microphone.dispatchEvent(new Event('ended'));
    });
    render(<ToastViewport />);
    expect(late.stop).toHaveBeenCalledOnce();
    expect(orb.mock.calls).toHaveLength(count);
    expect(view.onPhaseChange.mock.calls).toHaveLength(phases); expect(view.onBusyChange.mock.calls).toHaveLength(busy);
    expect(view.onTranscriptChange.mock.calls).toHaveLength(transcripts);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(api.endCall).toHaveBeenCalledOnce(); expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('waits for devices to %s after unmount before disconnecting and stops late capture', async (settlement) => {
    const devices = deferred<void>(); sdk.initDevices.mockReturnValueOnce(devices.promise);
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    view.unmount(); expect(sdk.disconnect).not.toHaveBeenCalled();
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    await act(async () => { if (settlement === 'resolve') devices.resolve(); else devices.reject(new DOMException('Denied', 'NotAllowedError')); });
    expect(microphone.stop).toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(vi.mocked(microphone.stop).mock.invocationCallOrder[0]).toBeLessThan(sdk.disconnect.mock.invocationCallOrder[0]);
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled(); expect(view.onStarted).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled(); expect(sdk.destroy).not.toHaveBeenCalled();
  });

  it.each(['end', 'unmount', 'session issue'] as const)('does not create a room from a session response arriving after %s', async (cancellation) => {
    const saved = deferred<ReturnType<typeof snapshot>>(); vi.mocked(api.start).mockReturnValueOnce(saved.promise);
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    if (cancellation === 'end') await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    else if (cancellation === 'unmount') view.unmount();
    else view.change({ sessionIssue: 'deleted' });
    expect(microphone.stop).toHaveBeenCalled();
    await act(async () => saved.resolve(snapshot()));
    expect(view.onStarted).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled(); expect(sdk.connect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled(); expect(sdk.disconnect).toHaveBeenCalledOnce();
  });

  it('uses the latest parent callback for a pending session response and permits its matching session handoff', async () => {
    const saved = deferred<ReturnType<typeof snapshot>>(); vi.mocked(api.start).mockReturnValueOnce(saved.promise);
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    const onStarted = vi.fn(); view.change({ onStarted });
    await act(async () => saved.resolve(snapshot()));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
    expect(onStarted).toHaveBeenCalledWith(snapshot()); expect(view.onStarted).not.toHaveBeenCalled();
    view.change({ sessionId: snapshot().sessionId }); ready();
    expect(panel().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(sdk.disconnect).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled(); expect(api.call).not.toHaveBeenCalled();
  });

  it('stops capture when the parent switches to an unrelated session', async () => {
    const view = show(); await start(); ready(); const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    view.change({ sessionId: 'another-session' });
    expect(microphone.stop).toHaveBeenCalled();
    await waitFor(() => expect(sdk.disconnect).toHaveBeenCalledOnce());
    expect(api.endCall).toHaveBeenCalledOnce();
    await waitFor(() => expect(view.onBusyChange).toHaveBeenLastCalledWith(false));
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
  });

  it('does not let callbacks or the retained page-exit listener from a disposed attempt end a fresh attempt', async () => {
    const listeners = vi.spyOn(window, 'addEventListener');
    show(); await start(); ready();
    const events = sdk.options!.callbacks!;
    const started = sdk.listeners.get(RTVIEvent.TrackStarted)!;
    const leaving = listeners.mock.calls.find(([event]) => event === 'pagehide')![1] as EventListener;
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    await panel().findByRole('button', { name: 'Reconnect' });
    await start(); ready(); const microphone = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(microphone, { ...remote, local: true }));
    const late = track();
    await act(async () => {
      events.onBotReady!({ version: '2.1' }); events.onConnected!(); events.onDisconnected!(); events.onTransportStateChanged!('error');
      events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(1);
      events.onUserTranscript!({ text: 'Disposed words', final: true, timestamp: 'one', user_id: 'me' });
      events.onBotOutput!({ text: 'Disposed output', spoken_status: 'completed' });
      started(late, { ...remote, local: true }); leaving(new PageTransitionEvent('pagehide'));
    });
    expect(late.stop).toHaveBeenCalledOnce(); expect(microphone.stop).not.toHaveBeenCalled();
    expectOrb('listening', 0);
    expect(screen.queryByText(/Disposed words|Disposed output/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(api.endCall).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)('ignores playback that settles by %s after cancellation and a fresh attempt', async (settlement) => {
    const playback = deferred<void>(); vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(playback.promise);
    const view = show(); await start(); ready(); await hear();
    await userEvent.click(panel().getByRole('button', { name: 'End conversation' }));
    await panel().findByRole('button', { name: 'Reconnect' });
    await start(); ready(); const bot = await hear();
    act(() => { sdk.options!.callbacks!.onBotStartedSpeaking!(); sdk.options!.callbacks!.onRemoteAudioLevel!(0.4, remote); });
    await act(async () => { if (settlement === 'resolve') playback.resolve(); else playback.reject(new DOMException('Blocked', 'NotAllowedError')); });
    expect((view.container.querySelector('audio')!.srcObject as MediaStream).getTracks()).toEqual([bot]);
    expectOrb('speaking', 0.4, 'assistantSpeaking');
    expect(screen.queryByRole('button', { name: 'Resume audio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Assistant audio paused' })).not.toBeInTheDocument();
    expect(api.endCall).toHaveBeenCalledOnce();
  });

  it('rejects metering and tracks from a participant other than the identified assistant', async () => {
    const view = show(); await start(); ready(); const events = sdk.options!.callbacks!;
    const unknown = { ...remote, id: 'unknown' };
    await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(track(), unknown));
    act(() => events.onBotConnected!(remote));
    expect(view.container.querySelector('audio')!.srcObject).toBeNull();
    await act(async () => {
      sdk.listeners.get(RTVIEvent.TrackStarted)!(track('video'), remote);
      sdk.listeners.get(RTVIEvent.TrackStarted)!(track(), unknown);
      events.onBotStartedSpeaking!(); events.onRemoteAudioLevel!(1, unknown);
    });
    expect(view.container.querySelector('audio')!.srcObject).toBeNull();
    expectOrb('idle', 0, 'unavailable');
    const bot = await hear();
    act(() => { events.onRemoteAudioLevel!(1, unknown); events.onRemoteAudioLevel!(0.5, remote); });
    expect((view.container.querySelector('audio')!.srcObject as MediaStream).getTracks()).toEqual([bot]);
    expectOrb('speaking', 0.5, 'assistantSpeaking');
  });

  it('stops the call if the microphone control fails instead of falsely reporting a mute', async () => {
    const view = show(); await start(); ready(); const microphone = sdk.tracks().local.audio as MediaStreamTrack;
    sdk.enableMic.mockImplementationOnce(() => { throw new Error('private microphone diagnostic'); });
    await userEvent.click(panel().getByRole('button', { name: 'Mute microphone' }));
    expect(microphone.stop).toHaveBeenCalled();
    expect(await screen.findByRole('alert', { name: 'Microphone unavailable' })).toHaveTextContent('The call has been stopped');
    expect(view.container).not.toHaveTextContent('private microphone diagnostic');
    expect(screen.queryByRole('button', { name: 'Unmute microphone' })).not.toBeInTheDocument();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(api.endCall).toHaveBeenCalledOnce();
  });
});