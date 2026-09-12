// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError, invalidateRequests } from '../src/api';
import { savedConversation } from './history';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

it('requests owner-scoped search with safely encoded content and credentials', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ conversations: [savedConversation()] })));
  const signal = new AbortController().signal;
  const search = '₹2,000 & rent/50%_';
  expect((await api.history.list(search, signal)).conversations).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith(`/api/history?${new URLSearchParams({ search })}`, { signal, credentials: 'same-origin' });
});

it('reads saved messages and downloads literal server text rather than financial data', async () => {
  const conversation = savedConversation();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(conversation))).mockResolvedValueOnce(new Response('[2026-09-12T04:45:00Z] Isha\nActual words\n'));
  expect(await api.history.get(conversation.slug)).toEqual(conversation);
  expect(await api.history.transcript(conversation.slug)).toBe('[2026-09-12T04:45:00Z] Isha\nActual words\n');
  expect(vi.mocked(fetch).mock.calls.map(call => call[0])).toEqual([
    `/api/history/${conversation.slug}`, `/api/history/${conversation.slug}/transcript`,
  ]);
});

it.each([null, {}, { conversations: [{}] }, { conversations: [savedConversation(), savedConversation()] },
  { conversations: [{ ...savedConversation(), slug: '../account' }] },
  { conversations: [{ ...savedConversation(), startedAt: 'not-a-date' }] },
])('rejects malformed history lists %j', async value => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(value)));
  await expect(api.history.list()).rejects.toThrow('History could not be read safely.');
});

it.each([
  { messages: [] }, { messageCount: -1 }, { messages: [{ id: '1', role: 'tool', text: 'private' }] },
  { messages: [{ ...savedConversation().messages[0], role: 'system' }], messageCount: 1 },
  { messages: [{ ...savedConversation().messages[0], createdAt: 'not-a-date' }], messageCount: 1 },
  { messages: [savedConversation().messages[0], savedConversation().messages[0]], messageCount: 2 },
])('rejects invalid or non-conversation message content %j', async patch => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...savedConversation(), ...patch })));
  await expect(api.history.get(savedConversation().slug)).rejects.toThrow('The conversation could not be read safely.');
});

it('reports lost authentication for history and keeps raw error content out of UI state', async () => {
  const listener = vi.fn(); window.addEventListener('auth:loss', listener);
  try {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: 'unauthenticated', message: 'Sign in' }), { status: 401 }));
    await expect(api.history.list()).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('auth:loss', listener); }
});

it('rejects a prior-account transcript even when its HTTP response succeeds', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValue(new Promise(done => { resolve = done; }));
  const pending = api.history.transcript(savedConversation().slug);
  invalidateRequests(); resolve(new Response('Prior user words'));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});