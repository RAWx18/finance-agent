// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RTVIEvent } from '@pipecat-ai/client-js';
import type { Participant, PipecatClientOptions } from '@pipecat-ai/client-js';
import { App, appRouter, mockAuth } from './appSupport';
import { api, ApiError, reportAuthLoss } from '../src/api';
import { adjustmentOptions, choiceSnapshot, planningSnapshot, questionSnapshot, scenario, settings, snapshot, Stream, unconfirmedSnapshot } from './fixtures';
import { projectWorkspace } from './workspace';
import { useSession } from '../src/session';

const sdk = vi.hoisted(() => ({
  options: null as PipecatClientOptions | null,
  initDevices: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), destroy: vi.fn(), tracks: vi.fn(),
  enableMic: vi.fn(), enabled: true,
  dailyOn: vi.fn(), dailyOff: vi.fn(),
  listeners: new Map<string, (track: MediaStreamTrack, participant?: Participant) => void>(),
}));
vi.mock('@pipecat-ai/client-js', async original => ({
  ...await original<typeof import('@pipecat-ai/client-js')>(),
  PipecatClient: class {
    constructor(options: PipecatClientOptions) { sdk.options = options; sdk.enabled = options.enableMic ?? true; }
    initDevices = sdk.initDevices;
    connect = sdk.connect;
    disconnect = sdk.disconnect;
    enableMic = sdk.enableMic;
    tracks = sdk.tracks;
    get isMicEnabled() { return sdk.enabled; }
    on(name: string, callback: (track: MediaStreamTrack, participant?: Participant) => void) { sdk.listeners.set(name, callback); }
  },
}));
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: class { dailyCallClient = { destroy: sdk.destroy, on: sdk.dailyOn, off: sdk.dailyOff }; } }));

const join = { conversationSlug: 'conversation-2026-09-12-000000', url: 'https://room.daily.co/test', token: 'test-only-token' };
const local: Participant = { id: 'consumer', name: 'You', local: true };
function track(readyState = 'live') {
  return Object.assign(new EventTarget(), { kind: 'audio', readyState, stop: vi.fn() }) as unknown as MediaStreamTrack;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function updates() {
  await waitFor(() => expect(Stream.instances).toHaveLength(1));
  const initial = await vi.mocked(api.current).mock.results.at(-1)!.value;
  act(() => { Stream.instances[0].onopen?.(); Stream.instances[0].emit('snapshot', initial); });
  return Stream.instances[0];
}
async function connect() {
  const start = await screen.findByRole('button', { name: 'Start conversation' });
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start);
  await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
  await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
}
function ready() { act(() => sdk.options!.callbacks!.onBotReady!({ version: '2.1.0' })); }
function conversation() { return within(screen.getByRole('region', { name: 'Your conversation' })); }
function livePicture() { return within(screen.getByRole('region', { name: 'Your financial picture' })); }
function voiceStatus() { return conversation().getByText(/.+/, { selector: '.voice-status' }); }
function moneyLink() { return within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' }); }
async function planChanges() {
  await userEvent.click(within(screen.getByRole('navigation', { name: 'Money navigation' })).getByRole('link', { name: 'Plan changes' }));
  expect(screen.getByRole('main')).toHaveAttribute('data-route', '/money/changes');
}

beforeEach(() => {
  mockAuth();
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  sdk.options = null; sdk.listeners.clear(); sdk.enabled = true;
  for (const method of [sdk.connect, sdk.disconnect, sdk.destroy]) method.mockReset().mockResolvedValue(undefined);
  sdk.tracks.mockReset().mockReturnValue({ local: { audio: track() } });
  sdk.enableMic.mockReset().mockImplementation((enabled: boolean) => { sdk.enabled = enabled; });
  vi.stubGlobal('MediaStream', class { constructor(private tracks: MediaStreamTrack[]) {} getTracks() { return this.tracks; } });
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(new MediaStream([sdk.tracks().local.audio])) },
  }));
  sdk.initDevices.mockReset().mockImplementation(async () => { await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(api, 'settings').mockResolvedValue({ ...settings, voiceAvailable: true, voiceUnavailableReason: null });
  vi.spyOn(api, 'current').mockResolvedValue(snapshot());
  vi.spyOn(api, 'start').mockResolvedValue(snapshot());
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', cleanupConfirmed: true, message: null });
  vi.spyOn(api, 'startCall').mockImplementation(async callId => {
    const saved = await vi.mocked(api.start).mock.results.at(-1)!.value;
    saved.conversationSlug = join.conversationSlug;
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.start).mockResolvedValue(saved);
    return { ...join, callId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  });
  vi.spyOn(api, 'endCall').mockImplementation(async callId => ({ callId, status: 'ended', cleanupConfirmed: true, message: null }));
  vi.spyOn(api, 'save').mockResolvedValue({ ...planningSnapshot(), revision: 1, sequence: 1 });
  vi.spyOn(api, 'delete').mockResolvedValue({ deleted: true });
  vi.spyOn(api, 'options').mockResolvedValue(adjustmentOptions);
});

