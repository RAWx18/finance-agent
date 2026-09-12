// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { History } from '../src/History';
import { api, ApiError, invalidateRequests } from '../src/api';
import type { SavedConversation } from '../src/api';
import { isHistoryRoute } from '../src/historyRoutes';
import { returnPath } from '../src/Login';
import { savedConversation } from './history';
import { settings } from './fixtures';

function show(path = '/history', revision = '', assistantName = settings.assistantName) {
  const router = createMemoryRouter([{ path: '*', element: <History timezone="Asia/Kolkata" assistantName={assistantName} revision={revision} /> }], { initialEntries: [path] });
  return { ...render(<RouterProvider router={router} />), router };
}

beforeEach(() => {
  vi.spyOn(api.history, 'list').mockResolvedValue({ conversations: [savedConversation()] });
  vi.spyOn(api.history, 'get').mockImplementation(async slug => savedConversation(slug));
  vi.spyOn(api.history, 'transcript').mockResolvedValue('[2026-09-12T04:45:00Z] Isha\nActual stored words\n');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});

describe('persisted conversation presentation', () => {
  it('uses the configured name for call links, avatar, heading and saved speaker labels without rewriting words', async () => {
    const { container, router } = show('/history', '', 'Maya');
    expect(screen.getByRole('heading', { name: 'Your conversations with Maya' })).toBeVisible();
    expect(container.querySelector('.history-avatar')).toHaveTextContent('M');
    expect(screen.getAllByRole('link', { name: 'Talk to Maya' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Talk to Maya' })[0]).toHaveAttribute('title', 'Talk to Maya');
    await act(async () => router.navigate(`/history/${savedConversation().slug}`));
    expect(await screen.findAllByRole('article', { name: 'Maya at 10:15' })).toHaveLength(2);
    expect(screen.getByText(/Maya & you/)).toBeVisible();
    expect(screen.getAllByText('Maya')).toHaveLength(2);
    expect(screen.getAllByText('You')).toHaveLength(2);
    expect(screen.getByText(savedConversation().messages[0].text)).toBeVisible();
  });

  it('refreshes the captured list date on focus across local midnight', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-12T18:29:00Z'));
    show();
    const link = await screen.findByRole('link', { name: /Can I cover rent before payday/ });
    expect(link).toHaveTextContent('10:15');
    now.mockReturnValue(Date.parse('2026-09-12T18:31:00Z'));
    await act(async () => { fireEvent.focus(window); });
    expect(api.history.list).toHaveBeenCalledTimes(2);
    expect(link).toHaveTextContent('12 Sept');
  });

  it('uses a concise empty state and never creates a call or fills missing dialogue', async () => {
    vi.mocked(api.history.list).mockResolvedValue({ conversations: [] });
    show();
    expect(screen.getByRole('status')).toHaveTextContent('Loading conversations');
    await screen.findByText('No conversations yet.');
    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toBeEnabled();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(api.history.get).not.toHaveBeenCalled();
    expect(screen.queryByText(/Captions from this visit|Reloading clears|Conversation transcript/)).not.toBeInTheDocument();
  });

  it('opens the real selected chat with both speakers, timestamps and official elements, without a composer', async () => {
    const conversation = savedConversation();
    const { container } = show(`/history/${conversation.slug}`);
    const viewport = await screen.findByRole('region', { name: 'Conversation messages' });
    const articles = within(viewport).getAllByRole('article');
    expect(articles).toHaveLength(4);
    expect(articles.map(item => item.querySelector('.aui-message-text')!.textContent)).toEqual(conversation.messages.map(message => message.text));
    expect(articles.map(item => item.getAttribute('data-role'))).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(within(viewport).getAllByText('Isha')).toHaveLength(2);
    expect(within(viewport).getAllByText('You')).toHaveLength(2);
    expect(articles[0].querySelector('time')).toHaveAttribute('datetime', conversation.messages[0].createdAt);
    expect(articles[0]).toHaveAccessibleName('Isha at 10:15');
    expect(screen.getByText('12 September 2026')).toBeVisible();
    expect(container.querySelector('[data-slot="thread-list"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="day-separator"]')).not.toBeNull();
    expect(container.querySelector('textarea, [contenteditable="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Send|Regenerate|Edit/ })).not.toBeInTheDocument();
    expect(viewport).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('link', { name: /Can I cover rent before payday/ })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps same-title sessions separate and switches using readable browser routes', async () => {
    const first = savedConversation();
    const second = savedConversation('conversation-2026-09-12-102000');
    second.messages = [{ ...second.messages[1], text: 'Only in the second conversation' }]; second.messageCount = 1;
    vi.mocked(api.history.list).mockResolvedValue({ conversations: [second, first] });
    vi.mocked(api.history.get).mockImplementation(async slug => slug === second.slug ? second : first);
    const { router } = show();
    const links = await screen.findAllByRole('link', { name: /Can I cover rent before payday/ });
    expect(links).toHaveLength(2);
    await userEvent.click(links[0]);
    await screen.findByText('Only in the second conversation');
    expect(router.state.location.pathname).toBe(`/history/${second.slug}`);
    await userEvent.click(links[1]);
    await screen.findByText(first.messages[0].text);
    expect(screen.queryByText('Only in the second conversation')).not.toBeInTheDocument();
    await act(async () => router.navigate(-1));
    await screen.findByText('Only in the second conversation');
  });

  it('does not merge adjacent assistant captions or render stored markup as HTML', async () => {
    const conversation = savedConversation();
    conversation.messages = [conversation.messages[0], { ...conversation.messages[2], text: '<script>not executable</script>\nAnother line', interrupted: true }];
    conversation.messageCount = 2;
    vi.mocked(api.history.get).mockResolvedValue(conversation);
    const { container } = show(`/history/${conversation.slug}`);
    await screen.findByText(/not executable/);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('Partial caption')).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByText('You')).not.toBeInTheDocument();
  });

  it('keeps a saved empty call truthful without inventing an assistant welcome', async () => {
    const conversation = { ...savedConversation(), messages: [], messageCount: 0 };
    vi.mocked(api.history.get).mockResolvedValue(conversation);
    show(`/history/${conversation.slug}`);
    await screen.findByText('No captions saved');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download captions' })).not.toBeInTheDocument();
  });

  it('keeps search in the sidebar and does not change the selected conversation', async () => {
    const conversation = savedConversation();
    vi.mocked(api.history.list).mockImplementation(async query => ({ conversations: query === 'not there' ? [] : [conversation] }));
    const { router } = show(`/history/${conversation.slug}`);
    await screen.findByRole('region', { name: 'Conversation messages' });
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'not there' } });
    await screen.findByText('No matching conversations.');
    expect(router.state.location.pathname).toBe(`/history/${conversation.slug}`);
    expect(screen.getAllByRole('article')).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await screen.findByRole('link', { name: /Can I cover rent before payday/ });
    expect(search).toHaveValue('');
    expect(api.history.get).toHaveBeenCalledOnce();
  });

  it('aborts superseded searches and ignores delayed list results', async () => {
    let resolve!: (value: { conversations: SavedConversation[] }) => void;
    vi.mocked(api.history.list).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue({ conversations: [] });
    show();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'groceries' } });
    await screen.findByText('No matching conversations.');
    expect(vi.mocked(api.history.list).mock.calls[0][1]!.aborted).toBe(true);
    await act(async () => resolve({ conversations: [savedConversation()] }));
    expect(screen.queryByRole('link', { name: /Can I cover rent before payday/ })).not.toBeInTheDocument();
  });

  it('handles unavailable list and conversation independently and retries safely', async () => {
    vi.mocked(api.history.list).mockRejectedValueOnce(new Error('private database detail'));
    vi.mocked(api.history.get).mockRejectedValueOnce(new Error('private provider detail'));
    show(`/history/${savedConversation().slug}`);
    await screen.findByText('Couldn’t load history.');
    await screen.findByText('Couldn’t open this conversation');
    expect(screen.queryByText(/private .* detail/)).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Saved conversations' })).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: /Can I cover rent before payday/ });
    await screen.findByRole('region', { name: 'Conversation messages' });
  });

  it.each([404, 410])('shows missing or expired conversations without replacing the sidebar: %s', async status => {
    vi.mocked(api.history.get).mockRejectedValue(new ApiError(status, { code: 'notFound', message: 'internal identifier' }));
    show('/history/deleted-conversation');
    await screen.findByText('Conversation unavailable');
    expect(screen.getByRole('link', { name: /Can I cover rent before payday/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Download captions' })).not.toBeInTheDocument();
    expect(screen.queryByText('internal identifier')).not.toBeInTheDocument();
  });

  it('retries the selected unavailable chat without resetting the list or navigation', async () => {
    vi.mocked(api.history.get).mockRejectedValueOnce(new TypeError('network'));
    const conversation = savedConversation();
    const { router } = show(`/history/${conversation.slug}`);
    await screen.findByText('Couldn’t open this conversation');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('region', { name: 'Conversation messages' });
    expect(api.history.get).toHaveBeenCalledTimes(2);
    expect(api.history.list).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe(`/history/${conversation.slug}`);
  });

  it('ignores a delayed previous conversation response after switching', async () => {
    let resolve!: (value: SavedConversation) => void;
    vi.mocked(api.history.get).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { router } = show('/history/first-conversation');
    expect(screen.getByText('Loading conversation…')).toBeVisible();
    await act(async () => router.navigate('/history/second-conversation'));
    await screen.findByRole('region', { name: 'Conversation messages' });
    const prior = savedConversation('first-conversation'); prior.messages[0].text = 'Stale private response';
    await act(async () => resolve(prior));
    expect(screen.queryByText('Stale private response')).not.toBeInTheDocument();
    expect(vi.mocked(api.history.get).mock.calls[0][1]!.aborted).toBe(true);
  });

  it('expires visible captions instead of leaving stale private text available', async () => {
    const conversation = savedConversation();
    conversation.expiresAt = new Date(Date.now() + 100).toISOString();
    vi.mocked(api.history.get).mockResolvedValue(conversation);
    show(`/history/${conversation.slug}`);
    await screen.findByRole('region', { name: 'Conversation messages' });
    await screen.findByText('Conversation unavailable');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});

describe('actual transcript downloads', () => {
  it('downloads server text once, without financial exports or a second message renderer', async () => {
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:captions');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let resolve!: (text: string) => void;
    vi.mocked(api.history.transcript).mockReturnValue(new Promise(done => { resolve = done; }));
    const conversation = savedConversation();
    show(`/history/${conversation.slug}`);
    const button = await screen.findByRole('button', { name: 'Download captions' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    const text = '[2026-09-12T04:45:00+00:00] Isha\nOnly actual saved words.\n';
    await act(async () => resolve(text));
    expect(api.history.transcript).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((create.mock.calls[0][0] as Blob).size).toBe(new TextEncoder().encode(text).length);
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0]).toHaveAttribute('download', `${conversation.slug}-captions.txt`);
  });

  it.each(['switch', 'signout'])('does not publish a late download after %s', async reason => {
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:captions');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    let resolve!: (text: string) => void;
    vi.mocked(api.history.transcript).mockReturnValue(new Promise(done => { resolve = done; }));
    const { router } = show(`/history/${savedConversation().slug}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Download captions' }));
    if (reason === 'switch') await act(async () => router.navigate('/history/another-conversation'));
    else invalidateRequests();
    await act(async () => resolve('Prior session private words'));
    expect(create).not.toHaveBeenCalled();
  });

  it('offers download retry without leaking internal failures', async () => {
    vi.mocked(api.history.transcript).mockRejectedValue(new Error('private provider detail'));
    show(`/history/${savedConversation().slug}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Download captions' }));
    await screen.findByText('Couldn’t download captions. Please try again.');
    expect(screen.getByRole('button', { name: 'Download captions' })).toBeEnabled();
    expect(screen.queryByText('private provider detail')).not.toBeInTheDocument();
  });
});

describe('safe readable History routes', () => {
  it.each(['/history', '/history/conversation-2026-09-12-101500', '/history/conversation-2026-09-12-101500-2'])('preserves %s through login', path => {
    expect(isHistoryRoute(path)).toBe(true); expect(returnPath(path)).toBe(path);
  });
  it.each(['/history/', '/history/a\n', '/history/a?x=y', '/history/a#x', '/history/../account', '/history/x/y', '/history/a--b', '/history/UPPER', '/history/a\\b', '//evil.test/history/a', '/history/' + 'a'.repeat(120)])('rejects unsafe history path %s', path => {
    expect(isHistoryRoute(path)).toBe(false); expect(returnPath(path)).toBe('/app');
  });
});