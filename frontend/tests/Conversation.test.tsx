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
import { Conversation } from '../src/Conversation';
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
  enableMic: vi.fn(), enabled: true,
  listeners: new Map<string, (track: MediaStreamTrack, participant?: Participant) => void>(),
}));
const circle = vi.hoisted(() => vi.fn());
vi.mock('../src/VoiceCircle', async (original) => {
  const module = await original<typeof import('../src/VoiceCircle')>();
  return { ...module, VoiceCircle: (props: ComponentProps<typeof module.VoiceCircle>) => {
    circle(props);
    return <module.VoiceCircle {...props} />;
  } };
});
vi.mock('@pipecat-ai/client-js', async (original) => ({
  ...await original<typeof import('@pipecat-ai/client-js')>(),
  PipecatClient: class {
    constructor(options: PipecatClientOptions) { if (sdk.constructionError) throw sdk.constructionError; sdk.options = options; }
    initDevices = sdk.initDevices;
    connect = sdk.connect;
    disconnect = sdk.disconnect;
    enableMic = sdk.enableMic;
    tracks = sdk.tracks;
    get isMicEnabled() { return sdk.enabled; }
    on(name: string, callback: (track: MediaStreamTrack, participant?: Participant) => void) { sdk.listeners.set(name, callback); }
  },
}));
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: class {
  constructor(options: DailyTransportConstructorOptions) { sdk.transportOptions = options; }
  dailyCallClient = { destroy: sdk.destroy };
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const join = { callId: 'call-one', url: 'https://room.daily.co/test', token: 'short-lived-test-token', expiresAt: '2026-09-11T05:00:00Z' };
const remote: Participant = { id: 'bot', name: 'Assistant', local: false };
function track(kind = 'audio', readyState = 'live') { return Object.assign(new EventTarget(), { kind, readyState, muted: false, enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack; }
function show(props: Partial<ComponentProps<typeof Conversation>> = {}) {
  const onStarted = vi.fn();
  const onBusyChange = vi.fn();
  const onPhaseChange = vi.fn();
  const onPrepare = vi.fn();
  const onSettings = vi.fn();
  const options: ComponentProps<typeof Conversation> = { settings: { ...settings, voiceAvailable: true }, disabled: false,
    onStarted, onBusyChange, presentation: 'session', onPrepare, onPhaseChange, onSettings, ...props };
  const view = render(<><Conversation {...options} /><ToastViewport /></>);
  return { ...view, onStarted, onBusyChange, onPhaseChange, onPrepare, onSettings,
    change(changes: Partial<ComponentProps<typeof Conversation>>) {
      Object.assign(options, changes);
      view.rerender(<><Conversation {...options} /><ToastViewport /></>);
    } };
}
function panel() { return within(screen.getByRole('region', { name: 'Your conversation' })); }
async function start() {
  await userEvent.click(panel().getByRole('button', { name: /^(Start talking|Reconnect)$/ }));
  await waitFor(() => expect(sdk.connect).toHaveBeenCalled());
}
function ready() { act(() => sdk.options!.callbacks!.onBotReady!({ version: '2.1.0' })); }
async function hear(bot = track()) { await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(bot, remote)); return bot; }

beforeEach(() => {
  circle.mockClear();
  sdk.options = null; sdk.transportOptions = null; sdk.constructionError = null; sdk.listeners.clear(); sdk.enabled = true;
  for (const method of [sdk.initDevices, sdk.connect, sdk.disconnect]) method.mockReset().mockResolvedValue(undefined);
  sdk.destroy.mockReset().mockImplementation(() => { throw new Error('Calls to destroy() are disabled.'); });
  sdk.tracks.mockReset().mockReturnValue({ local: { audio: track() } });
  sdk.enableMic.mockReset().mockImplementation((enabled: boolean) => { sdk.enabled = enabled; });
  vi.spyOn(api, 'start').mockResolvedValue(snapshot());
  vi.spyOn(api, 'startCall').mockResolvedValue(join);
  vi.spyOn(api, 'endCall').mockResolvedValue({ callId: join.callId, status: 'ended', message: null });
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.stubGlobal('MediaStream', class { constructor(private tracks: MediaStreamTrack[]) {} getTracks() { return this.tracks; } });
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
    expect(screen.getByText('Captions appear as you speak')).toBeVisible();
    const hooks = ['.conversation', '.conversation-heading', '.conversation-circle-panel', '.voice-status-panel', '.voice-status-hint', '.conversation-controls', '.captions', '.live-caption', '.captions-heading', '.caption-history', '.caption-history-scroll', '.voice-more'];
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
  it.each(['ready', 'session'] as const)('keeps %s concise and privacy in an accessible dialog without starting devices', async (presentation) => {
    const view = show({ presentation });
    expect(screen.getByRole('heading', { name: 'Your conversation' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/^Ready when you are$/);
    expect(screen.getByRole('region', { name: 'Earlier captions' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Captions appear as you speak')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Conversation transcript' })).toBeEmptyDOMElement();
    expect(screen.getByRole('region', { name: 'Caption history' })).toBeVisible();
    expect(view.container.querySelector('details, summary')).toBeNull();
    expect(view.container).not.toHaveTextContent(/camera|English|microphone off|Pipecat|Daily|Azure|API_KEY|provider|Voice and AI services/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Figures kept/)).not.toBeVisible();
    const privacy = screen.getByRole('button', { name: 'Privacy' });
    expect(privacy).toHaveAttribute('aria-haspopup', 'dialog');
    privacy.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Privacy' });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText('Audio and words are processed to prepare your plan. Avoid account numbers, passwords and card details.')).toBeVisible();
    expect(within(dialog).getByText(`Figures kept ${settings.retentionHours} hours; captions only this visit.`)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close privacy' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(privacy).toHaveFocus();
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
  it.each([undefined, track('audio', 'ended')])('does not claim listening without a live local audio track: %s', async (audio) => {
    sdk.tracks.mockReturnValue({ local: { audio } });
    show(); await start(); ready();
    expect(screen.getByRole('status')).toHaveTextContent('Microphone not connected');
    act(() => sdk.options!.callbacks!.onUserStartedSpeaking!());
    expect(screen.getByRole('status')).not.toHaveTextContent(/Listening|listening/);
    const microphone = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(microphone, { ...remote, local: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Listening to you');
    act(() => sdk.listeners.get(RTVIEvent.TrackStopped)!(microphone, { ...remote, local: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Microphone not connected');
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
    expect(screen.getByRole('status')).toHaveTextContent('Microphone not connected');
  });
  it('uses connection events rather than resolved promises to claim a connection', async () => {
    const view = show(); await start();
    expect(screen.getByRole('status')).toHaveTextContent(/^Connecting$/);
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('connecting');
    act(() => sdk.options!.callbacks!.onConnected!());
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to assistant');
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
  it('keeps every finalized caption in bounded history and separates live speech without a history dialog', async () => {
    show(); await start(); ready(); const events = sdk.options!.callbacks!;
    const end = screen.getByRole('button', { name: 'End conversation' }); end.focus();
    act(() => {
      for (let index = 0; index < 29; index++) events.onUserTranscript!({ text: `Figure ${index}`, final: true, timestamp: String(index), user_id: 'me' });
      events.onUserTranscript!({ text: 'Unfinished words', final: false, timestamp: '30', user_id: 'me' });
      events.onBotOutput!({ text: 'Generated, not spoken', will_be_spoken: false, spoken_status: 'completed' });
      events.onBotOutput!({ text: 'Unknown speech status' });
    });
    const transcript = within(screen.getByRole('list', { name: 'Conversation transcript' }));
    expect(transcript.getAllByRole('listitem')).toHaveLength(29);
    expect(transcript.getByText('Figure 0')).toBeVisible(); expect(transcript.getByText('Figure 28')).toBeVisible();
    expect(transcript.queryByText('Unfinished words')).not.toBeInTheDocument();
    expect(screen.getByText('Unfinished words')).toBeVisible();
    expect(screen.queryByText('Generated, not spoken')).not.toBeInTheDocument(); expect(screen.queryByText('Unknown speech status')).not.toBeInTheDocument();
    expect(end).toHaveFocus();
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Unfinished words')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Earlier captions' })).toHaveClass('caption-history-scroll');
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    act(() => events.onUserTranscript!({ text: 'Finished words', final: true, timestamp: '30', user_id: 'me' }));
    expect(transcript.getAllByRole('listitem')).toHaveLength(29);
    expect(transcript.queryByText('Finished words')).not.toBeInTheDocument();
    expect(screen.getAllByText('Finished words')).toHaveLength(1);
    expect(end).toHaveFocus();
  });
  it('keeps controls and console regions in place through speech, captions, mute and errors', async () => {
    const view = show(); await start(); ready(); await hear();
    const panel = view.container.querySelector('.conversation')!;
    const regions = Array.from(panel.children);
    const controls = view.container.querySelector('.conversation-controls')!;
    const end = screen.getByRole('button', { name: 'End conversation' });
    const scroll = screen.getByRole('region', { name: 'Earlier captions' });
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
    expect(screen.getByRole('region', { name: 'Caption history' })).toBeVisible();
    expect(within(scroll).getAllByRole('listitem')).toHaveLength(5);
    expect(end).toHaveFocus();
    regions.forEach((region, index) => expect(panel.children[index]).toBe(region));
    act(() => { events.onBotStoppedSpeaking!(); events.onUserStartedSpeaking!(); });
    expect(screen.getByRole('status')).toHaveTextContent(/^Listening to you$/);
    await userEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(screen.getByText('Unmute to speak')).toBeVisible();
    expect(screen.getByRole('button', { name: 'End conversation' })).toBe(end);
    expect(view.container.querySelector('.conversation-controls')).toBe(controls);
    expect(screen.getByRole('region', { name: 'Earlier captions' })).toBe(scroll);
    regions.forEach((region, index) => expect(panel.children[index]).toBe(region));
    act(() => events.onError!({ label: 'rtvi-ai', id: 'error', type: 'error', data: { error: 'private details', fatal: true } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The assistant could not continue. Check your connection and try again.');
    expect(screen.getByRole('status')).toHaveTextContent(/^Unable to connect$/);
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
    await userEvent.click(panel().getByRole('button', { name: 'Retry ending call' }));
    await waitFor(() => expect(view.onBusyChange).toHaveBeenLastCalledWith(false));
  });
  it('permits retry without invoking forbidden teardown when SDK construction fails before device setup', async () => {
    sdk.constructionError = new Error('Synthetic construction failure');
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await screen.findByText(/conversation could not connect/);
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
    show(); await start(); ready(); await hear();
    const events = sdk.options!.callbacks!;
    act(() => events.onUserStartedSpeaking!()); expect(screen.getByText('Listening to you')).toBeVisible();
    act(() => events.onUserStoppedSpeaking!()); expect(screen.getByText('Listening', { exact: true })).toBeVisible();
    act(() => events.onBotLlmStarted!()); expect(screen.getByText('Thinking')).toBeVisible();
    act(() => events.onBotLlmStopped!()); expect(screen.getByText('Listening', { exact: true })).toBeVisible();
    act(() => events.onUserTranscript!({ text: 'I have', final: false, timestamp: 'one', user_id: 'me' }));
    expect(screen.getByText('You · still being transcribed')).toBeVisible();
    act(() => events.onUserTranscript!({ text: 'I have 500 rupees.', final: true, timestamp: 'one', user_id: 'me' }));
    expect(screen.queryByText('You · still being transcribed')).not.toBeInTheDocument();
    act(() => events.onBotOutput!({ text: 'Unspoken generated answer', segment_id: 1, will_be_spoken: true, spoken_status: 'new' }));
    expect(screen.queryByText('Unspoken generated answer')).not.toBeInTheDocument();
    act(() => { events.onBotStartedSpeaking!(); events.onBotOutput!({ text: 'Full future sentence', segment_id: 1, will_be_spoken: true, spoken_status: 'in-progress', spoken_progress: { accumulated_text: 'Let’s check', remaining_text: 'the bills.' } }); });
    expect(screen.getByText('Speaking')).toBeVisible(); expect(screen.getByText('Let’s check')).toBeVisible();
    expect(screen.queryByText('Full future sentence')).not.toBeInTheDocument();
    act(() => events.onBotOutput!({ text: 'Let’s check the bills.', segment_id: 1, will_be_spoken: true, spoken_status: 'completed' }));
    expect(within(screen.getByRole('list', { name: 'Conversation transcript' })).getAllByRole('listitem')).toHaveLength(1);
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
    expect(screen.getByRole('heading', { name: 'Caption history' })).toBeVisible();
    act(() => sdk.options!.callbacks!.onBotReady!({ version: '2.1' }));
    expect(screen.getByText('Conversation ended', { exact: true })).toBeVisible();
  });
  it('does not create a provider room after microphone denial', async () => {
    sdk.initDevices.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await screen.findByText(/Microphone access was denied/);
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
    expect(await screen.findByRole('status', { name: 'Microphone access denied' })).toHaveTextContent('Microphone access was denied');
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
    expect(await screen.findByRole('status', { name: 'Microphone access denied' })).toHaveTextContent('Microphone access was denied');
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
  it('releases a room returned after cancellation without connecting or permitting overlapping starts', async () => {
    const room = deferred<typeof join>(); vi.mocked(api.startCall).mockReturnValue(room.promise);
    const view = show(); await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(api.startCall).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    expect(screen.getByRole('button', { name: 'End conversation' })).toBeDisabled();
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(view.onPhaseChange).toHaveBeenLastCalledWith('ending');
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
    expect(screen.getByRole('alert', { name: 'Conversations unavailable' })).toHaveTextContent('Conversations are temporarily unavailable');
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
    expect(screen.getByText(/audio connection closed/)).toBeVisible(); expect(api.endCall).toHaveBeenCalledTimes(1);
  });
  it('does not call a backend error response a successful conclusion', async () => {
    vi.mocked(api.endCall).mockResolvedValue({ callId: join.callId, status: 'error', message: 'Provider failed' });
    show(); await start(); ready();
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await screen.findByText(/conversation stopped with an error/);
    expect(screen.queryByText('Conversation ended', { exact: true })).not.toBeInTheDocument();
  });
  it('treats an active DELETE response as unconfirmed and offers termination retry', async () => {
    vi.mocked(api.endCall).mockResolvedValue({ callId: join.callId, status: 'active', message: null });
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
    expect(screen.getByRole('heading', { name: 'Assistant · interrupted' })).toBeVisible();
    expect(screen.queryByText('Check the next bill before spending')).not.toBeInTheDocument();
    act(() => sdk.options!.callbacks!.onUserMuteStarted!());
    expect(screen.getByText('Listening paused')).toBeVisible();
    act(() => sdk.options!.callbacks!.onUserMuteStopped!());
    expect(screen.getByText('Listening', { exact: true })).toBeVisible();
  });
  it('resumes saved figures without opening the microphone, and detects an existing call', async () => {
    vi.mocked(api.call).mockResolvedValue({ callId: join.callId, status: 'active', message: null });
    const onBusyChange = vi.fn();
    render(<StrictMode><Conversation settings={settings} sessionId={snapshot().sessionId} disabled={false} onStarted={vi.fn()} onBusyChange={onBusyChange}
      presentation="session" onPrepare={vi.fn()} onPhaseChange={vi.fn()} onSettings={vi.fn()} /><ToastViewport /></StrictMode>);
    await screen.findByText('Another conversation is still open. End it before connecting here.');
    expect(sdk.initDevices).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(panel().getByRole('button', { name: 'Retry ending call' })); expect(api.endCall).toHaveBeenCalledTimes(1);
  });
});

describe('media-derived circle feedback', () => {
  it('requires bot readiness and live capture, and only claims connection after a connection event', async () => {
    show(); await start(); const events = sdk.options!.callbacks!;
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.8); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connecting', level: 0 }));
    ready();
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'listening', level: 0 }));
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    act(() => events.onConnected!());
    expect(screen.getByText('Connected', { exact: true })).toBeVisible();
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.6); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'userSpeaking', level: 0.6 }));
    act(() => events.onUserStoppedSpeaking!());
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'listening', level: 0 }));
    act(() => events.onLocalAudioLevel!(1));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'listening', level: 0 }));
    act(() => events.onTransportStateChanged!('connecting'));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'reconnecting', level: 0 }));
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    act(() => { events.onUserStartedSpeaking!(); events.onBotStartedSpeaking!(); events.onLocalAudioLevel!(1); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'reconnecting', level: 0 }));
    act(() => events.onTransportStateChanged!('ready'));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'listening', level: 0 }));
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    act(() => events.onConnected!());
    expect(screen.getByText('Connected', { exact: true })).toBeVisible();
  });

  it.each([[NaN, 0], [Infinity, 0], [-Infinity, 0], [-1, 0], [0, 0], [2, 1], [0.4, 0.4]])('bounds a local audio sample of %s to %s', async (value, level) => {
    show(); await start(); ready();
    act(() => { sdk.options!.callbacks!.onUserStartedSpeaking!(); sdk.options!.callbacks!.onLocalAudioLevel!(value); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'userSpeaking', level }));
  });

  it.each(['mute', 'pause', 'track mute', 'track disabled', 'track ended'])('clears local energy on %s and rejects further samples', async (event) => {
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    show(); await start(); ready(); const events = sdk.options!.callbacks!;
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(0.7); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ level: 0.7 }));
    if (event === 'mute') await userEvent.click(panel().getByRole('button', { name: 'Mute microphone' }));
    else act(() => {
      if (event === 'pause') events.onUserMuteStarted!();
      else {
        Object.assign(microphone, event === 'track mute' ? { muted: true } : event === 'track disabled' ? { enabled: false } : { readyState: 'ended' });
        microphone.dispatchEvent(new Event(event === 'track ended' ? 'ended' : 'mute'));
      }
    });
    act(() => { events.onUserStartedSpeaking!(); events.onLocalAudioLevel!(1); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: event === 'mute' ? 'muted' : event === 'pause' ? 'paused' : 'unavailable', level: 0 }));
  });

  it('uses only the attached assistant track during live playback and switches to actual local interruption', async () => {
    const playback = deferred<void>(); vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(playback.promise);
    const view = show(); await start(); ready(); const events = sdk.options!.callbacks!;
    act(() => { events.onBotStartedSpeaking!(); events.onRemoteAudioLevel!(1, remote); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', level: 0 }));
    const bot = await hear();
    act(() => events.onRemoteAudioLevel!(1, remote));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'paused', level: 0 }));
    await act(async () => playback.resolve());
    act(() => {
      events.onRemoteAudioLevel!(1, { ...remote, id: 'someone-else' });
      events.onRemoteAudioLevel!(1, { ...remote, local: true });
      events.onLocalAudioLevel!(1);
    });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'assistantSpeaking', level: 0 }));
    act(() => events.onRemoteAudioLevel!(0.8, remote));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'assistantSpeaking', level: 0.8 }));
    act(() => { events.onUserStartedSpeaking!(); events.onRemoteAudioLevel!(1, remote); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'interrupted', level: 0 }));
    act(() => events.onLocalAudioLevel!(0.4));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'interrupted', level: 0.4 }));
    act(() => events.onUserStoppedSpeaking!());
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'assistantSpeaking', level: 0 }));
    act(() => events.onRemoteAudioLevel!(0.6, remote));
    fireEvent.pause(view.container.querySelector('audio')!);
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'paused', level: 0 }));
    act(() => events.onRemoteAudioLevel!(1, remote));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ level: 0 }));
    fireEvent.playing(view.container.querySelector('audio')!);
    act(() => events.onRemoteAudioLevel!(0.5, remote));
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'assistantSpeaking', level: 0.5 }));
    act(() => { Object.assign(bot, { muted: true }); bot.dispatchEvent(new Event('mute')); events.onRemoteAudioLevel!(1, remote); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', level: 0 }));
    act(() => { Object.assign(bot, { muted: false, enabled: false }); bot.dispatchEvent(new Event('unmute')); events.onRemoteAudioLevel!(1, remote); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', level: 0 }));
    act(() => { Object.assign(bot, { enabled: true, readyState: 'ended' }); bot.dispatchEvent(new Event('ended')); events.onRemoteAudioLevel!(1, remote); });
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', level: 0 }));
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
      expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ level: expect.closeTo(level, 5) }));
      act(() => vi.advanceTimersByTime(199));
      expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'userSpeaking', level: expect.closeTo(level, 5) }));
      act(() => vi.advanceTimersByTime(1));
      expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'userSpeaking', level: 0 }));
      act(() => events.onLocalAudioLevel!(0.9));
      expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ level: 0.9 }));
      act(() => events.onLocalAudioLevel!(NaN));
      expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ level: 0 }));
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
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', level: 0 }));
  });
});

