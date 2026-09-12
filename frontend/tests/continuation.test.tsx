// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import type { PipecatClientOptions } from '@pipecat-ai/client-js';
import { beforeEach, expect, it, vi } from 'vitest';
import { appRouter, mockAuth } from './appSupport';
import { api, ApiError, invalidateRequests } from '../src/api';
import type { Snapshot } from '../src/api';
import { settings, snapshot, Stream } from './fixtures';
import { savedConversation } from './history';
import { isConversationRoute } from '../src/historyRoutes';
import { returnPath } from '../src/Login';

const sdk = vi.hoisted(() => ({ devices: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(),
  callbacks: [] as NonNullable<PipecatClientOptions['callbacks']>[] }));
vi.mock('../src/ringback', () => ({ startRingback: () => vi.fn() }));
vi.mock('@pipecat-ai/client-js', async original => ({ ...await original<typeof import('@pipecat-ai/client-js')>(),
  /** Captures per-attempt callbacks and supplies a microphone double for continuation tests. */
  PipecatClient: class {
    /** Retains callbacks so tests can deliver readiness to a specific connection attempt. */
    constructor(options: PipecatClientOptions) { sdk.callbacks.push(options.callbacks!); }
    initDevices = sdk.devices;
    connect = sdk.connect;
    disconnect = sdk.disconnect;
    isMicEnabled = true;
    enableMic(enabled: boolean) { this.isMicEnabled = enabled; }
    on() {}
    /** Supplies a live local audio track double with a shared stop spy. */
    tracks() { return { local: { audio: Object.assign(new EventTarget(), { kind: 'audio', readyState: 'live', enabled: true, muted: false, stop: sdk.stop }) } }; }
  },
}));
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: class { dailyCallClient = { on: vi.fn(), off: vi.fn() }; } }));

/** Creates a chat-specific snapshot fixture with matching revision and stream sequence. */
function chat(slug: string, sequence: number): Snapshot {
  return { ...snapshot(), sessionId: `session-${slug}`, conversationSlug: slug, sequence, revision: sequence };
}
/** Exposes a promise resolver for ordering chat selection and call responses in tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let saved: Snapshot;
beforeEach(() => {
  mockAuth(); saved = chat('chat-b', 0);
  Stream.instances = []; sdk.callbacks.length = 0;
  for (const method of [sdk.devices, sdk.connect, sdk.disconnect]) method.mockReset().mockResolvedValue(undefined);
  sdk.stop.mockReset();
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(api, 'settings').mockResolvedValue({ ...settings, voiceAvailable: true });
  vi.spyOn(api, 'current').mockImplementation(async () => saved);
  vi.spyOn(api, 'start').mockImplementation(async () => saved);
  vi.spyOn(api, 'save').mockResolvedValue(saved);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', cleanupConfirmed: true, message: null });
  vi.spyOn(api, 'endCall').mockImplementation(async callId => ({ callId, status: 'ended', cleanupConfirmed: true, message: null }));
  vi.spyOn(api, 'startCall').mockImplementation(async (callId, conversationSlug) => ({ callId, conversationSlug: conversationSlug ?? 'chat-a',
    url: 'https://test.daily.co/room', token: 'synthetic-only', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  vi.spyOn(api.history, 'list').mockResolvedValue({ conversations: [savedConversation('chat-a'), savedConversation('chat-b')] });
  vi.spyOn(api.history, 'get').mockImplementation(async slug => savedConversation(slug));
  vi.spyOn(api.history, 'continue').mockImplementation(async slug => { saved = chat(slug, saved.sequence + 1); return saved; });
});

/** Renders a route and delivers the current chat fixture through its first event stream. */
async function show(path: string) {
  const router = appRouter(path);
  const view = render(<RouterProvider router={router} />);
  await waitFor(() => expect(Stream.instances.length).toBeGreaterThan(0));
  act(() => Stream.instances[0].emit('snapshot', saved));
  return { router, ...view };
}
/** Waits for the latest stream double to remain open and delivers the selected chat snapshot. */
async function currentStream() {
  await waitFor(() => expect(Stream.instances.at(-1)?.closed).toBe(false));
  act(() => Stream.instances.at(-1)!.emit('snapshot', saved));
}

