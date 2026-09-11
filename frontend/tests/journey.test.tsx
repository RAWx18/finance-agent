// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RTVIEvent } from '@pipecat-ai/client-js';
import type { Participant, PipecatClientOptions } from '@pipecat-ai/client-js';
import { App, mockAuth } from './appSupport';
import { api, ApiError, reportAuthLoss } from '../src/api';
import { adjustmentOptions, choiceSnapshot, planningSnapshot, scenario, settings, snapshot, Stream, unconfirmedSnapshot } from './fixtures';

const sdk = vi.hoisted(() => ({
  options: null as PipecatClientOptions | null,
  initDevices: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), destroy: vi.fn(), tracks: vi.fn(),
  enableMic: vi.fn(), enabled: true,
  listeners: new Map<string, (track: MediaStreamTrack, participant?: Participant) => void>(),
}));
vi.mock('@pipecat-ai/client-js', async original => ({
  ...await original<typeof import('@pipecat-ai/client-js')>(),
  PipecatClient: class {
    constructor(options: PipecatClientOptions) { sdk.options = options; }
    initDevices = sdk.initDevices;
    connect = sdk.connect;
    disconnect = sdk.disconnect;
    enableMic = sdk.enableMic;
    tracks = sdk.tracks;
    get isMicEnabled() { return sdk.enabled; }
    on(name: string, callback: (track: MediaStreamTrack, participant?: Participant) => void) { sdk.listeners.set(name, callback); }
  },
}));
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: class { dailyCallClient = { destroy: sdk.destroy }; } }));

const join = { callId: 'call-one', url: 'https://room.daily.co/test', token: 'test-only-token', expiresAt: '2026-09-11T05:00:00Z' };
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
  act(() => Stream.instances[0].onopen?.());
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
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(api, 'startCall').mockResolvedValue(join);
  vi.spyOn(api, 'endCall').mockResolvedValue({ callId: join.callId, status: 'ended', message: null });
  vi.spyOn(api, 'save').mockResolvedValue({ ...planningSnapshot(), revision: 1, sequence: 1 });
  vi.spyOn(api, 'delete').mockResolvedValue({ deleted: true });
  vi.spyOn(api, 'options').mockResolvedValue(adjustmentOptions);
});