describe('caption receipt and speech boundaries', () => {
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
    show({ settings: { ...settings, voiceAvailable: true } }); await start(); ready();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-11T05:00:00Z'));
    const events = sdk.options!.callbacks!;
    act(() => events.onUserTranscript!({ text: 'First figure', final: true, timestamp: 'opaque', user_id: 'me' }));
    clock.mockReturnValue(Date.parse('2026-09-11T05:01:00Z'));
    act(() => {
      events.onUserTranscript!({ text: 'Corrected figure', final: true, timestamp: 'opaque', user_id: 'me' });
      events.onUserTranscript!({ text: 'A later receipt', final: true, timestamp: '2026-09-11T04:00:00Z', user_id: 'me' });
    });
    const history = screen.getByRole('list', { name: 'Conversation transcript' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(1);
    expect(within(history).getByText('Corrected figure')).toBeVisible();
    expect(history.querySelector('time')).toHaveAttribute('datetime', '2026-09-11T05:00:00.000Z');
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('A later receipt')).toBeVisible();
    act(() => events.onUserTranscript!({ text: 'Another correction', final: true, timestamp: 'opaque', user_id: 'me' }));
    expect(within(history).getByText('Another correction')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('A later receipt')).toBeVisible();
  });

  it('timestamps interim speech at its first receipt and excludes blank updates', async () => {
    show(); await start(); ready(); const events = sdk.options!.callbacks!;
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
    act(() => events.onUserTranscript!({ text: 'I have 500 rupees', final: true, timestamp: 'opaque', user_id: 'me' }));
    expect(live.querySelector('time')).toHaveAttribute('datetime', '2026-09-11T05:01:00.000Z');
    act(() => events.onUserTranscript!({ text: '', final: true, timestamp: 'empty', user_id: 'me' }));
    expect(within(live).getByText('I have 500 rupees')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Conversation transcript' })).toBeEmptyDOMElement();
  });

  it('keeps unsegmented spoken output together at its first spoken receipt and retains every prior prefix', async () => {
    show(); await start(); ready(); const events = sdk.options!.callbacks!;
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
    expect(within(screen.getByRole('list', { name: 'Conversation transcript' })).getByText('Check your bills')).toBeVisible();
    act(() => {
      events.onBotStoppedSpeaking!(); events.onUserStartedSpeaking!();
      events.onBotOutput!({ text: 'Check your bills first', will_be_spoken: true, spoken_status: 'completed' });
      events.onUserTranscript!({ text: '', final: true, timestamp: 'one', user_id: 'me' });
    });
    expect(within(live).getByText('Assistant · interrupted')).toBeVisible();
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
    expect(within(screen.getByRole('list', { name: 'Conversation transcript' })).getByText('Check your bills')).toBeVisible();
  });
});

