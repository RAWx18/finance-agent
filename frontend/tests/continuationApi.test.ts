// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { api, readSnapshot } from '../src/api';
import { snapshot } from './fixtures';

it('selects only the slug with an empty authenticated JSON body, never trusted transcript or mutations', async () => {
  const selected = { ...snapshot(), conversationSlug: 'chat-a' };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(selected)));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(api.history.continue('chat-a', controller.signal)).resolves.toEqual(selected);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/history/chat-a/continue', { credentials: 'same-origin', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
});

it('passes explicit logical identity alongside a fresh media ID and preserves the keepalive cleanup contract', async () => {
  const callId = crypto.randomUUID();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ callId, conversationSlug: 'chat-a',
    url: 'https://test.daily.co/room', token: 'synthetic', expiresAt: new Date(Date.now() + 60000).toISOString() })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ callId, status: 'ended', cleanupConfirmed: true, message: null })));
  vi.stubGlobal('fetch', fetch);
  await api.startCall(callId, 'chat-a'); await api.endCall(callId);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ callId, conversationSlug: 'chat-a' });
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'DELETE', keepalive: true, body: JSON.stringify({ callId }) });
});

it.each([undefined, null, '', 'chat-b', '../b', 'chat-a?start=1'])('rejects unconfirmed or mismatched Join identity %j', async conversationSlug => {
  const callId = crypto.randomUUID();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ callId, conversationSlug,
    url: 'https://test.daily.co/room', token: 'synthetic', expiresAt: new Date(Date.now() + 60000).toISOString() }))));
  await expect(api.startCall(callId, 'chat-a')).rejects.toThrow('Conversation ownership could not be confirmed.');
});

it.each([undefined, '', 123, 'chat/a', 'chat-a#start'])('rejects snapshots missing safe logical identity %j', conversationSlug => {
  expect(() => readSnapshot({ ...snapshot(), conversationSlug })).toThrow();
});

it.each(['', '../chat-a', 'chat/a', 'chat-a?start=1', 'chat-a\n', 'A', 'a'.repeat(120)])('never sends a bound selection or call for invalid slug %j', async slug => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(api.history.continue(slug)).rejects.toThrow('Invalid conversation.');
  await expect(api.startCall(crypto.randomUUID(), slug)).rejects.toThrow('Invalid conversation.');
  expect(fetch).not.toHaveBeenCalled();
});