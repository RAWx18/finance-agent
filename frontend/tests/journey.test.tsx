// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RTVIEvent } from '@pipecat-ai/client-js';
import type { Participant, PipecatClientOptions } from '@pipecat-ai/client-js';
import { App, appRouter, mockAuth } from './appSupport';
import { api, ApiError, reportAuthLoss } from '../src/api';
import { adjustmentOptions, choiceSnapshot, planningSnapshot, questionSnapshot, scenario, settings, snapshot, Stream, unconfirmedSnapshot } from './fixtures';
import { projectWorkspace } from './workspace';

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
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: class { dailyCallClient = { destroy: sdk.destroy, on: sdk.dailyOn, off: sdk.dailyOff }; } }));

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
    if (retry) {
      const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
      expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Save not confirmed' })).toBe(notice);
      expect(within(picture).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
      await userEvent.click(within(notice).getByRole('button', { name: 'Retry same action' }));
    }
    expect(consent).toBeDisabled();
    expect(consent).not.toBeChecked();
    const end = conversation().getByRole('button', { name: 'End conversation' });
    end.focus(); scroll.mockClear();
    await act(async () => conflict.resolve());
    const feedback = screen.getByRole('alert', { name: 'Action needs attention' });
    expect(feedback).toBeVisible();
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Action needs attention' })).toBe(feedback);
    expect(within(picture).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
    expect(within(picture).queryByText(/Your answer was not saved/)).not.toBeInTheDocument();
    expect(feedback).not.toHaveClass('sr-only');
    expect(feedback).toHaveTextContent('Your answer was not saved because the open proposal differs from this suggested cut. Review the proposal or choose “Reject preview” before answering again.');
    expect(end).toHaveFocus();
    expect(scroll).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(screen.queryByText(/private conflicting proposal diagnostic|no longer available to accept/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(within(picture).getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
    expect(proposal).toHaveTextContent('₹2,000.00 Reported → ₹500.00 Proposed');
    expect(consent).toBeEnabled();
    expect(consent).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeEnabled();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('alert', { name: 'Action needs attention' })).not.toBeInTheDocument();
    expect(commands.at(-1)![0]).toMatchObject({ expectedRevision: saved.revision,
      operation: { type: 'rejectPreview', previewId: saved.preview.id } });
    expect(commands.at(-1)![0].commandId).not.toBe(commands[0][0].commandId);
    expect(consent).toBeDisabled();
    await act(async () => discard.resolve(projectWorkspace({ ...saved, sequence: 2, preview: null })));
    act(() => stream.emit('snapshot', saved));
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(picture).queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    expect(within(picture).queryByText(/Preview rejected|Your answer is saved/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    expect(within(picture).getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹7,000.00');
    expect(within(picture).getByRole('button', { name: 'Do not suggest this cut' })).toBeEnabled();
    expect(commands).toHaveLength(retry ? 3 : 2);
    expect(saved).toEqual(original);
    expect(voiceStatus()).toHaveTextContent('Listening');
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(api.endCall).not.toHaveBeenCalled();
    expect(api.options).not.toHaveBeenCalled();
  });

  it('shows changed-next-step guidance for an invalid answer and clears it on a newer live snapshot without inventing figures', async () => {
    vi.mocked(api.current).mockResolvedValue(questionSnapshot());
    vi.mocked(api.save).mockRejectedValueOnce(new ApiError(422, {
      code: 'invalidActionResponse', message: 'private unsupported action diagnostic', snapshot: questionSnapshot(),
    }));
    render(<App />); const stream = await updates(); await connect(); ready();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'I cannot confirm this now' }));
    const notice = screen.getByRole('alert', { name: 'Action needs attention' });
    expect(notice).toBeVisible();
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Action needs attention' })).toBe(notice);
    expect(within(picture).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
    expect(within(picture).queryByText(/Your answer was not saved/)).not.toBeInTheDocument();
    expect(notice).toHaveTextContent('Your answer was not saved because this next step has changed or is no longer available. Review the current next step before answering again.');
    expect(screen.queryByText(/Check amounts|private unsupported action diagnostic/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I cannot confirm this now' })).toBeEnabled();
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: 0,
      operation: { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' } });
    act(() => stream.emit('snapshot', { ...snapshot(), sequence: 1 }));
    expect(within(picture).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Action needs attention' })).not.toBeInTheDocument();
    expect(within(picture).getByRole('heading', { name: 'No figures yet' })).toBeVisible();
    expect(within(picture).queryByText(/₹0\.00|Your answer is saved/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
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
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(proposal).toHaveTextContent('₹2,000.00 Reported → ₹0.00 Proposed');
    expect(within(proposal).getByRole('region', { name: 'After · preview' })).toHaveTextContent('First cash gap₹7,000.00 · 13 Sept 2026');
    expect(proposal).toHaveTextContent('A higher closing balance does not remove an earlier cash gap.');
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    expect(within(proposal).getByRole('heading', { name: 'Spending change preview' })).toHaveFocus();
    if (operation === 'acceptPreview') {
      await userEvent.click(within(proposal).getByRole('button', { name: 'Accept planning assumptions' }));
      expect(api.save).not.toHaveBeenCalled();
      await userEvent.click(within(proposal).getByRole('checkbox'));
    }
    await userEvent.click(within(proposal).getByRole('button', { name: operation === 'acceptPreview' ? 'Accept planning assumptions' : operation === 'rejectPreview' ? 'Reject preview' : 'Close preview' }));
    const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
    const retry = within(notice).getByRole('button', { name: 'Retry same action' });
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Save not confirmed' })).toBe(notice);
    expect(within(screen.getByRole('region', { name: 'Your financial picture' })).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    expect(retry).toBeVisible();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument());
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹7,000.00');
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    if (operation === 'acceptPreview') {
      const assumptions = screen.getByRole('article', { name: /Accepted planning assumptions/ });
      await userEvent.click(within(assumptions).getByText('Terms for this change', { selector: 'summary' }));
      expect(within(assumptions).getByText('Consent saved for this occurrence; not a completed action.')).toBeVisible();
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
    render(<App />); const stream = await updates(); await connect(); ready();
    const answer = screen.getByRole('button', { name: response === 'unavailable' ? 'I cannot confirm this now' : 'Do not suggest this cut' });
    await userEvent.click(answer);
    const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
    const retry = within(notice).getByRole('button', { name: 'Retry same action' });
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Save not confirmed' })).toBe(notice);
    expect(within(screen.getByRole('region', { name: 'Your financial picture' })).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
    expect(answer).toBeDisabled();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    const command = vi.mocked(api.save).mock.calls[0][0];
    expect(command.operation).toEqual({ type: 'respondToAction', actionId: saved.plan.decisionAssessment!.nextActionId, response });
    act(() => stream.emit('snapshot', confirmed));
    expect(retry).toBeVisible();
    expect(screen.getByRole('region', { name: 'Your financial picture' })).toHaveTextContent(confirmed.plan.decisionAssessment!.actions![0].question);
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
    vi.mocked(api.current).mockResolvedValue(questionSnapshot());
    const deferred = unconfirmedSnapshot();
    vi.mocked(api.save).mockResolvedValueOnce(deferred);
    render(<App />); const stream = await updates(); await connect(); ready();
    await userEvent.click(screen.getByRole('button', { name: 'I cannot confirm this now' }));
    await waitFor(() => expect(screen.getByLabelText('Saved answers')).toHaveTextContent('Unconfirmed details remain open.'));
    expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({ expectedRevision: 0,
      operation: { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' } });
    expect(screen.getByRole('article', { name: 'Information that changes the plan' })).toHaveTextContent(deferred.plan.decisionAssessment!.actions![0].question);
    expect(screen.queryByRole('article', { name: 'Available opening cash' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your financial picture' })).not.toHaveTextContent('₹0.00');
    act(() => stream.emit('snapshot', snapshot()));
    expect(screen.getByRole('article', { name: 'Qualified outlook' })).toHaveTextContent('Unconfirmed details remain open.');
    const questions = screen.getByRole('article', { name: 'Information that changes the plan' });
    expect(questions).toHaveTextContent('What cash was available at the original cash basis?');
    expect(questions).toHaveTextContent(deferred.plan.decisionAssessment!.actions![0].question);
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
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
    vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace(declined));
    act(() => stream.emit('snapshot', saved));
    const next = screen.getByRole('region', { name: 'Next steps' });
    await userEvent.click(within(next).getByRole('button', { name: 'Do not suggest this cut' }));
    await waitFor(() => expect(screen.getByLabelText('Saved answers')).toHaveTextContent('Declined cuts are not assumed.'));
    expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({ expectedRevision: saved.revision,
      operation: { type: 'respondToAction', actionId: 'preview-spending', response: 'declined' } });
    const focus = screen.getByRole('article', { name: 'Cash gap and timing risk' });
    expect(next).toHaveTextContent('Contact the payee');
    expect(within(next).getByRole('button', { name: 'I cannot take this step now' })).toBeEnabled();
    expect(within(focus).queryByRole('button', { name: /Do not suggest this cut|I cannot confirm this now/ })).not.toBeInTheDocument();
    expect(focus).toHaveTextContent('₹7,000.00');
    act(() => stream.emit('snapshot', saved));
    expect(screen.queryByRole('button', { name: 'Do not suggest this cut' })).not.toBeInTheDocument();
    expect(declined.facts.records).toEqual(saved.facts.records);
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('region', { name: 'Your financial picture' })).toHaveTextContent('No figures yet');
    await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    expect(sdk.initDevices).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(sdk.options).toMatchObject({ enableMic: true, enableCam: false });
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(screen.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
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
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Let’s talk it through.');
    expect(view.container.querySelector('details')).not.toBeInTheDocument();
    expect(view.container.querySelector('video')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /camera/i })).not.toBeInTheDocument();
    expect(view.container.querySelector('audio')).toBe(audio);
  });

  it.each(['/money', '/account'])('returns from %s to the latest local conversation without opening the microphone', async route => {
    vi.mocked(api.current).mockResolvedValue(planningSnapshot());
    const router = appRouter('/app');
    render(<RouterProvider router={router} />);
    const stream = await updates();
    await userEvent.click(await screen.findByRole('button', { name: /Review saved picture/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Return to conversation' }));
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
    act(() => stream.emit('snapshot', corrected));
    await act(async () => router.navigate('/app'));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'ready');
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).getByRole('article', { name: 'Available opening cash' })).toHaveTextContent('₹7,654.32');
    expect(within(picture).getByRole('listitem', { name: 'Home rent' })).toHaveTextContent('₹11,000.00');
    expect(within(picture).getByRole('listitem', { name: 'Home rent' })).toHaveTextContent('14 Sept 2026');
    act(() => stream.emit('snapshot', planningSnapshot()));
    expect(within(picture).getByRole('article', { name: 'Available opening cash' })).toHaveTextContent('₹7,654.32');
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
    expect(within(picture).getByRole('article', { name: 'Available opening cash' })).toHaveTextContent('₹7,654.32');
    expect(within(picture).getByRole('listitem', { name: 'Home rent' })).toHaveTextContent('₹11,000.00');
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

  it('keeps the live call and captions mounted through detail dialogs and reports actual activity', async () => {
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
    const list = within(picture).getByRole('list', { name: 'Essential spending' });
    expect(list).toBeVisible();
    expect(list.querySelectorAll('.fact-row')).toHaveLength(5);
    expect(within(list).getByRole('listitem', { name: 'Bill 4' })).toHaveTextContent('Unknown');
    expect(within(picture).queryByRole('button', { name: /View all figures|Edit figures|What this is based on/ })).not.toBeInTheDocument();
    for (const label of ['Plan details', 'Checks for Rent', 'Details: Contact the payee · Rent']) {
      const trigger = within(picture).getByRole('button', { name: label });
      await userEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: label });
      expect(dialog).toBeVisible();
      expect(within(dialog).getByRole('heading', { name: label })).toHaveFocus();
      if (label === 'Details: Contact the payee · Rent') {
        expect(within(screen.getByRole('region', { name: 'Next steps' })).getByRole('button', { name: label })).toBe(trigger);
        expect(dialog).toHaveTextContent(saved.plan.decisionAssessment!.actions![0].question);
        expect(dialog).toHaveTextContent('Rent · Reported ₹12,000.00 · Due 13 Sept 2026');
        expect(dialog).toHaveTextContent('Unmet commitments: ₹7,000.00 on 13 Sept 2026');
        const corrected = structuredClone(saved); corrected.sequence = 2; corrected.revision = 1;
        corrected.facts.records[4].amount = { status: 'exact', amountPaise: 12345 };
        act(() => stream.emit('snapshot', corrected));
        expect(within(list).getByRole('listitem', { name: 'Bill 4' })).toHaveTextContent('₹123.45');
        expect(within(dialog).getByRole('heading', { name: label })).toHaveFocus();
      }
      if (label === 'Plan details') expect(dialog).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.conditions);
      if (label === 'Checks for Rent') expect(dialog).toHaveTextContent(saved.plan.decisionAssessment!.uncertainties![0].question);
      expect(document.querySelector('audio')).toBe(audio);
      expect(end).toBeInTheDocument(); expect(captions).toBeInTheDocument();
      expect(sdk.disconnect).not.toHaveBeenCalled(); expect(sdk.destroy).not.toHaveBeenCalled();
      expect(api.endCall).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole('button', { name: `Close ${label.toLowerCase()}` }));
      expect(dialog).not.toBeVisible(); expect(trigger).toHaveFocus();
    }
    expect(captions).toBeVisible();
    expect(conversation().getByRole('button', { name: 'End conversation' })).toBe(end);
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(document.querySelector('details')).not.toBeInTheDocument();
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
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹7,000.00');
  });

  it('streams authoritative gaps and salary corrections while live, rejects stale events, and ends in review without certifying missing facts', async () => {
    render(<App />); const stream = await updates(); await connect(); ready();
    const saved = planningSnapshot(); saved.revision = 1; saved.sequence = 1;
    saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { status: 'exact', amountPaise: 3000000 },
      schedule: { date: '2026-09-25', recurrence: 'monthly', certainty: 'exact' }, reliability: 'reliable', autoDebit: false });
    act(() => stream.emit('snapshot', saved));
    expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'taking-shape');
    expect(screen.getByRole('heading', { name: 'Your financial picture' })).toBeVisible();
    expect(screen.getByRole('article', { name: 'Available opening cash' })).toHaveTextContent('₹5,000.00');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹30,000.00');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('25 Sept 2026');
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹7,000.00');
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('13 Sept 2026');
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('Largest cash gap₹16,000.00');
    const records = within(screen.getByRole('region', { name: 'Financial picture details' })).getAllByRole('article');
    expect(records.map(item => item.getAttribute('aria-label'))).toEqual(['Available opening cash', 'Expected income', 'Essential spending', 'Information that changes the plan', 'Cash gap and timing risk', 'Dated cash requirements', 'Qualified outlook']);
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
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹32,000.00');
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('20 Sept 2026');
    expect(screen.getByRole('listitem', { name: 'Salary' })).not.toHaveTextContent(/₹30,000.00|25 Sept 2026/);
    expect(screen.getByRole('article', { name: 'Expected income' })).toHaveAttribute('data-changed', 'true');
    const changes = within(screen.getByRole('region', { name: 'Your financial picture' })).getByRole('status');
    expect(changes).toHaveTextContent('Salary: ₹30,000.00 → ₹32,000.00');
    expect(changes).toHaveTextContent('First cash gap: ₹7,000.00 → ₹12,345.67');
    expect(changes).toHaveTextContent('First cash gap: 13 Sept 2026 → 16 Sept 2026');
    expect(changes).toHaveAttribute('aria-live', 'polite');
    expect(changes).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Financial picture details' })).getAllByRole('article')).toEqual(records);
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹12,345.67');
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('Largest cash gap₹23,456.78 · 19 Sept 2026');
    expect(screen.getByRole('region', { name: 'Next steps' })).toHaveTextContent('Check a reported detail');
    expect(voiceStatus()).toHaveTextContent('Listening to you');
    expect(end).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Recent changes' }));
    const recent = screen.getByRole('dialog', { name: 'Recent changes' });
    expect(within(recent).getByRole('list', { name: 'Recent changes' })).toHaveTextContent('Salary date: 25 Sept 2026 → 20 Sept 2026');
    expect(within(recent).getByRole('list', { name: 'Recent changes' })).toHaveTextContent('Projected closing cash: ₹10,000.00 → ₹76,543.21');
    await userEvent.click(within(recent).getByRole('button', { name: 'Close recent changes' }));
    act(() => { stream.emit('snapshot', saved); stream.emit('snapshot', { ...saved, sequence: corrected.sequence }); });
    expect(screen.getByRole('listitem', { name: 'Salary' })).toHaveTextContent('₹32,000.00');
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹12,345.67');
    expect(changes).toHaveTextContent('First cash gap: 13 Sept 2026 → 16 Sept 2026');
    expect(voiceStatus()).toHaveTextContent('Listening to you');
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
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
    expect(within(picture).getByRole('article', { name: 'Information that changes the plan' })).toHaveTextContent('Verify the corrected receipt timing.');
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
    expect(document.querySelector('audio')!.srcObject).toBeFalsy();
    expect(sdk.disconnect).toHaveBeenCalledOnce(); expect(sdk.destroy).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(within(picture).getByRole('article', { name: 'Qualified outlook' })).toHaveTextContent('Your picture is still taking shape');
    act(() => stream.onerror?.());
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    act(() => stream.onopen?.());
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    act(() => stream.emit('snapshot', saved));
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    const steps = within(picture).getByRole('region', { name: 'Next steps' });
    expect(steps).toBeVisible();
    expect(steps).toHaveTextContent('Verify the corrected receipt timing.');
    await userEvent.click(within(steps).getByRole('button', { name: 'Details: Check a reported detail · Salary' }));
    const detail = screen.getByRole('dialog', { name: 'Details: Check a reported detail · Salary' });
    expect(detail).toHaveTextContent('Verify the corrected receipt timing.');
    expect(detail).toHaveTextContent('Salary · Reported ₹32,000.00 · Expected 20 Sept 2026');
    await userEvent.click(within(detail).getByRole('button', { name: 'Close details: check a reported detail · salary' }));
    act(() => stream.emit('snapshot', corrected));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument();
    expect(sdk.connect).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Finish review' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-view', 'finished'));
    expect(screen.getByRole('heading', { name: 'Your next step is clearer.' })).toBeVisible();
    expect(within(picture).getByRole('article', { name: 'Qualified outlook' })).toHaveTextContent('Your picture is still taking shape');
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
    await userEvent.click(moneyLink());
    await planChanges();
    const comparison = within(screen.getByRole('region', { name: 'Spending change preview' }));
    await userEvent.click(comparison.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(comparison.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish review' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'finished');
    const corrected = structuredClone(saved); corrected.sequence = 1;
    corrected.plan.closingPaise = 123456; corrected.preview!.plan.closingPaise = 234567;
    act(() => stream.emit('snapshot', corrected));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'review');
    expect(screen.getByRole('heading', { name: 'Your figures have changed.' })).toBeVisible();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const details = within(picture).getByRole('region', { name: 'Financial picture details' });
    expect(within(details).getByRole('article', { name: 'Dated cash requirements' })).toHaveTextContent('₹1,234.56');
    expect(within(picture).getByRole('article', { name: 'Cash gap and timing risk' })).not.toHaveTextContent('₹2,345.67');
    const proposal = within(picture).getByRole('region', { name: 'Spending change preview' });
    expect(proposal).toBeVisible();
    await userEvent.click(within(picture).getByRole('button', { name: 'Review proposed change' }));
    expect(within(proposal).getByRole('heading', { name: 'Spending change preview' })).toHaveFocus();
    const after = within(proposal).getByRole('region', { name: 'After · preview' });
    await userEvent.click(within(after).getByText('More calculated results', { selector: 'summary' }));
    expect(after).toHaveTextContent('₹2,345.67');
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await userEvent.click(moneyLink());
    await planChanges();
    expect(proposal).not.toBeVisible();
    expect(comparison.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(comparison.getByText('Review this exact preview before accepting.')).toBeVisible();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('shows saved assumptions in a separate card without treating them as reported facts or payments', async () => {
    const saved = planningSnapshot(); saved.accepted = scenario('accepted-one');
    saved.accepted.adjustments[0].acceptedRevision = 0;
    vi.mocked(api.current).mockResolvedValue(projectWorkspace(saved));
    render(<App />); await updates();
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const assumptions = within(picture).getByRole('article', { name: /Accepted planning assumptions/ });
    expect(assumptions).toBeVisible();
    expect(assumptions).toHaveTextContent('Accepted does not mean paid');
    const timeline = within(picture).getByRole('article', { name: 'Dated cash requirements' });
    expect(within(timeline).getByText('Projected closing cash').parentElement).toHaveTextContent('₹12,000.00');
    expect(within(assumptions).getByRole('list', { name: 'Planning assumptions' })).toHaveTextContent('₹2,000.00 Reported → ₹0.00 Saved');
    await userEvent.click(within(assumptions).getByText('Terms for this change', { selector: 'summary' }));
    expect(within(assumptions).getByText('Consent saved for this occurrence; not a completed action.')).toBeVisible();
    const basis = within(picture).getByRole('region', { name: 'What you’ve shared' });
    expect(basis).toBeVisible();
    expect(within(basis).getByRole('article', { name: 'Available opening cash' })).toHaveTextContent('₹5,000.00');
    expect(within(basis).getByRole('listitem', { name: 'Rent' })).toHaveTextContent('₹12,000.00');
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
    await userEvent.click(moneyLink());
    await planChanges();
    await userEvent.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
    expect(within(notice).getByRole('button', { name: 'Retry same action' })).toBeEnabled();
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    expect(moneyLink()).not.toHaveAccessibleDescription();
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Return to conversation' })).toBeDisabled();
    await userEvent.click(moneyLink());
    const money = within(screen.getByRole('region', { name: 'Money' }));
    expect(money.getByRole('button', { name: 'Correct starting cash' })).toBeDisabled();
    expect(money.queryByRole('alert', { name: 'Save not confirmed', hidden: true })).not.toBeInTheDocument();
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(money.getByRole('button', { name: 'Correct starting cash' })).toBeEnabled());
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(vi.mocked(api.save).mock.calls[0][0]);
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
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
    await waitFor(() => expect(voiceStatus()).toHaveTextContent(/^Disconnected$/));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-stage', 'disconnected'));
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'session');
    expect(within(screen.getByRole('alert', { name: 'Connection lost' })).getByText('Check your internet connection, then reconnect.')).toBeVisible();
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
    expect(voiceStatus()).toHaveTextContent(/^Listening$/);
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

  it('keeps failed call termination recoverable without claiming the plan or conversation is finished', async () => {
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
    expect(screen.queryByText('Conversation ended', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    const notice = within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert');
    expect(notice).toHaveTextContent('We couldn’t confirm the call ended.');
    expect(notice).not.toHaveTextContent('private termination diagnostic');
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹7,000.00');
    act(() => stream.onopen?.());
    expect(retry).toBeEnabled();
    expect(sdk.connect).toHaveBeenCalledOnce();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-view', 'review'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled());
    expect(api.endCall).toHaveBeenCalledTimes(2);
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹7,000.00');
  });

  it.each(['draft', 'pending'] as const)('locks voice, finishing and navigation with a %s correction while preserving input across SSE', async mode => {
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'));
    vi.mocked(api.current).mockResolvedValue(planningSnapshot());
    const router = appRouter();
    render(<RouterProvider router={router} />); const stream = await updates();
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    const finish = screen.getByRole('button', { name: 'Finish review' });
    const resume = screen.getByRole('button', { name: 'Return to conversation' });
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
    expect(finish).not.toBeVisible();
    expect(resume).not.toBeVisible();
    if (mode === 'pending') { expect(finish).toBeDisabled(); expect(resume).toBeDisabled(); }
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
    expect(finish).not.toBeVisible();
    expect(resume).not.toBeVisible();
    if (mode === 'pending') { expect(finish).toBeDisabled(); expect(resume).toBeDisabled(); }
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
    expect(finish).toBeEnabled();
    await userEvent.click(resume);
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled();
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
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(moneyLink());
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app');
    expect(screen.queryByRole('button', { name: 'Delete plan' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Return to conversation' }));
    expect(conversation().getByRole('button', { name: 'Retry ending call' })).toBeEnabled();
    for (const element of screen.queryAllByText('Private call check failure')) expect(element).not.toBeVisible();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    const ending = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValueOnce(ending.promise);
    await userEvent.click(conversation().getByRole('button', { name: 'Retry ending call' }));
    expect(screen.queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    expect(moneyLink()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Delete plan' })).not.toBeInTheDocument();
    await act(async () => ending.resolve({ callId: join.callId, status: 'ended', message: null }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled());
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
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app');
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