describe('notice ownership and current actions', () => {
  it.each([['NotFoundError', 'No microphone found'], ['NotReadableError', 'Microphone in use']])('maps %s to a persistent consumer notice before creating a room', async (name, title) => {
    const published = vi.spyOn(toast, 'notify');
    sdk.initDevices.mockRejectedValueOnce(new DOMException('private device diagnostic', name));
    const view = show(); await userEvent.click(panel().getByRole('button', { name: 'Start talking' }));
    const notice = await screen.findByRole('alert', { name: title });
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ title, duration: null }));
    expect(view.container).not.toHaveTextContent('private device diagnostic');
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
  });

  it.each([
    ['permissions', 'Microphone access denied'], ['not-found', 'No microphone found'],
    ['in-use', 'Microphone in use'], ['undefined-mediadevices', 'Microphone unavailable'],
  ])('stops live capture for SDK device error %s without showing its diagnostic', async (type, title) => {
    const published = vi.spyOn(toast, 'notify');
    const microphone = track(); sdk.tracks.mockReturnValue({ local: { audio: microphone } });
    const view = show(); await start(); ready();
    const error = Object.assign(Object.create(DeviceError.prototype) as DeviceError, { type, message: 'private SDK diagnostic' });
    act(() => sdk.options!.callbacks!.onDeviceError!(error));
    expect(microphone.stop).toHaveBeenCalled();
    const notice = await screen.findByRole(type === 'permissions' ? 'status' : 'alert', { name: title });
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ title, duration: null }));
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
    expect(notice).toHaveTextContent('The audio connection closed. Check your internet connection, then reconnect.');
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

  it.each([{ sessionIssue: 'expired' as const }, { sessionId: 'another-session' }])('aborts availability when its session changes: %j', async (props) => {
    const result = deferred<typeof settings>(); const request = vi.spyOn(api, 'settings').mockReturnValue(result.promise);
    const view = show({ settings: { ...settings, voiceAvailable: false } });
    await userEvent.click(panel().getByRole('button', { name: 'Check availability' }));
    view.change(props);
    expect(request.mock.calls[0][0]!.aborted).toBe(true);
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
    vi.mocked(api.call).mockResolvedValueOnce({ callId: join.callId, status: 'active', message: null });
    const view = show({ sessionId: snapshot().sessionId });
    await screen.findByRole('alert', { name: 'A conversation is still open' });
    vi.mocked(api.call).mockResolvedValueOnce({ callId: null, status: 'error', message: 'private call diagnostic' });
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
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', level: 0 }));
    expect(panel().getByRole('status')).toHaveTextContent(/^Conversation unavailable$/);
    expect(panel().getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    expect(screen.getByText('Confirmed words')).toBeVisible();
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
    await act(async () => call.resolve({ callId: join.callId, status: 'active', message: null }));
    expect(screen.queryByRole('button', { name: 'Retry ending call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores a retained termination action after a terminal session issue supersedes its notice', async () => {
    const published = vi.spyOn(toast, 'notify');
    vi.mocked(api.call).mockResolvedValueOnce({ callId: join.callId, status: 'active', message: null });
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
    const count = circle.mock.calls.length;
    const phases = view.onPhaseChange.mock.calls.length;
    const busy = view.onBusyChange.mock.calls.length;
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
    expect(circle.mock.calls).toHaveLength(count);
    expect(view.onPhaseChange.mock.calls).toHaveLength(phases); expect(view.onBusyChange.mock.calls).toHaveLength(busy);
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
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'listening', level: 0 }));
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
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'assistantSpeaking', level: 0.4 }));
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
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', level: 0 }));
    const bot = await hear();
    act(() => { events.onRemoteAudioLevel!(1, unknown); events.onRemoteAudioLevel!(0.5, remote); });
    expect((view.container.querySelector('audio')!.srcObject as MediaStream).getTracks()).toEqual([bot]);
    expect(circle).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'assistantSpeaking', level: 0.5 }));
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