it('selects History A once before navigation, waits for A SSE, then starts exactly once with A memory', async () => {
  const selection = deferred<Snapshot>();
  vi.mocked(api.history.continue).mockReturnValueOnce(selection.promise);
  const { router } = await show('/history/chat-a');
  const button = await screen.findByRole('button', { name: 'Continue talking' });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.dblClick(button);
  expect(api.history.continue).toHaveBeenCalledExactlyOnceWith('chat-a');
  expect(router.state.location.pathname).toBe('/history/chat-a');
  expect(sdk.devices).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Download captions' })).toBeEnabled();
  saved = chat('chat-a', 1);
  await act(async () => selection.resolve(saved));
  await waitFor(() => expect(router.state.location.pathname).toBe('/app/chat-a'));
  expect(sdk.devices).not.toHaveBeenCalled();
  const stream = Stream.instances.at(-1)!;
  act(() => { stream.onopen?.(); stream.emit('snapshot', chat('chat-b', 8)); });
  expect(sdk.devices).not.toHaveBeenCalled();
  await currentStream();
  await waitFor(() => expect(api.startCall).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'chat-a'));
  expect(sdk.devices).toHaveBeenCalledOnce();
  expect(screen.getByRole('img', { name: 'Connecting' })).toBeVisible();
  act(() => { stream.emit('snapshot', saved); sdk.callbacks[0].onConnected?.(); });
  expect(screen.getByText('Connecting to assistant')).toBeVisible();
  expect(sdk.devices).toHaveBeenCalledOnce();
  expect(api.save).not.toHaveBeenCalled();
});

it.each(['provider', 'updates'] as const)('reconnects A after %s loss with a fresh call ID and no B memory', async loss => {
  saved = chat('chat-a', 1);
  await show('/app/chat-a');
  const start = screen.getByRole('button', { name: 'Start talking' });
  await waitFor(() => expect(start).toBeEnabled()); await userEvent.click(start);
  await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
  act(() => sdk.callbacks[0].onBotReady?.({ version: '2.1' }));
  act(() => { if (loss === 'provider') sdk.callbacks[0].onDisconnected?.(); else Stream.instances.at(-1)!.onerror?.(); });
  await waitFor(() => expect(api.endCall).toHaveBeenCalledOnce());
  expect(sdk.stop).toHaveBeenCalled();
  expect(api.startCall).toHaveBeenCalledOnce();
  if (loss === 'updates') await currentStream();
  const reconnect = within(screen.getByRole('region', { name: 'Your conversation' })).getByRole('button', { name: 'Reconnect' });
  await waitFor(() => expect(reconnect).toBeEnabled()); await userEvent.click(reconnect);
  await waitFor(() => expect(api.startCall).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(api.startCall).mock.calls;
  expect(calls.map(call => call[1])).toEqual(['chat-a', 'chat-a']);
  expect(calls[0][0]).not.toBe(calls[1][0]);
  expect(api.history.continue).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
});

it('adopts a first call’s rotated snapshot and specific URL before connecting, without an extra microphone request', async () => {
  saved = snapshot();
  vi.mocked(api.startCall).mockImplementationOnce(async callId => {
    saved = chat('chat-a', 1);
    return { callId, conversationSlug: 'chat-a', url: 'https://test.daily.co/room', token: 'synthetic-only', expiresAt: new Date(Date.now() + 60000).toISOString() };
  });
  const { router } = await show('/app');
  await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/app/chat-a'));
  expect(sdk.connect).not.toHaveBeenCalled();
  await currentStream();
  await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
  expect(sdk.devices).toHaveBeenCalledOnce();
  expect(api.endCall).not.toHaveBeenCalled();
  expect(api.history.continue).not.toHaveBeenCalled();
});

it('recovers a logical chat committed by a failed POST before Join rather than creating another chat', async () => {
  saved = snapshot();
  vi.mocked(api.startCall).mockImplementationOnce(async () => { saved = chat('chat-a', 1); throw new TypeError('response lost'); });
  const { router } = await show('/app');
  await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
  await waitFor(() => expect(api.endCall).toHaveBeenCalledOnce());
  const reconnect = within(screen.getByRole('region', { name: 'Your conversation' })).getByRole('button', { name: 'Reconnect' });
  await waitFor(() => expect(reconnect).toBeEnabled()); await userEvent.click(reconnect);
  await currentStream();
  await waitFor(() => expect(api.startCall).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.startCall).mock.calls[1][1]).toBe('chat-a');
  await waitFor(() => expect(router.state.location.pathname).toBe('/app/chat-a'));
  expect(api.history.continue).not.toHaveBeenCalled();
});