describe('App voice and financial journey', () => {
  it.each([false, true])('shows an overlapping-proposal refusal failure in the real App without mutation (retry: %s)', async retry => {
    const saved = choiceSnapshot(); saved.revision = 1; saved.sequence = 1;
    saved.preview = scenario(); saved.preview.sourceRevision = 1; saved.preview.adjustments[0].amountPaise = 50000;
    const original = structuredClone(saved);
    const conflict = deferred<void>();
    const discard = deferred<typeof saved>();
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    if (retry) vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'));
    vi.mocked(api.save).mockImplementationOnce(async () => {
      await conflict.promise;
      throw new ApiError(409, { code: 'stalePreview', message: 'private conflicting proposal diagnostic', snapshot: structuredClone(saved) });
    }).mockReturnValueOnce(discard.promise);
    render(<App />); const stream = await updates(); await connect(); ready();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(picture).queryByText(/Your session is saved|Your answer is saved/)).not.toBeInTheDocument();
    act(() => stream.emit('snapshot', saved));
    const proposal = within(picture).getByRole('region', { name: 'Spending change preview' });
    const consent = within(proposal).getByRole('checkbox');
    await userEvent.click(consent);
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(within(picture).getByRole('button', { name: 'Do not suggest this cut' }));
    if (retry) await userEvent.click(await screen.findByRole('button', { name: 'Retry same action' }));
    expect(consent).toBeDisabled();
    expect(consent).not.toBeChecked();
    await act(async () => conflict.resolve());
    const feedback = within(picture).getByRole('alert');
    expect(feedback).toBeVisible();
    expect(feedback).toHaveClass('notice', 'warning');
    expect(feedback).not.toHaveClass('sr-only');
    expect(feedback).toHaveTextContent('Your answer was not saved because the open proposal differs from this suggested cut. Review the proposal or choose “Reject preview” before answering again.');
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
    expect(screen.queryByText(/private conflicting proposal diagnostic|no longer available to accept/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(within(picture).getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
    expect(proposal).toHaveTextContent('₹2,000.00 reported → ₹500.00 assumed');
    expect(consent).toBeEnabled();
    expect(consent).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeEnabled();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Your figures' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
    act(() => stream.emit('snapshot', saved));
    expect(feedback).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    expect(within(proposal).getByRole('heading', { name: 'Spending change preview' })).toHaveFocus();
    const commands = vi.mocked(api.save).mock.calls;
    expect(commands).toHaveLength(retry ? 2 : 1);
    expect(commands[0][0].operation).toEqual({ type: 'respondToAction', actionId: 'preview-spending', response: 'declined' });
    if (retry) expect(commands[1][0]).toBe(commands[0][0]);
    await userEvent.click(within(proposal).getByRole('button', { name: 'Reject preview' }));
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    expect(commands.at(-1)![0]).toMatchObject({ expectedRevision: saved.revision,
      operation: { type: 'discardPreview', previewId: saved.preview.id } });
    expect(commands.at(-1)![0].commandId).not.toBe(commands[0][0].commandId);
    expect(consent).toBeDisabled();
    await act(async () => discard.resolve({ ...saved, sequence: 2, preview: null }));
    act(() => stream.emit('snapshot', saved));
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(picture).queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    expect(within(picture).queryByText(/Preview rejected|Your answer is saved/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    expect(within(picture).getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
    expect(within(picture).getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
    expect(commands).toHaveLength(retry ? 3 : 2);
    expect(saved).toEqual(original);
    expect(conversation().getByRole('status')).toHaveTextContent('Listening');
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(api.options).not.toHaveBeenCalled();
  });

  it('shows changed-next-step guidance for an invalid answer and clears it on a newer live snapshot without inventing figures', async () => {
    vi.mocked(api.save).mockRejectedValueOnce(new ApiError(422, {
      code: 'invalidActionResponse', message: 'private unsupported action diagnostic', snapshot: snapshot(),
    }));
    render(<App />); const stream = await updates(); await connect(); ready();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'I cannot confirm this now' }));
    expect(within(picture).getByRole('alert')).toBeVisible();
    expect(within(picture).getByRole('alert')).toHaveTextContent('Your answer was not saved because this next step has changed or is no longer available. Review the current next step before answering again.');
    expect(screen.queryByText(/Check amounts|private unsupported action diagnostic/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I cannot confirm this now' })).toBeEnabled();
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: 0,
      operation: { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' } });
    act(() => stream.emit('snapshot', { ...snapshot(), sequence: 1 }));
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(picture).getByRole('heading', { name: 'No figures yet' })).toBeVisible();
    expect(within(picture).queryByText(/₹0\.00|Your answer is saved/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    expect(api.endCall).not.toHaveBeenCalled();
  });

  it.each(['acceptPreview', 'discardPreview'] as const)('reviews and retries %s in the live surface without opening the editor or restarting the call', async operation => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const saved = planningSnapshot(); saved.revision = 1; saved.sequence = 1;
    const preview = scenario(); preview.sourceRevision = 1; saved.preview = preview;
    const confirmed = structuredClone(saved); confirmed.sequence = 2; confirmed.preview = null;
    if (operation === 'acceptPreview') {
      confirmed.revision = 2;
      confirmed.accepted = { ...preview, adjustments: preview.adjustments.map(item => ({ ...item, acceptedRevision: 2 })) };
    }
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValueOnce(confirmed);
    const audio = document.querySelector('audio');
    const end = conversation().getByRole('button', { name: 'End conversation' }); end.focus();
    act(() => stream.emit('snapshot', saved));
    expect(end).toHaveFocus();
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(proposal).toHaveTextContent('₹2,000.00 reported → ₹0.00 assumed');
    expect(proposal).toHaveTextContent('A cash gap remains on 13 Sept 2026.');
    expect(screen.getByRole('button', { name: 'Your figures' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    expect(within(proposal).getByRole('heading', { name: 'Spending change preview' })).toHaveFocus();
    if (operation === 'acceptPreview') {
      await userEvent.click(within(proposal).getByRole('button', { name: 'Accept planning assumptions' }));
      expect(api.save).not.toHaveBeenCalled();
      await userEvent.click(within(proposal).getByRole('checkbox'));
    }
    await userEvent.click(within(proposal).getByRole('button', { name: operation === 'acceptPreview' ? 'Accept planning assumptions' : 'Reject preview' }));
    const retry = await screen.findByRole('button', { name: 'Retry same action' });
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
      : { type: 'discardPreview', previewId: preview.id });
    act(() => { stream.emit('snapshot', confirmed); stream.emit('snapshot', saved); });
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    expect(retry).toBeVisible();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument());
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    if (operation === 'acceptPreview') {
      await userEvent.click(screen.getByRole('button', { name: 'Saved planning assumptions' }));
      expect(screen.getByRole('dialog', { name: 'Saved planning assumptions' })).toHaveTextContent('Consent saved for this occurrence; not a completed action.');
    }
    expect(document.querySelector('audio')).toBe(audio);
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(api.options).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'declined'] as const)('retries a lost %s answer with its identical command after SSE advances the selected action', async response => {
    const saved = response === 'unavailable' ? snapshot() : choiceSnapshot();
    const confirmed = response === 'unavailable' ? unconfirmedSnapshot() : structuredClone(saved);
    if (response === 'declined') {
      confirmed.revision = 1; confirmed.sequence = 1;
      confirmed.facts.decision = { ...confirmed.facts.decision!, responses: [{ actionId: 'preview-spending', response, dependencyKey: 'spending-terms' }] };
      confirmed.plan.decisionAssessment!.actions = [confirmed.plan.decisionAssessment!.actions![0]];
      confirmed.plan.decisionAssessment!.nextActionId = confirmed.plan.decisionAssessment!.actions[0].id;
    }
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValueOnce(confirmed);
    render(<App />); const stream = await updates(); await connect(); ready();
    const answer = screen.getByRole('button', { name: response === 'unavailable' ? 'I cannot confirm this now' : 'Do not suggest this cut' });
    await userEvent.click(answer);
    const retry = await screen.findByRole('button', { name: 'Retry same action' });
    expect(answer).toBeDisabled();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    const command = vi.mocked(api.save).mock.calls[0][0];
    expect(command.operation).toEqual({ type: 'respondToAction', actionId: saved.plan.decisionAssessment!.nextActionId, response });
    act(() => stream.emit('snapshot', confirmed));
    expect(retry).toBeVisible();
    expect(screen.getByRole('article', { name: 'Plan focus' }).querySelector('.focus-action')).toHaveTextContent(confirmed.plan.decisionAssessment!.actions![0].question);
    await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument());
    expect(vi.mocked(api.save).mock.calls).toHaveLength(2);
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(command.expectedRevision).toBe(saved.revision);
    act(() => stream.emit('snapshot', saved));
    expect(screen.getByLabelText('Saved answers')).toHaveTextContent(response === 'unavailable' ? 'Unconfirmed details remain open.' : 'Declined cuts are not assumed.');
    expect(screen.getByRole('button', { name: 'End conversation' })).toBeEnabled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
  });

  it('saves an unavailable first answer during the call and follows the server-selected question without inventing cash', async () => {
    const deferred = unconfirmedSnapshot();
    vi.mocked(api.save).mockResolvedValueOnce(deferred);
    render(<App />); const stream = await updates(); await connect(); ready();
    await userEvent.click(screen.getByRole('button', { name: 'I cannot confirm this now' }));
    await waitFor(() => expect(screen.getByLabelText('Saved answers')).toHaveTextContent('Unconfirmed details remain open.'));
    expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({ expectedRevision: 0,
      operation: { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' } });
    expect(screen.getByRole('article', { name: 'Plan focus' }).querySelector('.focus-action')).toHaveTextContent(deferred.plan.decisionAssessment!.actions![0].question);
    expect(screen.queryByRole('article', { name: 'Money available' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your financial picture' })).not.toHaveTextContent('₹0.00');
    act(() => stream.emit('snapshot', snapshot()));
    expect(screen.getByRole('article', { name: 'Plan focus' })).not.toHaveTextContent('What cash was available at the original cash basis?');
    await userEvent.click(screen.getByRole('button', { name: 'Open questions' }));
    const questions = screen.getByRole('list', { name: 'Remaining checks' });
    expect(questions).toHaveTextContent('What cash was available at the original cash basis?');
    expect(questions).toHaveTextContent(deferred.plan.decisionAssessment!.actions![0].question);
    expect(screen.getByRole('button', { name: 'Your figures' })).toBeDisabled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.options).not.toHaveBeenCalled();
  });

  it.each(['reduceOptional', 'cardMinimum'] as const)('saves a declined %s answer and follows the next action without removing the cash gap', async kind => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const saved = choiceSnapshot(kind); saved.revision = 1; saved.sequence = 1;
    const declined = structuredClone(saved); declined.revision = 2; declined.sequence = 2;
    declined.facts.decision = { ...declined.facts.decision!, responses: [{ actionId: 'preview-spending', response: 'declined', dependencyKey: 'spending-terms' }] };
    declined.plan.decisionAssessment!.actions = [declined.plan.decisionAssessment!.actions![0]];
    declined.plan.decisionAssessment!.nextActionId = declined.plan.decisionAssessment!.actions[0].id;
    vi.mocked(api.save).mockResolvedValueOnce(declined);
    act(() => stream.emit('snapshot', saved));
    await userEvent.click(screen.getByRole('button', { name: 'Do not suggest this cut' }));
    await waitFor(() => expect(screen.getByLabelText('Saved answers')).toHaveTextContent('Declined cuts are not assumed.'));
    expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({ expectedRevision: saved.revision,
      operation: { type: 'respondToAction', actionId: 'preview-spending', response: 'declined' } });
    const focus = screen.getByRole('article', { name: 'Plan focus' });
    expect(focus.querySelector('.focus-action')).toHaveTextContent('Contact the provider before the due date.');
    expect(focus).toHaveTextContent('₹7,000.00');
    act(() => stream.emit('snapshot', saved));
    expect(screen.queryByRole('button', { name: 'Do not suggest this cut' })).not.toBeInTheDocument();
    expect(declined.facts.records).toEqual(saved.facts.records);
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
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
    expect(conversation().getByRole('status')).toHaveTextContent('Ready when you are');
    expect(screen.queryByRole('heading', { name: 'Ready when you are' })).not.toBeInTheDocument();
    expect(view.container.querySelector('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(sdk.options).toBeNull();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your financial picture' })).toHaveTextContent('No figures yet');
    await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(sdk.options).toMatchObject({ enableMic: true, enableCam: false });
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prefer typing?' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
    await act(async () => permission.resolve(new MediaStream([sdk.tracks().local.audio])));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledWith({ url: join.url, token: join.token }));
    expect(vi.mocked(navigator.mediaDevices.getUserMedia).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.start).mock.invocationCallOrder[0]);
    expect(vi.mocked(api.start).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.startCall).mock.invocationCallOrder[0]);
    expect(conversation().getByRole('status')).toHaveTextContent(/^Connecting$/);
    act(() => sdk.options!.callbacks!.onConnected!());
    expect(conversation().getByRole('status')).toHaveTextContent('Connecting to assistant');
    ready();
    expect(conversation().getByRole('status')).toHaveTextContent(/^Listening$/);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Let’s talk it through.');
    expect(view.container.querySelector('details')).not.toBeInTheDocument();
    expect(view.container.querySelector('video')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /camera/i })).not.toBeInTheDocument();
    expect(view.container.querySelector('audio')).toBe(audio);
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
    await waitFor(() => expect(conversation().getByRole('status')).toHaveTextContent('Unable to connect'));
    const notice = screen.getByRole('status', { name: 'Microphone access denied' });
    expect(notice).toHaveTextContent('Microphone access was denied.');
    expect(notice).toHaveTextContent('Allow microphone access in your browser’s site settings, then try again.');
    expect(notice).not.toHaveTextContent('Private permission diagnostic');
    expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
  });

  it('keeps the live call and captions mounted through detail dialogs and reports actual activity', async () => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const saved = planningSnapshot(); saved.sequence = 1;
    saved.facts.records.push(...Array.from({ length: 4 }, (_, index) => ({
      id: `bill-${index}`, label: `Bill ${index + 1}`, kind: 'essential' as const,
      amount: { status: 'unknown' as const, amountPaise: null },
      schedule: { date: null, recurrence: 'once' as const }, autoDebit: false,
    })));
    act(() => stream.emit('snapshot', saved));
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const audio = document.querySelector('audio');
    const end = conversation().getByRole('button', { name: 'End conversation' });
    await act(async () => sdk.listeners.get(RTVIEvent.TrackStarted)!(track(), { id: 'assistant', name: 'Assistant', local: false }));
    act(() => sdk.options!.callbacks!.onBotLlmStarted!());
    expect(conversation().getByRole('status')).toHaveTextContent(/^Thinking$/);
    act(() => { sdk.options!.callbacks!.onBotLlmStopped!(); sdk.options!.callbacks!.onBotStartedSpeaking!(); });
    expect(conversation().getByRole('status')).toHaveTextContent(/^Speaking$/);
    act(() => sdk.options!.callbacks!.onUserStartedSpeaking!());
    expect(conversation().getByRole('status')).toHaveTextContent('Interrupted · listening');
    act(() => { sdk.options!.callbacks!.onBotStoppedSpeaking!(); sdk.options!.callbacks!.onUserStoppedSpeaking!(); sdk.options!.callbacks!.onUserMuteStarted!(); });
    expect(conversation().getByRole('status')).toHaveTextContent('Listening paused');
    act(() => sdk.options!.callbacks!.onUserMuteStopped!());
    expect(conversation().getByRole('status')).toHaveTextContent(/^Listening$/);
    await userEvent.click(conversation().getByRole('button', { name: 'Mute microphone' }));
    expect(conversation().getByRole('status')).toHaveTextContent('Microphone muted');
    await userEvent.click(conversation().getByRole('button', { name: 'Unmute microphone' }));
    expect(conversation().getByRole('status')).toHaveTextContent(/^Listening$/);
    act(() => sdk.options!.callbacks!.onUserTranscript!({ text: 'Please check my rent.', final: true, user_id: 'consumer', timestamp: '2026-09-11T04:01:00Z' }));
    const captions = conversation().getByRole('region', { name: 'Live caption' });
    expect(captions).toHaveTextContent('Please check my rent.');
    for (const label of ['Plan details', 'Open questions', 'View all figures']) {
      const trigger = within(picture).getByRole('button', { name: label });
      await userEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: label });
      expect(dialog).toBeVisible();
      expect(within(dialog).getByRole('heading', { name: label })).toHaveFocus();
      if (label === 'View all figures') {
        const list = within(dialog).getByRole('list', { name: 'Saved items' });
        expect(within(list).getAllByRole('listitem')).toHaveLength(5);
        expect(within(list).getByRole('article', { name: 'Bill 4' })).toHaveTextContent('Unknown');
        const corrected = structuredClone(saved); corrected.sequence = 2; corrected.revision = 1;
        corrected.facts.records[4].amount = { status: 'exact', amountPaise: 12345 };
        act(() => stream.emit('snapshot', corrected));
        expect(within(list).getByRole('article', { name: 'Bill 4' })).toHaveTextContent('₹123.45');
        expect(within(dialog).getByRole('heading', { name: label })).toHaveFocus();
      }
      if (label === 'Plan details') expect(dialog).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.summary);
      if (label === 'Open questions') expect(dialog).toHaveTextContent(saved.plan.decisionAssessment!.uncertainties![0].question);
      expect(document.querySelector('audio')).toBe(audio);
      expect(end).toBeInTheDocument(); expect(captions).toBeInTheDocument();
      expect(sdk.disconnect).not.toHaveBeenCalled(); expect(sdk.destroy).not.toHaveBeenCalled();
      expect(api.endCall).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole('button', { name: `Close ${label.toLowerCase()}` }));
      expect(dialog).not.toBeVisible(); expect(trigger).toHaveFocus();
    }
    expect(captions).toBeVisible();
    expect(conversation().getByRole('button', { name: 'End conversation' })).toBe(end);
    expect(screen.getByRole('button', { name: 'Your figures' })).toBeDisabled();
    expect(document.querySelector('details')).not.toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('requires BotReady and a live local track, not SSE or a resolved SDK connection, to claim listening', async () => {
    sdk.tracks.mockReturnValue({ local: { audio: track('ended') } });
    render(<App />); const stream = await updates(); await connect();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    expect(conversation().getByRole('status')).toHaveTextContent(/^Connecting$/);
    act(() => sdk.options!.callbacks!.onTransportStateChanged!('ready'));
    expect(conversation().queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
    ready();
    expect(conversation().getByRole('status')).toHaveTextContent('Microphone not connected');
    const microphone = track();
    act(() => sdk.listeners.get(RTVIEvent.TrackStarted)!(microphone, local));
    expect(conversation().getByRole('status')).toHaveTextContent(/^Listening$/);
    act(() => {
      Object.assign(microphone, { readyState: 'ended' });
      microphone.dispatchEvent(new Event('ended'));
    });
    expect(conversation().getByRole('status')).toHaveTextContent('Microphone not connected');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
  });

  it('streams authoritative gaps and salary corrections while live, rejects stale events, and ends in review without certifying missing facts', async () => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const saved = planningSnapshot(); saved.revision = 1; saved.sequence = 1;
    saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { status: 'exact', amountPaise: 3000000 },
      schedule: { date: '2026-09-25', recurrence: 'monthly' }, reliability: 'reliable', autoDebit: false });
    act(() => stream.emit('snapshot', saved));
    expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'taking-shape');
    expect(screen.getByRole('heading', { name: 'Your financial picture' })).toBeVisible();
    expect(screen.getByRole('article', { name: 'Money available' })).toHaveTextContent('₹5,000.00');
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('₹30,000.00');
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('25 Sept 2026');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('13 Sept 2026');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Largest gap: ₹16,000.00');
    const records = within(screen.getByRole('region', { name: 'Financial picture details' })).getAllByRole('article');
    expect(records.map(item => item.getAttribute('aria-label'))).toEqual(['Plan focus', 'Money available', 'Rent', 'Salary']);
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
    act(() => stream.emit('snapshot', corrected));
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('₹32,000.00');
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('20 Sept 2026');
    expect(screen.getByRole('article', { name: 'Salary' })).not.toHaveTextContent(/₹30,000.00|25 Sept 2026/);
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveAttribute('data-changed', 'true');
    const changes = within(screen.getByRole('region', { name: 'Your financial picture' })).getByText(/Latest saved change:/);
    expect(changes).toHaveTextContent('Salary: ₹30,000.00 · Reported → ₹32,000.00 · Reported; 25 Sept 2026 → 20 Sept 2026');
    expect(changes).toHaveAttribute('aria-live', 'polite');
    expect(changes).toHaveClass('sr-only');
    const note = within(screen.getByRole('region', { name: 'Your financial picture' })).getByText(/^Latest change:/);
    expect(note).toBeVisible(); expect(note).toHaveAttribute('aria-hidden', 'true');
    expect(within(screen.getByRole('region', { name: 'Financial picture details' })).getAllByRole('article')).toEqual(records);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹12,345.67');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Largest gap: ₹23,456.78 on 19 Sept 2026');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Verify the corrected receipt timing.');
    expect(conversation().getByRole('status')).toHaveTextContent('Listening to you');
    expect(end).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Recent changes' }));
    const recent = screen.getByRole('dialog', { name: 'Recent changes' });
    expect(within(recent).getByRole('list', { name: 'Recent changes' })).toHaveTextContent('20 Sept 2026');
    await userEvent.click(within(recent).getByRole('button', { name: 'Close recent changes' }));
    act(() => { stream.emit('snapshot', saved); stream.emit('snapshot', { ...saved, sequence: corrected.sequence }); });
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('₹32,000.00');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹12,345.67');
    expect(changes).toHaveTextContent('20 Sept 2026');
    expect(conversation().getByRole('status')).toHaveTextContent('Listening to you');
    expect(screen.getByRole('button', { name: 'Your figures' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
    const ending = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValue(ending.promise);
    await userEvent.click(end);
    expect(sdk.tracks().local.audio.stop).toHaveBeenCalled();
    expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'ending');
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    await act(async () => ending.resolve({ callId: join.callId, status: 'ended', message: null }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-view', 'review'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your 30-day plan.');
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).getByText('Projected closing cash').parentElement).toHaveTextContent('₹76,543.21');
    expect(within(picture).getByRole('region', { name: 'Next steps' })).toHaveTextContent('Verify the corrected receipt timing.');
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
    expect(document.querySelector('audio')!.srcObject).toBeFalsy();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(within(picture).getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Not all costs are included');
    act(() => stream.onerror?.());
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    act(() => stream.onopen?.());
    await userEvent.click(screen.getByRole('button', { name: 'Finish review' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'finished');
    expect(screen.getByRole('heading', { name: 'Your next step is clearer.' })).toBeVisible();
    expect(within(picture).getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Not all costs are included');
    expect(picture).toHaveTextContent('Verify the corrected receipt timing.');
    expect(picture).not.toHaveTextContent('Contact the provider before the due date.');
    expect(screen.getByRole('link', { name: 'Download plan' })).toHaveAttribute('href', '/api/session/export');
    expect(api.save).not.toHaveBeenCalled();
    expect(saved.facts.coverage).toEqual(snapshot().facts.coverage);
  });

  it('invalidates a finished review and previously reviewed assumptions on a newer SSE sequence', async () => {
    const saved = planningSnapshot(); saved.preview = scenario();
    vi.mocked(api.current).mockResolvedValue(saved);
    render(<App />); const stream = await updates();
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    await userEvent.click(screen.getByRole('button', { name: 'Spending changes' }));
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    const comparison = within(figures.getByRole('region', { name: 'Spending change preview' }));
    await userEvent.click(comparison.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(comparison.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(screen.getByRole('link', { name: 'Back to conversation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish review' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'finished');
    const corrected = structuredClone(saved); corrected.sequence = 1;
    corrected.plan.closingPaise = 123456; corrected.preview!.plan.closingPaise = 234567;
    act(() => stream.emit('snapshot', corrected));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'review');
    expect(screen.getByRole('heading', { name: 'Your figures have changed.' })).toBeVisible();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const details = within(picture).getByRole('region', { name: 'Financial picture details' });
    expect(within(details).getByText('Projected closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹1,234.56');
    expect(within(picture).getByRole('article', { name: 'Plan focus' })).not.toHaveTextContent('₹2,345.67');
    const proposal = within(picture).getByRole('region', { name: 'Spending change preview' });
    expect(proposal).toBeVisible();
    await userEvent.click(within(picture).getByRole('button', { name: 'Review proposed change' }));
    expect(within(proposal).getByRole('heading', { name: 'Spending change preview' })).toHaveFocus();
    expect(within(proposal).getByRole('region', { name: 'After · preview' })).toHaveTextContent('₹2,345.67');
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    expect(proposal).not.toBeVisible();
    expect(comparison.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(comparison.getByText('Review this exact preview before accepting.')).toBeVisible();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('shows saved assumptions in a separate dialog without treating them as reported facts or payments', async () => {
    const saved = planningSnapshot(); saved.accepted = scenario('accepted-one');
    saved.accepted.adjustments[0].acceptedRevision = 0;
    vi.mocked(api.current).mockResolvedValue(saved);
    render(<App />); await updates();
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).getByText('Includes saved assumptions, not completed payments.')).toBeVisible();
    expect(within(picture).getByText('Assumed closing cash').parentElement).toHaveTextContent('₹12,000.00');
    expect(within(picture).queryByRole('list', { name: 'Planning assumptions' })).not.toBeInTheDocument();
    await userEvent.click(within(picture).getByRole('button', { name: 'Saved planning assumptions' }));
    const dialog = screen.getByRole('dialog', { name: 'Saved planning assumptions' });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole('list', { name: 'Planning assumptions' })).toHaveTextContent('₹2,000.00 reported → ₹0.00 assumed');
    expect(within(dialog).getByText('Consent saved for this occurrence; not a completed action.')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close saved planning assumptions' }));
    await userEvent.click(within(picture).getByRole('button', { name: 'What this is based on' }));
    const basis = screen.getByRole('dialog', { name: 'What this is based on' });
    expect(within(basis).getByRole('article', { name: 'Money available' })).toHaveTextContent('₹5,000.00');
    expect(within(basis).getByRole('article', { name: 'Rent' })).toHaveTextContent('₹12,000.00');
    expect(api.save).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });

  it('requires initial live updates and resolves a pending assumptions command before allowing finish without a draft', async () => {
    const saved = planningSnapshot(); saved.preview = scenario();
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'))
      .mockResolvedValue({ ...saved, sequence: 1, accepted: saved.preview, preview: null });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Review saved picture/ }));
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    await updates();
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    await userEvent.click(screen.getByRole('button', { name: 'Spending changes' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    await screen.findByRole('button', { name: 'Retry same action' });
    await userEvent.click(screen.getByRole('link', { name: 'Back to conversation' }));
    expect(screen.queryByText('Unsaved corrections')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Return to conversation' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    expect(figures.getByRole('button', { name: 'Edit figures' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(figures.getByRole('button', { name: 'Edit figures' })).toBeEnabled());
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(vi.mocked(api.save).mock.calls[0][0]);
    await userEvent.click(screen.getByRole('link', { name: 'Back to conversation' }));
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Finish review' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'finished');
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('offers retry or saved-picture review after unexpected disconnection, without a finished claim', async () => {
    render(<App />); const stream = await updates(); await connect(); ready();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    act(() => sdk.options!.callbacks!.onDisconnected!());
    await waitFor(() => expect(conversation().getByRole('status')).toHaveTextContent(/^Disconnected$/));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'disconnected'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByRole('alert')).toHaveTextContent('The audio connection closed. Check your internet connection, then reconnect.');
    expect(screen.queryByText('Conversation ended', { exact: true })).not.toBeInTheDocument();
    expect(conversation().getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Review saved picture/ })).toBeEnabled();
    expect(api.endCall).toHaveBeenCalledOnce(); expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'review');
    expect(api.save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Return to conversation' }));
    await userEvent.click(conversation().getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(2)); ready();
    expect(conversation().getByRole('status')).toHaveTextContent(/^Listening$/);
  });

  it('does not offer completion when a conversation ends before any figures were saved', async () => {
    render(<App />); await updates(); await connect(); ready();
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    await screen.findByRole('heading', { name: 'Ready to talk again?' });
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'review');
    expect(screen.getByText('No figures saved yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it.each(['draft', 'pending'] as const)('locks voice and finishing with a %s, preserving input across SSE and figure views', async mode => {
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'));
    render(<App />); const stream = await updates();
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit figures' }));
    const cash = screen.getByRole('group', { name: 'Available cash' });
    await userEvent.selectOptions(within(cash).getByLabelText('How certain?'), 'exact');
    await userEvent.type(within(cash).getByLabelText('Available cash (₹)'), '123.45');
    if (mode === 'pending') {
      await userEvent.click(screen.getByRole('button', { name: 'Save figures' }));
      await screen.findByRole('button', { name: 'Retry same save' });
    }
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    await userEvent.click(figures.getByRole('button', { name: 'Overview' }));
    expect(figures.queryByRole('textbox', { name: 'Available cash (₹)' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Back to conversation' }));
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled();
    const corrected = planningSnapshot(); corrected.revision = 2; corrected.sequence = 2;
    act(() => stream.emit('snapshot', corrected));
    expect(screen.getByText('Unsaved corrections')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Back to welcome' }));
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Return to conversation' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Review your draft' }));
    if (figures.getByRole('button', { name: 'Overview' }).getAttribute('aria-pressed') === 'true') {
      const edit = figures.getByRole('button', { name: 'Edit figures' });
      expect(edit).toBeEnabled();
      await userEvent.click(edit);
    }
    expect(figures.getByRole('textbox', { name: 'Available cash (₹)' })).toBeVisible();
    expect(figures.getByRole('textbox', { name: 'Available cash (₹)' })).toHaveValue('123.45');
    expect(figures.getByRole('heading', { name: 'Saved figures changed elsewhere' })).toBeVisible();
    if (mode === 'pending') {
      expect(screen.getByLabelText('Available cash (₹)')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Discard draft' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete plan' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Delete plan' }));
      expect(screen.queryByRole('dialog', { name: 'Delete this plan?' })).not.toBeInTheDocument();
    } else expect(screen.getByLabelText('Available cash (₹)')).toBeEnabled();
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
  });

  it.each(['active', 'unconfirmed'] as const)('blocks finishing and deletion for an %s existing call and returns to termination controls', async status => {
    vi.mocked(api.current).mockResolvedValue(planningSnapshot());
    if (status === 'active') vi.mocked(api.call).mockResolvedValue({ callId: join.callId, status: 'active', message: null });
    else vi.mocked(api.call).mockRejectedValue(new TypeError('Private call check failure'));
    render(<App />); await updates();
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(status === 'active' ? 'Another conversation is still open.' : 'We couldn’t confirm the call ended.');
    expect(screen.getByRole('button', { name: 'Your figures' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
    expect(screen.getByText('Delete saved figures and draft', { selector: 'button' })).toBeDisabled();
    expect(screen.getByText('Delete saved figures and draft', { selector: 'button' })).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Return to conversation' }));
    expect(conversation().getByRole('button', { name: 'Retry ending call' })).toBeEnabled();
    for (const element of screen.queryAllByText('Private call check failure')) expect(element).not.toBeVisible();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    const ending = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValueOnce(ending.promise);
    await userEvent.click(conversation().getByRole('button', { name: 'Retry ending call' }));
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    expect(screen.getByText('Delete saved figures and draft', { selector: 'button' })).toBeDisabled();
    await act(async () => ending.resolve({ callId: join.callId, status: 'ended', message: null }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled());
    expect(api.delete).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
  });

  it('blocks page navigation during capture while leaving sign-out available and immediately releasing the microphone', async () => {
    const pending = deferred<void>(); vi.mocked(api.auth.logout).mockReturnValue(pending.promise);
    render(<App />); const stream = await updates(); await connect(); ready();
    act(() => stream.emit('snapshot', { ...planningSnapshot(), sequence: 1 }));
    await userEvent.click(screen.getByRole('link', { name: 'Account' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app');
    expect(screen.getByRole('status', { name: 'A conversation is open' })).toHaveTextContent('End it before opening another page.');
    expect(screen.getByRole('button', { name: 'End conversation' })).toBeEnabled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
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
    else await screen.findByRole('heading', { name: 'Sign-in connection unavailable' });
  });
});