describe('App voice and financial journey', () => {
    it('keeps Conversation free of review, take-plan and download destinations at ready, active and ended', async () => {
      vi.mocked(api.current).mockResolvedValue(planningSnapshot());
      vi.mocked(api.start).mockResolvedValue(planningSnapshot());
      render(<App />); await updates();
      const link = moneyLink();
      const audio = document.querySelector('audio');
      await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
      const picture = screen.getByRole('region', { name: 'Your financial picture' });
      const call = screen.getByRole('region', { name: 'Your conversation' });
      const summary = picture.querySelector('.plan-summary');
      expect(summary).toBeVisible();
      const absent = () => {
        const removed = /^(Review|Take your plan|Finish review|Review saved picture|Return to conversation|View full plan|Continue talking|Download.*)$/i;
        expect(screen.queryByRole('navigation', { name: /journey|progress|plan steps/i })).not.toBeInTheDocument();
        expect(screen.queryAllByRole('button', { name: removed })).toEqual([]);
        expect(screen.queryAllByRole('link', { name: removed })).toEqual([]);
        expect(document.querySelector('.journey-progress, .review-controls, .review-layout, .post-call')).not.toBeInTheDocument();
        expect(document.querySelector('.page-feedback')).not.toBeVisible();
        expect(screen.getAllByRole('link', { name: 'Money' })).toEqual([link]);
        expect(link).toHaveAttribute('href', '/money');
        expect(screen.getByRole('region', { name: 'Your conversation' })).toBe(call);
        expect(call).toBeVisible(); expect(picture).toBeVisible();
        expect(picture.querySelector('.plan-summary')).toBe(summary);
        expect(document.querySelector('audio')).toBe(audio);
      };
      expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready'); absent();
      expect(sdk.options).toBeNull(); expect(sdk.initDevices).not.toHaveBeenCalled();
      expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
      await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce()); ready();
      expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session'); absent();
      expect(link).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
      await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ended'));
      expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session'); absent();
      expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
      expect(link).not.toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(link);
      await userEvent.click(screen.getByRole('button', { name: 'Plan tools' }));
      const tools = screen.getByRole('dialog', { name: 'Plan tools' });
      expect(screen.getAllByRole('link', { name: /Download/ })).toHaveLength(2);
      expect(document.querySelector('.money-overview a[download]')).toHaveAccessibleName('Download saved plan');
      expect(within(tools).getByRole('link', { name: 'Download saved plan' })).toHaveAttribute('href', '/api/session/export');
      expect(within(tools).getByRole('button', { name: 'Print saved plan' })).toBeEnabled();
      expect(api.save).not.toHaveBeenCalled();
    });
  it.each([false, true])('preserves a conflicting refusal and retries its exact session command without mutation (retry: %s)', async retry => {
    const saved = choiceSnapshot(); saved.revision = 1; saved.sequence = 1;
    saved.preview = scenario(); saved.preview.sourceRevision = 1; saved.preview.adjustments[0].amountPaise = 50000;
    const original = structuredClone(saved);
    vi.mocked(api.current).mockResolvedValue(saved);
    if (retry) vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'));
    vi.mocked(api.save).mockRejectedValueOnce(new ApiError(409, { code: 'stalePreview', message: 'private conflicting proposal diagnostic', snapshot: structuredClone(saved) }))
      .mockResolvedValueOnce(projectWorkspace({ ...saved, sequence: 2, preview: null }));
    const { result } = renderHook(useSession); const stream = await updates();
    await act(async () => { await result.current.perform('save', { type: 'respondToAction', actionId: 'preview-spending', response: 'declined' }); });
    if (retry) {
      expect(result.current.state.pending).not.toBeNull();
      await act(async () => { await result.current.perform('save'); });
    }
    expect(result.current.state.pending).toBeNull();
    expect(result.current.state.snapshot).toEqual(original);
    expect(result.current.state.message).toBe('Your answer was not saved because the open proposal differs from this suggested cut. Review the proposal or choose “Reject preview” before answering again.');
    act(() => stream.emit('snapshot', saved));
    expect(result.current.state.messageKind).toBe('error');
    const commands = vi.mocked(api.save).mock.calls;
    expect(commands).toHaveLength(retry ? 2 : 1);
    expect(commands[0][0].operation).toEqual({ type: 'respondToAction', actionId: 'preview-spending', response: 'declined' });
    if (retry) expect(commands[1][0]).toBe(commands[0][0]);
    await act(async () => { await result.current.perform('save', { type: 'rejectPreview', previewId: saved.preview!.id }); });
    expect(commands.at(-1)![0]).toMatchObject({ expectedRevision: saved.revision,
      operation: { type: 'rejectPreview', previewId: saved.preview.id } });
    expect(commands.at(-1)![0].commandId).not.toBe(commands[0][0].commandId);
    act(() => stream.emit('snapshot', saved));
    expect(result.current.state.snapshot?.preview).toBeNull();
    expect(result.current.state.snapshot?.facts).toEqual(original.facts);
    expect(result.current.state.snapshot?.plan).toEqual(original.plan);
    expect(result.current.state.messageKind).toBe('status');
    expect(commands).toHaveLength(retry ? 3 : 2);
    expect(saved).toEqual(original);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(api.options).not.toHaveBeenCalled();
  });

  it('shows changed-next-step guidance for an invalid answer and clears it on a newer live snapshot without inventing figures', async () => {
    vi.mocked(api.current).mockResolvedValue(questionSnapshot());
    vi.mocked(api.save).mockRejectedValueOnce(new ApiError(422, {
      code: 'invalidActionResponse', message: 'private unsupported action diagnostic', snapshot: questionSnapshot(),
    }));
    const { result } = renderHook(useSession); const stream = await updates();
    await act(async () => { await result.current.perform('save', { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' }); });
    expect(result.current.state.message).toBe('Your answer was not saved because this next step has changed or is no longer available. Review the current next step before answering again.');
    expect(result.current.state.pending).toBeNull();
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: 0,
      operation: { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' } });
    act(() => stream.emit('snapshot', { ...snapshot(), sequence: 1 }));
    expect(result.current.state.message).toBe('');
    expect(result.current.state.snapshot?.facts.opening.amountPaise).toBeNull();
    expect(api.endCall).not.toHaveBeenCalled();
  });

  it.each(['acceptPreview', 'rejectPreview', 'discardPreview'] as const)('reviews and retries %s in the live surface without opening the editor or restarting the call', async operation => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const saved = planningSnapshot(); saved.revision = 1; saved.sequence = 1;
    const preview = scenario(); preview.sourceRevision = 1; saved.preview = preview;
    const confirmed = structuredClone(saved); confirmed.sequence = 2; confirmed.preview = null;
    if (operation === 'acceptPreview') {
      confirmed.revision = 2;
      confirmed.accepted = { ...preview, adjustments: preview.adjustments.map(item => ({ ...item, acceptedRevision: 2 })) };
    }
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValueOnce(projectWorkspace(confirmed));
    const audio = document.querySelector('audio');
    const end = conversation().getByRole('button', { name: 'End conversation' }); end.focus();
    act(() => stream.emit('snapshot', saved));
    expect(end).toHaveFocus();
    const proposal = screen.getByRole('article', { name: 'Plan changes' });
    expect(proposal).toHaveTextContent('₹2,000 Reported → to ₹0 Proposed');
    expect(within(proposal).getByLabelText('First shortfall impact')).toHaveTextContent('₹7,000 · 13 Sept');
    expect(proposal).toHaveTextContent('Whole proposal · Dates unchanged · No payment made');
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
    if (operation === 'acceptPreview') {
      await userEvent.click(within(proposal).getByRole('button', { name: 'Accept planning assumptions' }));
      expect(api.save).not.toHaveBeenCalled();
      await userEvent.click(within(proposal).getByRole('checkbox'));
    }
    await userEvent.click(within(proposal).getByRole('button', { name: operation === 'acceptPreview' ? 'Accept planning assumptions' : operation === 'rejectPreview' ? 'Reject preview' : 'Close preview' }));
    const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
    const retry = within(notice).getByRole('button', { name: 'Retry same action' });
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Save not confirmed' })).toBe(notice);
    expect(within(proposal).getByRole('alert')).toHaveTextContent('Decision not confirmed');
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('checkbox')).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeDisabled();
    expect(end).toBeEnabled();
    const command = vi.mocked(api.save).mock.calls[0][0];
    expect(command.expectedRevision).toBe(saved.revision);
    expect(command.commandId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
    expect(command.operation).toEqual(operation === 'acceptPreview'
      ? { type: 'acceptPreview', previewId: preview.id, confirmed: true, consentScope: 'unconditional' }
      : { type: operation, previewId: preview.id });
    act(() => { stream.emit('snapshot', confirmed); stream.emit('snapshot', saved); });
    expect(screen.queryByRole('button', { name: 'Accept planning assumptions' })).not.toBeInTheDocument();
    expect(retry).toBeVisible();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument());
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹7,000');
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    if (operation === 'acceptPreview') {
      const assumptions = screen.getByRole('article', { name: 'Plan changes' });
      expect(assumptions).toHaveTextContent('Saved assumptions · not paid');
    }
    expect(document.querySelector('audio')).toBe(audio);
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(api.options).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'declined'] as const)('retries a lost %s answer with its identical command after SSE advances the selected action', async response => {
    const saved = response === 'unavailable' ? questionSnapshot() : choiceSnapshot();
    const confirmed = response === 'unavailable' ? unconfirmedSnapshot() : structuredClone(saved);
    if (response === 'declined') {
      confirmed.revision = 1; confirmed.sequence = 1;
      confirmed.facts.decision = { ...confirmed.facts.decision!, responses: [{ actionId: 'preview-spending', response, dependencyKey: 'spending-terms' }] };
      confirmed.plan.decisionAssessment!.actions = [confirmed.plan.decisionAssessment!.actions![0]];
      confirmed.plan.decisionAssessment!.nextActionId = confirmed.plan.decisionAssessment!.actions[0].id;
    }
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValueOnce(projectWorkspace(confirmed));
    const { result } = renderHook(useSession); const stream = await updates();
    await act(async () => { await result.current.perform('save', { type: 'respondToAction', actionId: saved.plan.decisionAssessment!.nextActionId!, response }); });
    const command = vi.mocked(api.save).mock.calls[0][0];
    expect(command.operation).toEqual({ type: 'respondToAction', actionId: saved.plan.decisionAssessment!.nextActionId, response });
    act(() => stream.emit('snapshot', confirmed));
    expect(result.current.state.pending).toBe(command);
    expect(result.current.state.snapshot?.plan.decisionAssessment?.nextActionId).toBe(confirmed.plan.decisionAssessment!.actions![0].id);
    await act(async () => { await result.current.perform('save'); });
    expect(result.current.state.pending).toBeNull();
    expect(vi.mocked(api.save).mock.calls).toHaveLength(2);
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(command.expectedRevision).toBe(saved.revision);
    act(() => stream.emit('snapshot', saved));
    expect(result.current.state.snapshot).toEqual(confirmed);
    expect(result.current.state.snapshot?.facts.decision?.responses?.[0].response).toBe(response);
    expect(api.endCall).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
  });

  it('saves an unavailable first answer and follows the server-selected question without inventing cash', async () => {
    vi.mocked(api.current).mockResolvedValue(questionSnapshot());
    const deferred = unconfirmedSnapshot();
    vi.mocked(api.save).mockResolvedValueOnce(deferred);
    const { result } = renderHook(useSession); const stream = await updates();
    await act(async () => { await result.current.perform('save', { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' }); });
    expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({ expectedRevision: 0,
      operation: { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' } });
    expect(result.current.state.snapshot?.plan.decisionAssessment?.nextActionId).toBe(deferred.plan.decisionAssessment!.actions![0].id);
    expect(result.current.state.snapshot?.facts.opening.amountPaise).toBeNull();
    act(() => stream.emit('snapshot', snapshot()));
    expect(result.current.state.snapshot).toEqual(deferred);
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.options).not.toHaveBeenCalled();
  });

  it.each(['reduceOptional', 'cardMinimum'] as const)('saves a declined %s answer and follows the next action without removing the cash gap', async kind => {
    const { result } = renderHook(useSession); const stream = await updates();
    const saved = choiceSnapshot(kind); saved.revision = 1; saved.sequence = 1;
    const declined = structuredClone(saved); declined.revision = 2; declined.sequence = 2;
    declined.facts.decision = { ...declined.facts.decision!, responses: [{ actionId: 'preview-spending', response: 'declined', dependencyKey: 'spending-terms' }] };
    declined.plan.decisionAssessment!.actions = [declined.plan.decisionAssessment!.actions![0]];
    declined.plan.decisionAssessment!.nextActionId = declined.plan.decisionAssessment!.actions[0].id;
    vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace(declined));
    act(() => stream.emit('snapshot', saved));
    await act(async () => { await result.current.perform('save', { type: 'respondToAction', actionId: 'preview-spending', response: 'declined' }); });
    expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({ expectedRevision: saved.revision,
      operation: { type: 'respondToAction', actionId: 'preview-spending', response: 'declined' } });
    expect(result.current.state.snapshot?.plan.decisionAssessment?.nextActionId).toBe('contact:rent:2026-09-13');
    expect(result.current.state.snapshot?.plan.firstGap).toEqual(saved.plan.firstGap);
    act(() => stream.emit('snapshot', saved));
    expect(result.current.state.snapshot).toEqual(declined);
    expect(declined.facts.records).toEqual(saved.facts.records);
    expect(api.endCall).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
  });

  it('prepares from StrictMode landing without creating a session or opening devices, then requests microphone before the room', async () => {
    vi.mocked(api.current).mockRejectedValue(new ApiError(404, { code: 'notFound', message: 'No session' }));
    const permission = deferred<MediaStream>();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(permission.promise);
    const view = render(<StrictMode><App /></StrictMode>);
    const start = await screen.findByRole('button', { name: 'Start conversation' });
    await waitFor(() => expect(start).toBeEnabled());
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'landing');
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(sdk.options).toBeNull();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Plan focus' })).not.toBeInTheDocument();
    const audio = view.container.querySelector('audio');
    await userEvent.click(start);
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Let’s talk it through.');
    expect(voiceStatus()).toHaveTextContent('Ready when you are');
    expect(screen.queryByRole('heading', { name: 'Ready when you are' })).not.toBeInTheDocument();
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(sdk.options).toBeNull();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your financial picture' })).toHaveTextContent('Figures appear as you talk');
    await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(sdk.options).toMatchObject({ enableMic: false, enableCam: false });
    expect(sdk.enableMic).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByText('Figures appear as you talk')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Prefer typing?' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
    await act(async () => permission.resolve(new MediaStream([sdk.tracks().local.audio])));
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.startCall).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
    act(() => Stream.instances[0].onopen?.());
    expect(api.startCall).not.toHaveBeenCalled();
    act(() => Stream.instances[0].emit('snapshot', snapshot()));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledWith({ url: join.url, token: join.token }));
    expect(vi.mocked(navigator.mediaDevices.getUserMedia).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.start).mock.invocationCallOrder[0]);
    expect(vi.mocked(api.start).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.startCall).mock.invocationCallOrder[0]);
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(voiceStatus()).toHaveTextContent(/^Connecting$/);
    act(() => sdk.options!.callbacks!.onConnected!());
    expect(voiceStatus()).toHaveTextContent('Connecting to assistant');
    ready();
    expect(voiceStatus()).toHaveTextContent(/^Listening$/);
    expect(sdk.enableMic).toHaveBeenCalledWith(true);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Let’s talk it through.');
    expect(screen.getByRole('region', { name: 'Your conversation' }).querySelector('details')).not.toBeInTheDocument();
    expect(view.container.querySelector('video')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /camera/i })).not.toBeInTheDocument();
    expect(view.container.querySelector('audio')).toBe(audio);
  });

  it.each(['/money', '/account'])('returns from %s to the latest local conversation without opening the microphone', async route => {
    vi.mocked(api.current).mockResolvedValue(planningSnapshot());
    const router = appRouter('/app');
    render(<RouterProvider router={router} />);
    const stream = await updates();
    await userEvent.click(await screen.findByRole('button', { name: 'Start conversation' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready'));
    const audio = document.querySelector('audio');
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await act(async () => router.navigate(route));
    await waitFor(() => expect(router.state.location.pathname).toBe(route));
    if (route === '/money') await screen.findByRole('region', { name: 'Money' });
    else await screen.findByRole('heading', { name: 'Settings', level: 1 });
    const corrected = planningSnapshot(); corrected.sequence = 1; corrected.revision = 1;
    corrected.facts.opening.amountPaise = 765432;
    corrected.facts.records[0].label = 'Home rent';
    corrected.facts.records[0].amount.amountPaise = 1100000;
    corrected.facts.records[0].schedule.date = '2026-09-14';
    corrected.plan.events[0].date = '2026-09-14';
    act(() => stream.emit('snapshot', corrected));
    await act(async () => router.navigate('/app'));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready');
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).getByRole('article', { name: 'Cash & timing' })).toHaveTextContent('₹7,654.32');
    expect(within(picture).getByRole('listitem', { name: 'Home rent' })).toHaveTextContent('₹11,000');
    expect(within(picture).getByRole('listitem', { name: 'Home rent' })).toHaveTextContent('14 Sept');
    act(() => stream.emit('snapshot', planningSnapshot()));
    expect(within(picture).getByRole('article', { name: 'Cash & timing' })).toHaveTextContent('₹7,654.32');
    expect(within(picture).queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
    expect(document.querySelector('audio')).toBe(audio);
    expect(Stream.instances).toHaveLength(1);
    expect(stream.closed).toBe(false);
    expect(api.current).toHaveBeenCalledOnce();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(sdk.initDevices).not.toHaveBeenCalled();
    vi.mocked(api.start).mockResolvedValueOnce(corrected);
    await userEvent.click(conversation().getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
    ready();
    expect(voiceStatus()).toHaveTextContent(/^Listening$/);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(api.startCall).toHaveBeenCalledOnce();
    expect(api.start).toHaveBeenCalledOnce();
    expect(Stream.instances).toHaveLength(1);
    expect(stream.closed).toBe(false);
    expect(within(picture).getByRole('article', { name: 'Cash & timing' })).toHaveTextContent('₹7,654.32');
    expect(within(picture).getByRole('listitem', { name: 'Home rent' })).toHaveTextContent('₹11,000');
    expect(api.save).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
  });

  it('checks unavailable voice safely without starting a session or microphone', async () => {
    vi.mocked(api.settings).mockResolvedValueOnce(settings).mockRejectedValueOnce(new Error('AZURE private diagnostic'))
      .mockResolvedValue({ ...settings, voiceAvailable: true, voiceUnavailableReason: null });
    render(<App />); await updates();
    const start = screen.getByRole('button', { name: 'Start conversation' });
    expect(start).toBeEnabled(); await userEvent.click(start);
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled();
    expect(screen.getByText('Conversations unavailable', { selector: '.voice-status' })).toBeVisible();
    await userEvent.click(conversation().getByRole('button', { name: 'Check availability' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check availability. Check your connection and try again.');
    for (const element of screen.queryAllByText(/AZURE|DAILY_API_KEY|private diagnostic|Missing setup/)) expect(element).not.toBeVisible();
    await userEvent.click(conversation().getByRole('button', { name: 'Check availability' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled());
    expect(api.settings).toHaveBeenCalledTimes(3);
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('reports denied microphone access without creating a session or room and allows retry', async () => {
    sdk.initDevices.mockRejectedValueOnce(new DOMException('Private permission diagnostic', 'NotAllowedError'));
    render(<App />); await updates();
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(voiceStatus()).toHaveTextContent('Unable to connect'));
    const notice = screen.getByRole('status', { name: 'Microphone access denied' });
    expect(within(notice).getByText('Allow microphone access in your browser’s site settings, then try again.')).toBeVisible();
    expect(notice).not.toHaveTextContent('Microphone access was denied.');
    expect(notice).not.toHaveTextContent('Private permission diagnostic');
    expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
  });

  it('keeps the live call and captions mounted through card expansion and corrections and reports actual activity', async () => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const saved = planningSnapshot(); saved.sequence = 1;
    saved.facts.records.push(...Array.from({ length: 4 }, (_, index) => ({
      id: `bill-${index}`, label: `Bill ${index + 1}`, kind: 'essential' as const,
      amount: { status: 'unknown' as const, amountPaise: null },
      schedule: { date: null, recurrence: 'once' as const, certainty: 'unknown' as const }, autoDebit: false,
    })));
    act(() => stream.emit('snapshot', saved));
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const audio = document.querySelector('audio');
    const end = conversation().getByRole('button', { name: 'End conversation' });
    await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(track(), { id: 'assistant', name: 'Assistant', local: false }));
    act(() => sdk.options!.callbacks!.onBotLlmStarted!());
    expect(voiceStatus()).toHaveTextContent(/^Thinking$/);
    act(() => { sdk.options!.callbacks!.onBotLlmStopped!(); sdk.options!.callbacks!.onBotStartedSpeaking!(); });
    expect(voiceStatus()).toHaveTextContent(/^Speaking$/);
    act(() => sdk.options!.callbacks!.onUserStartedSpeaking!());
    expect(voiceStatus()).toHaveTextContent('Interrupted · listening');
    act(() => { sdk.options!.callbacks!.onBotStoppedSpeaking!(); sdk.options!.callbacks!.onUserStoppedSpeaking!(); sdk.options!.callbacks!.onUserMuteStarted!(); });
    expect(voiceStatus()).toHaveTextContent('Listening paused');
    act(() => sdk.options!.callbacks!.onUserMuteStopped!());
    expect(voiceStatus()).toHaveTextContent(/^Listening$/);
    await userEvent.click(conversation().getByRole('button', { name: 'Mute microphone' }));
    expect(voiceStatus()).toHaveTextContent('Microphone muted');
    await userEvent.click(conversation().getByRole('button', { name: 'Unmute microphone' }));
    expect(voiceStatus()).toHaveTextContent(/^Listening$/);
    act(() => sdk.options!.callbacks!.onUserTranscript!({ text: 'Please check my rent.', final: true, user_id: 'consumer', timestamp: '2026-09-11T04:01:00Z' }));
    const captions = conversation().getByRole('region', { name: 'Live caption' });
    expect(captions).toHaveTextContent('Please check my rent.');
    const list = within(picture).getByRole('list', { name: 'Next commitments' });
    expect(list).toBeVisible();
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    await userEvent.click(within(picture).getByRole('button', { name: 'Show 1 more' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getByRole('listitem', { name: 'Bill 4' })).toHaveTextContent('Unknown');
    expect(within(picture).queryByRole('button', { name: /View all figures|Edit figures|What this is based on/ })).not.toBeInTheDocument();
    await userEvent.click(within(picture).getByRole('button', { name: 'Edit Rent amount' }));
    const amount = screen.getByRole('textbox', { name: 'Rent amount' });
    expect(amount).toHaveFocus();
    const corrected = structuredClone(saved); corrected.sequence = 2; corrected.revision = 1;
    corrected.facts.records[4].amount = { status: 'exact', amountPaise: 12345 };
    act(() => stream.emit('snapshot', corrected));
    expect(within(list).getByRole('listitem', { name: 'Bill 4' })).toHaveTextContent('₹123.45');
    expect(amount).toHaveFocus();
    expect(document.querySelector('audio')).toBe(audio);
    expect(end).toBeInTheDocument(); expect(captions).toBeInTheDocument();
    expect(sdk.disconnect).not.toHaveBeenCalled(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Rent amount' }));
    expect(captions).toBeVisible();
    expect(conversation().getByRole('button', { name: 'End conversation' })).toBe(end);
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('region', { name: 'Your conversation' }).querySelector('details')).not.toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('requires BotReady and a live local track, not SSE or a resolved SDK connection, to claim listening', async () => {
    sdk.tracks.mockReturnValue({ local: {} });
    render(<App />); const stream = await updates(); await connect();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    expect(voiceStatus()).toHaveTextContent(/^Connecting$/);
    act(() => sdk.options!.callbacks!.onTransportStateChanged!('ready'));
    expect(conversation().queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
    ready();
    expect(voiceStatus()).toHaveTextContent('Microphone not connected');
    const microphone = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(microphone, local));
    expect(voiceStatus()).toHaveTextContent(/^Listening$/);
    act(() => {
      Object.assign(microphone, { readyState: 'ended' });
      microphone.dispatchEvent(new Event('ended'));
    });
    await waitFor(() => expect(api.endCall).toHaveBeenCalledOnce());
    await waitFor(() => expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled());
    expect(voiceStatus()).toHaveTextContent('Unable to connect');
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(document.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    expect(document.querySelector('.call-orb')).toHaveAttribute('data-volume', '0');
    expect(conversation().queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹7,000');
  });

  it('keeps authoritative corrections and the same conversation mounted through End, newer SSE and reconnect', async () => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const audio = document.querySelector('audio');
    const call = screen.getByRole('region', { name: 'Your conversation' });
    const saved = planningSnapshot(); saved.revision = 1; saved.sequence = 1;
    saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { status: 'exact', amountPaise: 3000000 },
      schedule: { date: '2026-09-25', recurrence: 'monthly', certainty: 'exact' }, reliability: 'reliable', autoDebit: false });
    act(() => stream.emit('snapshot', saved));
    expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'taking-shape');
    expect(screen.getByRole('heading', { name: 'Your financial picture' })).toBeVisible();
    expect(screen.getByRole('article', { name: 'Cash & timing' })).toHaveTextContent('₹5,000');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹30,000');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('25 Sept');
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹7,000');
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('13 Sept');
    const records = within(screen.getByRole('region', { name: 'Financial picture details' })).getAllByRole('article');
    expect(records.map(item => item.getAttribute('aria-label'))).toEqual(['Cash & timing', 'Next & commitments']);
    const end = screen.getByRole('button', { name: 'End conversation' }); end.focus();
    act(() => sdk.options!.callbacks!.onUserStartedSpeaking!());
    const corrected = structuredClone(saved); corrected.revision = 2; corrected.sequence = 2;
    corrected.facts.records[1].amount.amountPaise = 3200000;
    corrected.facts.records[1].schedule.date = '2026-09-20';
    corrected.plan.firstGap = { date: '2026-09-16', amountPaise: 1234567 };
    corrected.plan.peakGapPaise = 2345678; corrected.plan.peakGapDate = '2026-09-19'; corrected.plan.closingPaise = 7654321;
    corrected.plan.decisionAssessment = { ...corrected.plan.decisionAssessment,
      uncertainties: [{ id: 'salary:timing', kind: 'uncertain', recordIds: ['salary'], field: 'schedule.date',
        question: 'Verify the corrected receipt timing.', changes: ['when', 'affordability'], blocks: ['immediateDecision', 'fullPlan'],
        priority: 10, reason: 'The receipt date determines whether earlier commitments are covered.', beforeDate: '2026-09-16' }],
      consequences: [{ id: 'cash:2026-09-16', kind: 'cashExposure', eventIds: [], date: '2026-09-16', amountPaise: 1234567 }],
      actions: [{ id: 'checkTiming', kind: 'clarify', question: 'Verify the corrected receipt timing.', beforeDate: '2026-09-16',
        recordIds: ['salary'], consequenceIds: ['cash:2026-09-16'], ifDeclinedConsequenceIds: [] }],
      nextQuestionId: 'salary:timing', nextActionId: 'checkTiming',
      outcome: { ...corrected.plan.decisionAssessment!.outcome!, nextActionId: 'checkTiming',
        summary: 'The corrected receipt timing needs checking.', nextStep: 'Verify the corrected receipt timing.',
        uncertain: ['salary:timing'], riskIds: ['cash:2026-09-16'] },
    };
    corrected.workspace!.change = { id: 'salary-correction', revision: 2, items: [{ id: 'salary', state: 'updated', cardIds: ['income'], recordIds: ['salary'], resultIds: ['closing'], fields: [
      { reference: 'facts.records.salary.amount.amountPaise', before: 3000000, after: 3200000 },
      { reference: 'facts.records.salary.schedule.date', before: '2026-09-25', after: '2026-09-20' },
      { reference: 'workspace.results.firstGap.amountPaise', before: 700000, after: 1234567 },
      { reference: 'workspace.results.firstGap.date', before: '2026-09-13', after: '2026-09-16' },
      { reference: 'workspace.results.closing.amountPaise', before: 1000000, after: 7654321 },
    ] }] };
    act(() => stream.emit('snapshot', corrected));
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹32,000');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('20 Sept');
    expect(screen.getByRole('listitem', { name: 'Salary' })).not.toHaveTextContent(/₹30,000|25 Sept/);
    const changes = within(screen.getByRole('region', { name: 'Your financial picture' })).getByRole('status');
    expect(changes).toHaveAttribute('aria-live', 'polite');
    expect(within(screen.getByRole('region', { name: 'Financial picture details' })).getAllByRole('article')).toEqual(records);
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹12,345.67');
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('16 Sept');
    expect(voiceStatus()).toHaveTextContent('Listening to you');
    expect(end).toHaveFocus();
    act(() => { stream.emit('snapshot', saved); stream.emit('snapshot', { ...saved, sequence: corrected.sequence }); });
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹32,000');
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹12,345.67');
    expect(voiceStatus()).toHaveTextContent('Listening to you');
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
    const ending = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValue(ending.promise);
    await userEvent.click(end);
    expect(sdk.tracks().local.audio.stop).toHaveBeenCalled();
    expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ended');
    expect(call).toHaveAttribute('data-cleanup-pending', 'true');
    expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    const callId = vi.mocked(api.startCall).mock.calls[0][0];
    expect(api.endCall).toHaveBeenCalledExactlyOnceWith(callId);
    await act(async () => ending.resolve({ callId, status: 'ended', cleanupConfirmed: true, message: null }));
    await waitFor(() => expect(call).toHaveAttribute('data-cleanup-pending', 'false'));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ended'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Let’s talk it through.');
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).getByLabelText('Projected closing cash')).toHaveTextContent('₹76,543.21');
    expect(screen.getByRole('region', { name: 'Your conversation' })).toBe(call);
    expect(call).toBeVisible();
    expect(document.querySelector('.voice-container')).not.toHaveAttribute('hidden');
    expect(document.querySelector('audio')).toBe(audio);
    expect(voiceStatus()).toHaveTextContent('Conversation ended');
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
    expect(document.querySelector('audio')!.srcObject).toBeFalsy();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    act(() => stream.onerror?.());
    const reconnect = conversation().getByRole('button', { name: 'Reconnect' });
    expect(reconnect).toBeDisabled();
    act(() => stream.onopen?.());
    expect(reconnect).toBeDisabled();
    act(() => stream.emit('snapshot', saved));
    expect(reconnect).toBeDisabled();
    const latest = structuredClone(corrected); latest.sequence = 3; latest.revision = 3;
    latest.conversationSlug = join.conversationSlug;
    latest.facts.records[1].amount.amountPaise = 3300000;
    latest.plan.closingPaise = 7754321;
    act(() => { stream.emit('snapshot', latest); stream.emit('snapshot', corrected); });
    await waitFor(() => expect(reconnect).toBeEnabled());
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ended');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹33,000');
    expect(within(picture).getByLabelText('Projected closing cash')).toHaveTextContent('₹77,543.21');
    expect(screen.queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument();
    expect(sdk.connect).toHaveBeenCalledOnce();
    vi.mocked(api.start).mockResolvedValueOnce(latest);
    await userEvent.click(reconnect);
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(2)); ready();
    expect(screen.getByRole('region', { name: 'Your conversation' })).toBe(call);
    expect(screen.getByRole('region', { name: 'Your financial picture' })).toBe(picture);
    expect(document.querySelector('audio')).toBe(audio);
    expect(voiceStatus()).toHaveTextContent('Listening');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹33,000');
    expect(stream.closed).toBe(false);
    expect(api.save).not.toHaveBeenCalled();
    expect(saved.facts.coverage).toEqual(snapshot().facts.coverage);
  });

  it('invalidates previously reviewed Money assumptions on newer SSE without leaving Conversation', async () => {
    const saved = planningSnapshot(); saved.preview = scenario();
    vi.mocked(api.current).mockResolvedValue(saved);
    render(<App />); const stream = await updates();
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    await userEvent.click(moneyLink());
    await planChanges();
    const comparison = within(screen.getByRole('region', { name: 'Spending change preview' }));
    await userEvent.click(comparison.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(comparison.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready');
    const corrected = structuredClone(saved); corrected.sequence = 1;
    corrected.plan.closingPaise = 123456; corrected.preview!.plan.closingPaise = 234567;
    act(() => stream.emit('snapshot', corrected));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready');
    expect(screen.queryByRole('heading', { name: 'Your figures have changed.' })).not.toBeInTheDocument();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const details = within(picture).getByRole('region', { name: 'Financial picture details' });
    expect(within(details).getByLabelText('Projected closing cash')).toHaveTextContent('₹1,234.56');
    expect(within(picture).getByRole('article', { name: 'Cash & timing' })).not.toHaveTextContent('₹2,345.67');
    const proposal = within(picture).getByRole('article', { name: 'Plan changes' });
    expect(proposal).toBeVisible();
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await userEvent.click(moneyLink());
    await planChanges();
    expect(proposal).not.toBeVisible();
    expect(comparison.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(comparison.getByText('Review this exact preview before accepting.')).toBeVisible();
    const after = comparison.getByRole('region', { name: 'After · preview' });
    await userEvent.click(within(after).getByText('More calculated results', { selector: 'summary' }));
    expect(after).toHaveTextContent('₹2,345.67');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('shows saved assumptions in a separate card without treating them as reported facts or payments', async () => {
    const saved = planningSnapshot(); saved.accepted = scenario('accepted-one');
    saved.accepted.adjustments[0].acceptedRevision = 0;
    vi.mocked(api.current).mockResolvedValue(projectWorkspace(saved));
    render(<App />); await updates();
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const assumptions = within(picture).getByRole('article', { name: 'Plan changes' });
    expect(assumptions).toBeVisible();
    expect(assumptions).toHaveTextContent('Saved assumptions · not paid');
    expect(within(picture).getByLabelText('Projected closing cash')).toHaveTextContent('₹12,000');
    expect(within(assumptions).getByRole('list', { name: 'Planning changes' })).toHaveTextContent('₹2,000 Reported → to ₹0 Saved');
    expect(within(picture).getByRole('article', { name: 'Cash & timing' })).toHaveTextContent('₹5,000');
    expect(within(picture).getByRole('listitem', { name: 'Rent' })).toHaveTextContent('₹12,000');
    expect(api.save).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });

  it('requires initial live updates and resolves a pending Money assumptions command before allowing voice without a draft', async () => {
    const saved = planningSnapshot(); saved.preview = scenario();
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'))
      .mockResolvedValue({ ...saved, sequence: 1, accepted: saved.preview, preview: null });
    render(<App />);
    const start = await screen.findByRole('button', { name: 'Start conversation' });
    expect(start).toBeDisabled();
    await updates();
    await userEvent.click(start);
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled();
    await userEvent.click(moneyLink());
    await planChanges();
    await userEvent.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
    expect(within(notice).getByRole('button', { name: 'Retry same action' })).toBeEnabled();
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    expect(moneyLink()).not.toHaveAccessibleDescription();
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled();
    await userEvent.click(moneyLink());
    const money = within(screen.getByRole('region', { name: 'Money' }));
    expect(money.getByRole('button', { name: 'Correct starting cash' })).toBeDisabled();
    expect(money.queryByRole('alert', { name: 'Save not confirmed', hidden: true })).not.toBeInTheDocument();
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(money.getByRole('button', { name: 'Correct starting cash' })).toBeEnabled());
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(vi.mocked(api.save).mock.calls[0][0]);
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled();
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready');
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps saved figures and reconnect available after unexpected disconnection, without a finished claim', async () => {
    render(<App />); const stream = await updates(); await connect(); ready();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    act(() => sdk.options!.callbacks!.onDisconnected!());
    await waitFor(() => expect(voiceStatus()).toHaveTextContent(/^Disconnected$/));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'disconnected'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(within(screen.getByRole('alert', { name: 'Connection lost' })).getByText('Check your internet connection, then reconnect.')).toBeVisible();
    expect(screen.queryByText('Conversation ended', { exact: true })).not.toBeInTheDocument();
    expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹7,000');
    expect(api.endCall).toHaveBeenCalledOnce(); expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(api.save).not.toHaveBeenCalled();
    await userEvent.click(conversation().getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(2)); ready();
    expect(voiceStatus()).toHaveTextContent(/^Listening$/);
  });

  it('does not offer completion when a conversation ends before any figures were saved', async () => {
    render(<App />); await updates(); await connect(); ready();
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ended'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByText('Figures appear as you talk')).toBeVisible();
    expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('keeps failed provider termination recoverable and blocks reconnect after local conversation end', async () => {
    vi.mocked(api.endCall).mockRejectedValueOnce(new TypeError('private termination diagnostic'));
    render(<App />); const stream = await updates(); await connect(); ready();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    await userEvent.click(conversation().getByRole('button', { name: 'End conversation' }));
    const retry = await conversation().findByRole('button', { name: 'Retry ending call' });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(sdk.tracks().local.audio.stop).toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole('main')).not.toHaveAttribute('data-view', 'finished');
    expect(screen.queryByRole('heading', { name: 'Your next step is clearer.' })).not.toBeInTheDocument();
    expect(voiceStatus()).toHaveTextContent('Conversation ended');
    expect(conversation().queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    const notice = within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert');
    expect(notice).toHaveTextContent('We couldn’t confirm the call ended.');
    expect(notice).not.toHaveTextContent('private termination diagnostic');
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹7,000');
    act(() => stream.onopen?.());
    expect(retry).toBeEnabled();
    expect(sdk.connect).toHaveBeenCalledOnce();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ended'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    await waitFor(() => expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled());
    expect(api.endCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.endCall).mock.calls.map(([callId]) => callId)).toEqual([
      vi.mocked(api.startCall).mock.calls[0][0], vi.mocked(api.startCall).mock.calls[0][0],
    ]);
    expect(api.save).not.toHaveBeenCalled();
    expect(livePicture().getByLabelText('First shortfall')).toHaveTextContent('₹7,000');
  });

  it.each(['draft', 'pending'] as const)('locks voice and navigation with a %s correction while preserving input across SSE', async mode => {
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'));
    vi.mocked(api.current).mockResolvedValue(planningSnapshot());
    const router = appRouter();
    render(<RouterProvider router={router} />); const stream = await updates();
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    const resume = screen.getByRole('button', { name: 'Start talking' });
    await userEvent.click(moneyLink());
    await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
    const correction = screen.getByRole('dialog', { name: /Correct cash on/ });
    const cash = within(correction).getByRole('textbox', { name: 'Amount (₹)' });
    await userEvent.clear(cash);
    await userEvent.type(cash, '123.45');
    if (mode === 'pending') {
      await userEvent.click(within(correction).getByRole('button', { name: 'Save correction' }));
      const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
      expect(within(notice).getByRole('button', { name: 'Retry same action' })).toBeEnabled();
      expect(within(correction).getByRole('button', { name: 'Retry same save' })).toBeEnabled();
    }
    expect(resume).not.toBeVisible();
    expect(resume).toBeDisabled();
    await act(async () => { await router.navigate('/app'); });
    expect(router.state.location.pathname).toBe('/money');
    expect(screen.getByRole('status', { name: 'Finish your correction' })).toHaveTextContent('Save or discard the correction before leaving Money.');
    expect(cash).toHaveValue('123.45');
    const corrected = planningSnapshot(); corrected.revision = 2; corrected.sequence = 2;
    act(() => stream.emit('snapshot', corrected));
    act(() => stream.emit('snapshot', planningSnapshot()));
    expect(moneyLink()).toHaveAccessibleDescription('Unsaved corrections');
    expect(cash).toBeVisible();
    expect(cash).toHaveValue('123.45');
    expect(cash).toBeDisabled();
    expect(within(correction).getByText(/Close and reopen to check the latest values before saving; it cannot overwrite them\./)).toHaveAttribute('role', 'alert');
    expect(resume).not.toBeVisible();
    expect(resume).toBeDisabled();
    await act(async () => { await router.navigate('/money/spending'); });
    expect(router.state.location.pathname).toBe('/money');
    if (mode === 'pending') {
      await userEvent.click(within(correction).getByRole('button', { name: /Close correct cash/ }));
      expect(correction).toBeVisible();
      expect(within(correction).queryByRole('button', { name: 'Discard correction' })).not.toBeInTheDocument();
      vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace({ ...planningSnapshot(), revision: 1, sequence: 1 }));
      await userEvent.click(within(correction).getByRole('button', { name: 'Retry same save' }));
      expect(vi.mocked(api.save).mock.calls[1][0]).toBe(vi.mocked(api.save).mock.calls[0][0]);
      await userEvent.click(await within(correction).findByRole('button', { name: 'Done' }));
    } else {
      expect(within(correction).getByRole('button', { name: 'Save correction' })).toBeDisabled();
      await userEvent.click(within(correction).getByRole('button', { name: /Close correct cash/ }));
      await userEvent.click(within(correction).getByRole('button', { name: 'Discard correction' }));
      expect(api.save).not.toHaveBeenCalled();
    }
    await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
    expect(screen.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('5000.00');
    await userEvent.click(screen.getByRole('button', { name: /Close correct cash/ }));
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    expect(resume).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
  });

  it.each(['active', 'unconfirmed'] as const)('blocks deletion for an %s existing call and keeps termination controls visible', async status => {
    const callId = crypto.randomUUID();
    vi.mocked(api.current).mockResolvedValue(planningSnapshot());
    vi.mocked(api.call).mockResolvedValue({ callId, status: 'active', cleanupConfirmed: false, message: null });
    if (status === 'unconfirmed') vi.mocked(api.call).mockRejectedValueOnce(new TypeError('Private call check failure'));
    render(<App />); await updates();
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready');
    expect(screen.getByRole('alert')).toHaveTextContent(status === 'active' ? 'Another conversation is still open.' : 'We couldn’t confirm the call ended.');
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(moneyLink());
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app');
    expect(screen.queryByRole('button', { name: 'Delete plan' })).not.toBeInTheDocument();
    expect(conversation().getByRole('button', { name: 'Retry ending call' })).toBeEnabled();
    for (const element of screen.queryAllByText('Private call check failure')) expect(element).not.toBeVisible();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    const ending = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValueOnce(ending.promise);
    await userEvent.click(conversation().getByRole('button', { name: 'Retry ending call' }));
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Delete plan' })).not.toBeInTheDocument();
    expect(api.call).toHaveBeenCalledTimes(status === 'active' ? 1 : 2);
    expect(api.endCall).toHaveBeenCalledExactlyOnceWith(callId);
    await act(async () => ending.resolve({ callId, status: 'ended', cleanupConfirmed: true, message: null }));
    await waitFor(() => expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled());
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ended');
    expect(api.delete).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
  });

  it.each([['Settings', 'pointer'], ['Settings', 'keyboard'], ['Money', 'pointer'], ['Money', 'keyboard']])('blocks %s navigation by %s during capture while leaving sign-out available and immediately releasing the microphone', async (name, input) => {
    const pending = deferred<void>(); vi.mocked(api.auth.logout).mockReturnValue(pending.promise);
    render(<App />); const stream = await updates(); await connect(); ready();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    if (name === 'Settings') await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    const link = screen.getByRole(name === 'Settings' ? 'menuitem' : 'link', { name });
    if (name === 'Money') {
      expect(link).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getAllByRole('link', { name })).toEqual([link]);
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    if (input === 'keyboard') { link.focus(); await userEvent.keyboard('{Enter}'); }
    else await userEvent.click(link);
    expect(screen.getByRole('main')).toHaveAttribute('data-route', `/app/${join.conversationSlug}`);
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'A conversation is open' })).toHaveTextContent('End it before opening Money or account settings.');
    expect(screen.getByRole('button', { name: 'End conversation' })).toBeEnabled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(sdk.tracks().local.audio.stop).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(screen.getByRole('heading', { name: 'Signing out…' })).toBeVisible();
    expect(sdk.tracks().local.audio.stop).toHaveBeenCalled();
    await waitFor(() => expect(sdk.disconnect).toHaveBeenCalledOnce());
    expect(stream.closed).toBe(true); expect(screen.queryByRole('article', { name: 'Money available' })).not.toBeInTheDocument();
    act(() => sdk.options!.callbacks!.onUserTranscript!({ text: 'Late private words', final: true, timestamp: 'late', user_id: 'me' }));
    expect(screen.queryByText('Late private words')).not.toBeInTheDocument();
    await act(async () => pending.resolve());
    await screen.findByText('You’re signed out.');
    expect(api.startCall).toHaveBeenCalledOnce();
  });

  it.each(['sessionExpired', 'authUnavailable'] as const)('releases capture and saved content when active authentication becomes %s', async code => {
    render(<App />); const stream = await updates(); await connect(); ready();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    vi.mocked(api.auth.session).mockRejectedValue(new ApiError(code === 'sessionExpired' ? 401 : 503, { code, message: 'private diagnostic' }));
    act(() => reportAuthLoss(code));
    expect(sdk.tracks().local.audio.stop).toHaveBeenCalled();
    await waitFor(() => expect(sdk.disconnect).toHaveBeenCalledOnce());
    expect(stream.closed).toBe(true); expect(screen.queryByRole('article', { name: 'Money available' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    if (code === 'sessionExpired') await screen.findByRole('button', { name: 'Continue with Google' });
    else await screen.findByRole('heading', { name: 'Your saved plan is safe.', level: 1 });
  });
});