it('keeps a first call alive when its rotated snapshot arrives before the pending Join response', async () => {
  saved = snapshot();
  const join = deferred<Awaited<ReturnType<typeof api.startCall>>>();
  vi.mocked(api.startCall).mockReturnValueOnce(join.promise);
  const { router } = await show('/app');
  await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
  await waitFor(() => expect(api.startCall).toHaveBeenCalledOnce());
  const callId = vi.mocked(api.startCall).mock.calls[0][0];
  saved = chat('chat-a', 1);
  act(() => Stream.instances.at(-1)!.emit('snapshot', saved));
  expect(router.state.location.pathname).toBe('/app');
  expect(sdk.stop).not.toHaveBeenCalled(); expect(api.endCall).not.toHaveBeenCalled();
  expect(sdk.connect).not.toHaveBeenCalled();
  await act(async () => join.resolve({ callId, conversationSlug: 'chat-a', url: 'https://test.daily.co/room',
    token: 'synthetic-only', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/app/chat-a'));
  expect(sdk.connect).not.toHaveBeenCalled();
  await currentStream();
  await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
  expect(sdk.devices).toHaveBeenCalledOnce(); expect(api.endCall).not.toHaveBeenCalled();
  expect(api.history.continue).not.toHaveBeenCalled();
});

it('retains the lost POST’s owned slug and refuses a different chat selected before reconnect', async () => {
  saved = snapshot();
  vi.mocked(api.startCall).mockImplementationOnce(async () => { saved = chat('chat-a', 1); throw new TypeError('response lost'); });
  vi.mocked(api.endCall).mockImplementationOnce(async callId => ({ callId, conversationSlug: 'chat-a', status: 'ended', cleanupConfirmed: true, message: null }));
  await show('/app');
  await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
  const reconnect = within(screen.getByRole('region', { name: 'Your conversation' })).getByRole('button', { name: 'Reconnect' });
  await waitFor(() => expect(reconnect).toBeEnabled());
  saved = chat('chat-b', 2);
  await userEvent.click(reconnect);
  expect(await screen.findByText('Your microphone is off. Open this conversation again from History before continuing.')).toBeVisible();
  expect(api.startCall).toHaveBeenCalledOnce(); expect(api.endCall).toHaveBeenCalledOnce();
  expect(api.history.continue).not.toHaveBeenCalled(); expect(sdk.connect).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Retry ending call' })).not.toBeInTheDocument();
});

it('opens a direct A route without showing B or requesting the microphone, including refresh', async () => {
  const selection = deferred<Snapshot>(); vi.mocked(api.history.continue).mockReturnValueOnce(selection.promise);
  const view = await show('/app/chat-a');
  await waitFor(() => expect(api.history.continue).toHaveBeenCalledOnce());
  expect(screen.getByRole('region', { name: 'Opening your conversation…' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Your financial picture' })).not.toBeInTheDocument();
  saved = chat('chat-a', 1); await act(async () => selection.resolve(saved)); await currentStream();
  expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled();
  expect(sdk.devices).not.toHaveBeenCalled(); view.unmount();
  Stream.instances = [];
  await show('/app/chat-a');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled());
  expect(api.history.continue).toHaveBeenCalledOnce();
  expect(sdk.devices).not.toHaveBeenCalled();
});

it('serializes route switches and cannot publish delayed A into B', async () => {
  const selection = deferred<Snapshot>(); vi.mocked(api.history.continue).mockReturnValueOnce(selection.promise);
  const { router } = await show('/app/chat-a');
  await waitFor(() => expect(api.history.continue).toHaveBeenCalledOnce());
  await act(async () => router.navigate('/app/chat-b'));
  expect(sdk.devices).not.toHaveBeenCalled();
  saved = chat('chat-a', 1); await act(async () => selection.resolve(saved));
  await waitFor(() => expect(api.history.continue).toHaveBeenCalledTimes(2));
  await currentStream();
  expect(router.state.location.pathname).toBe('/app/chat-b');
  expect(saved.conversationSlug).toBe('chat-b');
  expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled();
  expect(sdk.devices).not.toHaveBeenCalled();
});

it.each([403, 404, 410])('rejects not-owned, missing or expired History A (%s) inline without a call', async status => {
  vi.mocked(api.history.continue).mockRejectedValue(new ApiError(status, { code: 'notFound', message: 'private diagnostic' }));
  const { router } = await show('/history/chat-a');
  const button = await screen.findByRole('button', { name: 'Continue talking' });
  await waitFor(() => expect(button).toBeEnabled()); await userEvent.click(button);
  expect(await screen.findByText(/This conversation is unavailable/)).toBeVisible();
  expect(router.state.location.pathname).toBe('/history/chat-a');
  expect(screen.queryByText('private diagnostic')).not.toBeInTheDocument();
  expect(sdk.devices).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  await currentStream();
  expect(button).toBeEnabled();
});

it('keeps confirmed-call cleanup available after a rejected History selection', async () => {
  vi.mocked(api.history.continue).mockImplementation(async () => {
    vi.mocked(api.call).mockResolvedValue({ callId: 'another-call', status: 'active', cleanupConfirmed: false, message: null, conversationSlug: 'chat-b' });
    throw new ApiError(409, { code: 'callBusy', message: 'Internal state' });
  });
  const { router } = await show('/history/chat-a');
  const button = await screen.findByRole('button', { name: 'Continue talking' });
  await waitFor(() => expect(button).toBeEnabled()); await userEvent.click(button);
  expect(await screen.findByText(/A call may still be open/)).toBeVisible();
  await currentStream();
  expect(button).toBeDisabled();
  await act(async () => router.navigate('/app'));
  await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
  const end = within(screen.getByRole('region', { name: 'Your conversation' })).getByRole('button', { name: 'Retry ending call' });
  await userEvent.click(end);
  expect(api.endCall).toHaveBeenCalledWith('another-call');
  expect(sdk.devices).not.toHaveBeenCalled();
});

it('disables History Continue during a live call and cleanup, retaining downloads and the mounted call', async () => {
  saved = chat('chat-a', 1);
  const { router } = await show('/app/chat-a');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start talking' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Start talking' }));
  await waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
  act(() => sdk.callbacks[0].onBotReady?.({ version: '2.1' }));
  await act(async () => router.navigate('/history/chat-b'));
  expect(api.endCall).not.toHaveBeenCalled();
  expect(sdk.disconnect).not.toHaveBeenCalled();
  const button = await screen.findByRole('button', { name: 'Continue talking' });
  expect(button).toBeDisabled(); expect(screen.getByRole('button', { name: 'Download captions' })).toBeEnabled();
  await act(async () => router.navigate('/app/chat-b'));
  expect(router.state.location.pathname).toBe('/history/chat-b');
  const cleanup = deferred<Awaited<ReturnType<typeof api.endCall>>>(); vi.mocked(api.endCall).mockReturnValueOnce(cleanup.promise);
  act(() => sdk.callbacks[0].onDisconnected?.());
  expect(button).toBeDisabled();
  await act(async () => cleanup.resolve({ callId: vi.mocked(api.startCall).mock.calls[0][0], status: 'ended', cleanupConfirmed: true, message: null }));
  await waitFor(() => expect(button).toBeEnabled());
  expect(api.history.continue).not.toHaveBeenCalled(); expect(sdk.devices).toHaveBeenCalledOnce();
});

it('does not navigate or open the microphone for a selection from a previous authentication epoch', async () => {
  const selection = deferred<Snapshot>(); vi.mocked(api.history.continue).mockReturnValueOnce(selection.promise);
  const { router } = await show('/history/chat-a');
  const button = await screen.findByRole('button', { name: 'Continue talking' });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  invalidateRequests(); await act(async () => selection.resolve(chat('chat-a', 1)));
  expect(router.state.location.pathname).toBe('/history/chat-a');
  expect(sdk.devices).not.toHaveBeenCalled();
});

it.each(['/app', '/app/chat-a', '/app/conversation-2026-09-12-101500'])('preserves the clean authenticated route %s', path => {
  expect(isConversationRoute(path)).toBe(true); expect(returnPath(path)).toBe(path);
});
it.each(['/app/', '/app/a?start=1', '/app/a#start', '/app/a/b', '/app/a\n', '/app/UPPER', '/app/a--b', '/app/../history', '//other.test/app/a'])('rejects ambiguous conversation route %s', path => {
  expect(isConversationRoute(path)).toBe(false); expect(returnPath(path)).toBe('/app');
});

it('uses the backend’s 119-character slug bound for direct and sign-in routes', () => {
  const path = `/app/${'a'.repeat(119)}`;
  expect(isConversationRoute(path)).toBe(true); expect(returnPath(path)).toBe(path);
  expect(isConversationRoute(`${path}a`)).toBe(false); expect(returnPath(`${path}a`)).toBe('/app');
});