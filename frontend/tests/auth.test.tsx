// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, reportAuthLoss } from '../src/api';
import type { AuthSession, Snapshot } from '../src/api';
import { appRouter, authSession, mockAuth } from './appSupport';
import { planningSnapshot, settings, Stream } from './fixtures';
import { projectWorkspace } from './workspace';
import { moneyRoutes } from '../src/moneyRoutes';

/** Exposes promise settlement controls for authentication and request-race tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Models a BroadcastChannel so tests can inject cross-tab account messages. */
class Channel {
  static instances: Channel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  /** Registers the channel instance for test-driven cross-tab events. */
  constructor() { Channel.instances.push(this); }
  /** Delivers a synthetic broadcast payload to the installed message handler. */
  emit(value: unknown) { this.onmessage?.(new MessageEvent('message', { data: value })); }
}

/** Renders an app route, optionally under StrictMode, and exposes its memory router. */
function show(path = '/app', strict = false) {
  const router = appRouter(path);
  const view = render(strict ? <StrictMode><RouterProvider router={router} /></StrictMode> : <RouterProvider router={router} />);
  return { ...view, router };
}

const unauthenticated = () => new ApiError(401, { code: 'unauthenticated', message: 'private auth diagnostic' });

beforeEach(() => {
  mockAuth();
  Channel.instances = []; Stream.instances = [];
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('EventSource', Stream);
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'current').mockResolvedValue(planningSnapshot());
  vi.spyOn(api, 'start').mockResolvedValue(planningSnapshot());
  vi.spyOn(api, 'startCall').mockRejectedValue(new Error('Voice must not start'));
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', cleanupConfirmed: true, message: null });
  vi.spyOn(api, 'save').mockResolvedValue(planningSnapshot());
  vi.spyOn(api.account, 'update').mockImplementation(async displayName => ({ ...authSession().user, displayName }));
  vi.spyOn(api.account, 'delete').mockResolvedValue({ deleted: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network')));
});

describe('authentication boundary and routes', () => {
  it('keeps a verified account usable when Google does not supply a profile name', async () => {
    const session = authSession();
    session.user.googleName = '';
    vi.mocked(api.auth.session).mockRestore();
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(session)));
    show('/account');
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByText('Google name')).not.toBeInTheDocument();
    expect(screen.queryByText('Not provided by Google')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue(session.user.displayName);
    expect(screen.getByText(session.user.email)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete app account' })).toBeEnabled();
  });

  it.each(['/app', ...Object.keys(moneyRoutes), '/account', '/history'])('redirects an already signed-in login visit to %s', async returnTo => {
    const { router } = show(`/login?returnTo=${returnTo}`);
    await waitFor(() => expect(router.state.location.pathname).toBe(returnTo));
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
    expect(api.auth.login).not.toHaveBeenCalled();
  });

  it('keeps a cancelled recent sign-in recoverable while allowing the existing account to continue', async () => {
    const { router } = show('/login?error=cancelled&returnTo=/account');
    vi.mocked(api.auth.login).mockRejectedValue(new TypeError('private diagnostic'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(api.auth.login).toHaveBeenCalledWith('/account');
    expect(router.state.location.pathname).toBe('/login');
    await userEvent.click(screen.getByRole('link', { name: 'Continue to your plan' }));
    await screen.findByDisplayValue('Sam');
  });

  it.each([null, {}, { expiresAt: '2099-01-01T00:00:00Z', user: { id: 'user-one' } }])('fails closed before financial reads for malformed sign-in data %j', async value => {
    vi.mocked(api.auth.session).mockRestore();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(value)));
    show('/money');
    await screen.findByRole('heading', { name: 'Your saved plan is safe.', level: 1 });
    expect(api.current).not.toHaveBeenCalled(); expect(api.settings).not.toHaveBeenCalled();
    expect(Stream.instances).toHaveLength(0);
  });

  it('restores auth before every financial read without creating a plan or microphone session', async () => {
    const pending = deferred<AuthSession>();
    vi.mocked(api.auth.session).mockReturnValue(pending.promise);
    show('/money', true);
    expect(screen.getByRole('heading', { name: 'Opening your plan…' })).toBeVisible();
    expect(api.settings).not.toHaveBeenCalled(); expect(api.current).not.toHaveBeenCalled(); expect(api.call).not.toHaveBeenCalled();
    await act(async () => pending.resolve(authSession()));
    await screen.findByRole('region', { name: 'Money' });
    await waitFor(() => expect(api.current).toHaveBeenCalled());
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(api.auth.session).toHaveBeenCalledBefore(vi.mocked(api.settings));
    expect(screen.queryByRole('dialog', { name: /Correct cash/ })).not.toBeInTheDocument();
  });

  it.each(['/app', ...Object.keys(moneyRoutes), '/account', '/history', '/'])('gates an unauthorized deep link %s with a safe return path', async path => {
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    const { router } = show(path);
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe([...Object.keys(moneyRoutes), '/account', '/history'].includes(path) ? `?returnTo=${path}` : '');
    expect(api.settings).not.toHaveBeenCalled(); expect(api.current).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
    expect(screen.queryByText(/private auth/)).not.toBeInTheDocument();
  });

  it('redirects the signed-in root and protects corrections, dates and browser history in one financial session', async () => {
    const { router } = show('/');
    const ready = await screen.findByRole('link', { name: 'Money' });
    await waitFor(() => expect(api.call).toHaveBeenCalledOnce());
    await waitFor(() => expect(ready).not.toHaveAttribute('aria-disabled', 'true'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app'));
    await userEvent.click(ready);
    const money = await screen.findByRole('region', { name: 'Money' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/money'));
    await waitFor(() => expect(within(money).getByRole('heading', { level: 1 })).toHaveFocus());
    expect(money).toHaveTextContent('11 Sept 2026 – 10 Oct 2026');
    expect(money).toHaveTextContent('Cash at plan start');
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0].emit('snapshot', planningSnapshot()));
    await userEvent.click(within(money).getByRole('button', { name: 'Correct starting cash' }));
    const correction = screen.getByRole('dialog', { name: /Correct cash on/ });
    const cash = within(correction).getByRole('textbox', { name: 'Amount (₹)' });
    await userEvent.clear(cash); await userEvent.type(cash, '777');
    await act(async () => router.navigate('/account'));
    expect(router.state.location.pathname).toBe('/money');
    expect(screen.getByRole('status', { name: 'Finish your correction' })).toHaveTextContent('Save or discard the correction before leaving Money.');
    expect(cash).toBeVisible(); expect(cash).toHaveValue('777');
    expect(ready).toHaveAccessibleDescription('Unsaved corrections');
    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/money');
    expect(cash).toHaveValue('777');
    await userEvent.click(within(correction).getByRole('button', { name: /Close correct cash/ }));
    await userEvent.click(within(correction).getByRole('button', { name: 'Discard correction' }));
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings' });
    await act(async () => router.navigate(-1));
    expect(money).toBeVisible();
    expect(within(money).getByRole('region', { name: 'Money in this plan' })).toHaveTextContent('₹5,000');
    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/app');
    expect(screen.getByRole('link', { name: 'Money' })).toBe(ready);
    expect(ready).toBeVisible();
    expect(ready).not.toHaveAccessibleDescription();
    await act(async () => router.navigate(1));
    expect(money).toBeVisible(); expect(api.current).toHaveBeenCalledTimes(1); expect(api.start).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'failed', 'expired', 'unavailable'])('offers nonterminal recovery for callback error %s', async error => {
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    vi.mocked(api.auth.login).mockRejectedValue(new TypeError('private diagnostic'));
    const { router } = show(`/login?error=${error}&returnTo=/account`);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    const notices = within(screen.getByRole('complementary', { name: 'Notifications' }));
    expect(notices.getByRole(error === 'cancelled' ? 'status' : 'alert')).toBeVisible();
    if (error === 'cancelled') expect(notices.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(api.auth.login).toHaveBeenCalledExactlyOnceWith('/account');
    expect(router.state.location.search).toBe('?returnTo=/account');
    const recovery = screen.getByRole('region', { name: 'Let’s try signing in again.' });
    expect(within(recovery).getByRole('button', { name: 'Retry sign in' })).toBeEnabled();
    expect(recovery).not.toHaveTextContent('private diagnostic');
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it.each(['https://other.example/account', '//other.example', '/app?email=private@example.com', '/figures'])('rejects an unapproved return target %s', async returnTo => {
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    vi.mocked(api.auth.login).mockRejectedValue(new TypeError());
    const { router } = show(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(api.auth.login).toHaveBeenCalledWith('/app');
    expect(router.state.location.search).toBe('');
  });

  it('explains unavailable Google setup without exposing configuration names or alternative login methods', async () => {
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    vi.mocked(api.auth.settings).mockResolvedValue({ googleAvailable: false, sessionHours: 168 });
    show('/login');
    await screen.findByText(/Sign-in is not available yet/);
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/CLIENT_SECRET|ENCRYPTION|API_KEY/)).not.toBeInTheDocument();
    vi.mocked(api.auth.settings).mockResolvedValue({ googleAvailable: true, sessionHours: 168 });
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
  });

  it('keeps an auth outage distinct from anonymous and retries before exposing any cached financial content', async () => {
    vi.mocked(api.auth.session).mockRejectedValueOnce(new ApiError(503, { code: 'authUnavailable', message: 'private provider failure' }));
    show('/money');
    await screen.findByRole('heading', { name: 'Your saved plan is safe.', level: 1 });
    expect(api.settings).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
    const recovery = screen.getByRole('region', { name: 'Your saved plan is safe.' });
    expect(recovery).toHaveTextContent('Retry to see your figures.');
    expect(recovery).not.toHaveClass('card');
    expect(within(recovery).getByRole('button', { name: 'Sign out' })).toHaveClass('quiet');
    expect(screen.getAllByRole('button', { name: 'Retry connection' })).toHaveLength(1);
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(screen.queryByText(/private provider failure|connection restored|sign-in connection/i)).not.toBeInTheDocument();
    await userEvent.click(within(recovery).getByRole('button', { name: 'Retry connection' }));
    await screen.findByRole('region', { name: 'Money' });
    expect(api.auth.session).toHaveBeenCalledTimes(2);
  });

  it('keeps the recovery view in place during a retry and after another failure', async () => {
    const pending = deferred<AuthSession>();
    vi.mocked(api.auth.session).mockRejectedValueOnce(new TypeError('private network')).mockReturnValueOnce(pending.promise);
    show('/money');
    const heading = await screen.findByRole('heading', { name: 'Your saved plan is safe.' });
    expect(heading).toHaveFocus();
    const recovery = screen.getByRole('region', { name: 'Your saved plan is safe.' });
    const retry = within(recovery).getByRole('button', { name: 'Retry connection' });
    await userEvent.click(retry);
    expect(recovery).toHaveAttribute('aria-busy', 'true');
    expect(within(recovery).getByRole('button', { name: 'Trying again…' })).toBe(retry);
    expect(retry).toBeDisabled();
    expect(heading).toBeVisible();
    await userEvent.click(retry);
    expect(api.auth.session).toHaveBeenCalledTimes(2);
    expect(api.current).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled();
    await act(async () => pending.reject(new TypeError('private network')));
    expect(recovery).toHaveAttribute('aria-busy', 'false');
    expect(within(recovery).getByRole('button', { name: 'Retry connection' })).toBe(retry);
    expect(retry).toBeEnabled();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
    await userEvent.click(retry);
    await screen.findByRole('region', { name: 'Money' });
    expect(api.auth.session).toHaveBeenCalledTimes(3);
    expect(api.start).not.toHaveBeenCalled();
  });

  it('replaces an outage with sign-in only after the server confirms the login has ended', async () => {
    vi.mocked(api.auth.session).mockRejectedValueOnce(new TypeError('private network')).mockRejectedValueOnce(unauthenticated());
    show('/money');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry connection' }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(screen.getByText('Please sign in again to continue.')).toBeVisible();
    expect(screen.queryByText(/lost the connection|Retry to see your figures/)).not.toBeInTheDocument();
    expect(api.current).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled();
  });

  it('keeps a failed sign-in availability check beside its retry and does not open Google automatically', async () => {
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    vi.mocked(api.auth.settings).mockRejectedValueOnce(new TypeError('private network'));
    show('/login');
    const recovery = await screen.findByRole('region', { name: 'Let’s get you connected.' });
    expect(within(recovery).getByRole('button', { name: 'Retry connection' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
    await userEvent.click(within(recovery).getByRole('button', { name: 'Retry connection' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    expect(api.auth.settings).toHaveBeenCalledTimes(2);
    expect(api.auth.login).not.toHaveBeenCalled();
  });
});

describe('profile menu', () => {
  it('keeps identity and account actions behind the icon beside primary navigation', async () => {
    const session = authSession();
    session.user.displayName = 'Samira Patel';
    session.user.email = 'samira@example.com';
    vi.mocked(api.auth.session).mockResolvedValue(session);
    show();
    const trigger = await screen.findByRole('button', { name: 'Profile menu' });
    expect(trigger).toHaveAttribute('title', 'Profile menu');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('');
    expect(screen.getByRole('link', { name: 'Cash flow home' })).toBeVisible();
    expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getAllByRole('link').map(link => link.textContent))
      .toEqual(['Conversation', 'History', 'Money']);
    expect(screen.queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(screen.queryByText(session.user.email)).not.toBeInTheDocument();
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(session.user.displayName)).toBeVisible();
    expect(screen.getByText(session.user.email)).toBeVisible();
    const menu = screen.getByRole('menu', { name: 'Profile' });
    expect(menu).toHaveAttribute('id', trigger.getAttribute('aria-controls'));
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/account');
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' }).tagName).toBe('BUTTON');
    await userEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(api.auth.logout).not.toHaveBeenCalled();
  });

  it.each([['{Enter}', 'Settings'], [' ', 'Settings'], ['{ArrowDown}', 'Settings'], ['{ArrowUp}', 'Sign out']])('opens with %s on %s and roves with arrows, Home and End', async (key, first) => {
      show();
      const trigger = await screen.findByRole('button', { name: 'Profile menu' });
      trigger.focus();
      await userEvent.keyboard(key);
      expect(screen.getByRole('menuitem', { name: first })).toHaveFocus();
      for (const [key, name] of [['{Home}', 'Settings'], ['{ArrowUp}', 'Sign out'], ['{ArrowDown}', 'Settings'],
        ['{End}', 'Sign out'], ['{ArrowUp}', 'Settings'], ['{ArrowDown}', 'Sign out']]) {
        await userEvent.keyboard(key);
        expect(screen.getByRole('menuitem', { name })).toHaveFocus();
      }
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
      expect(api.auth.logout).not.toHaveBeenCalled();
    });

  it.each([false, true])('dismisses on Tab without trapping focus (shift: %s)', async shift => {
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    const trigger = screen.getByRole('button', { name: 'Profile menu' });
    await userEvent.click(trigger);
    await userEvent.tab({ shift });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(shift ? screen.getByRole('link', { name: 'Money' }) : name).toHaveFocus();
  });

  it.each(['pointerdown', 'focusin'])('dismisses on outside %s without restoring trigger focus', async event => {
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    const trigger = screen.getByRole('button', { name: 'Profile menu' });
    await userEvent.click(trigger);
    if (event === 'pointerdown') fireEvent.pointerDown(name);
    else act(() => name.focus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveFocus();
    if (event === 'focusin') expect(name).toHaveFocus();
  });

  it.each(['{Enter}', ' '])('navigates Settings with %s without creating a plan and closes on route changes', async press => {
    const { router } = show();
    await userEvent.click(await screen.findByRole('button', { name: 'Profile menu' }));
    await userEvent.keyboard(press);
    const heading = await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(router.state.location.pathname).toBe('/account');
    expect(heading).toHaveFocus();
    expect(document.title).toBe('Settings · Cash flow');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    const key = router.state.location.key;
    await act(async () => router.navigate('/account'));
    expect(router.state.location.key).not.toBe(key);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await act(async () => router.navigate(-1));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(api.start).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });
});

describe('auth expiry, revalidation and race isolation', () => {
  it.each(['unauthenticated', 'sessionExpired', 'authUnavailable'] as const)('closes SSE and clears financial data on %s', async code => {
    show('/money/spending');
    await screen.findByRole('listitem', { name: 'Rent' });
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    vi.mocked(api.auth.session).mockRejectedValue(new ApiError(code === 'authUnavailable' ? 503 : 401, { code, message: 'private diagnostic' }));
    act(() => Stream.instances[0].emit(code, { code }));
    expect(screen.queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
    expect(Stream.instances[0].closed).toBe(true);
    if (code === 'authUnavailable') await screen.findByRole('heading', { name: 'Your saved plan is safe.', level: 1 });
    else await screen.findByRole('button', { name: 'Continue with Google' });
    expect(api.auth.session).toHaveBeenCalledTimes(2);
  });

  it('checks refresh on focus and blocks on transient errors rather than leaving a private cache usable', async () => {
    show('/money/spending');
    await screen.findByRole('listitem', { name: 'Rent' });
    vi.mocked(api.auth.refresh).mockRejectedValueOnce(new ApiError(503, { code: 'authUnavailable', message: 'private diagnostic' }));
    fireEvent(window, new Event('focus'));
    await screen.findByRole('heading', { name: 'Your saved plan is safe.', level: 1 });
    expect(screen.queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
    await waitFor(() => expect(Stream.instances.every(item => item.closed)).toBe(true));
    await userEvent.click(within(screen.getByRole('region', { name: 'Your saved plan is safe.' })).getByRole('button', { name: 'Retry connection' }));
    await screen.findByRole('listitem', { name: 'Rent' });
    expect(api.current).toHaveBeenCalledTimes(2);
  });

  it('refreshes while visible on the five-minute cadence but never starts voice', async () => {
    show();
    await screen.findByRole('link', { name: 'Money' });
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    await act(async () => { fireEvent(window, new Event('focus')); });
    expect(api.auth.refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
    expect(api.auth.refresh).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(true);
    await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
    expect(api.auth.refresh).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    await act(async () => fireEvent(document, new Event('visibilitychange')));
    expect(api.auth.refresh).toHaveBeenCalledTimes(3);
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
  });

  it('clears identity-owned state before a second user and ignores a late first-user snapshot', async () => {
    const first = deferred<Snapshot>();
    const second = { ...planningSnapshot(), sessionId: 'second-plan' };
    second.facts.records[0].label = 'Second user bill';
    vi.mocked(api.current).mockReturnValueOnce(first.promise).mockResolvedValue(projectWorkspace(second));
    show('/money/spending');
    await waitFor(() => expect(api.current).toHaveBeenCalledTimes(1));
    vi.mocked(api.auth.refresh).mockResolvedValue(authSession('user-two'));
    fireEvent(window, new Event('focus'));
    await screen.findByRole('listitem', { name: 'Second user bill' });
    await act(async () => first.resolve(planningSnapshot()));
    expect(screen.queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Second user bill' })).toBeVisible();
    expect(api.current).toHaveBeenCalledTimes(2);
  });

  it('ignores pending first-user commands after identity changes without replaying them for a second user', async () => {
    const pending = deferred<Snapshot>();
    vi.mocked(api.save).mockReturnValue(pending.promise);
    show('/money');
    await screen.findByRole('region', { name: 'Money in this plan' });
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0].emit('snapshot', planningSnapshot()));
    const edit = screen.getByRole('button', { name: 'Correct starting cash' });
    await waitFor(() => expect(edit).toBeEnabled());
    await userEvent.click(edit);
    const cash = await screen.findByRole('textbox', { name: 'Amount (₹)' });
    await userEvent.clear(cash); await userEvent.type(cash, '111');
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    vi.mocked(api.auth.refresh).mockResolvedValue(authSession('user-two'));
    const second = structuredClone(planningSnapshot()); second.facts.opening.amountPaise = 22200;
    vi.mocked(api.current).mockResolvedValue(projectWorkspace(second));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Correct cash on/ })).not.toBeInTheDocument());
    const late = structuredClone(planningSnapshot()); late.sequence = 5; late.facts.opening.amountPaise = 11100;
    await act(async () => pending.resolve(projectWorkspace(late)));
    expect(screen.getByRole('region', { name: 'Money in this plan' })).toHaveTextContent('₹222');
    expect(screen.getByRole('region', { name: 'Money in this plan' })).not.toHaveTextContent('₹111');
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('treats a cross-tab logout hint only as a reason to recheck the backend', async () => {
    show('/money/spending');
    await screen.findByRole('listitem', { name: 'Rent' });
    const pending = deferred<AuthSession>();
    vi.mocked(api.auth.session).mockReturnValueOnce(pending.promise);
    act(() => Channel.instances[0].emit('logout'));
    expect(screen.queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Opening your plan…' })).toBeVisible();
    await act(async () => pending.resolve(authSession()));
    await screen.findByRole('listitem', { name: 'Rent' });
    expect(api.auth.session).toHaveBeenCalledTimes(2);
    expect(api.current).toHaveBeenCalledTimes(2);
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalled();
  });

  it('clears bfcache-restored data and checks the server before revealing it', async () => {
    show('/account');
    await screen.findByDisplayValue('Sam');
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(screen.queryByDisplayValue('Sam')).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Continue with Google' });
  });
});

describe('account profile and deliberate deletion', () => {
  it('finishes deletion after leaving Settings and navigates directly to the logged-out landing', async () => {
    const pending = deferred<{ deleted: true }>();
    vi.mocked(api.account.delete).mockReturnValue(pending.promise);
    const { router } = show('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete app account' }));
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: 'Permanently delete app account' }));
    await act(async () => router.navigate('/app'));
    await act(async () => pending.resolve({ deleted: true }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('');
    expect(screen.queryByText(/have been deleted/)).not.toBeInTheDocument();
    expect(Channel.instances[0].postMessage).toHaveBeenCalledWith({ type: 'delete', userId: authSession().user.id });
    expect(api.account.delete).toHaveBeenCalledTimes(1);
  });

  it('does not apply or announce a profile result belonging to another user', async () => {
    vi.mocked(api.account.update).mockResolvedValue(authSession('user-two').user);
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    await userEvent.clear(name); await userEvent.type(name, 'Samira');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert', { name: 'Your name could not be saved' });
    expect(name).toHaveValue('Samira');
    expect(screen.getByText('user-one@example.com')).toBeVisible();
    expect(screen.queryByText('Your name is saved.')).not.toBeInTheDocument();
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalled();
  });

  it('keeps Settings minimal and updates menu identity only after a trimmed name save completes', async () => {
    const pending = deferred<AuthSession['user']>();
    vi.mocked(api.account.update).mockReturnValueOnce(pending.promise);
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    expect(name).toHaveValue('Sam');
    expect(screen.getByText('Sam Google')).toBeVisible(); expect(screen.getByText('user-one@example.com')).toBeVisible();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    const region = screen.getByRole('region', { name: 'Settings' });
    expect(within(region).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Settings', 'Account Google']);
    expect(within(region).getByRole('form', { name: 'Display name' })).toBeVisible();
    expect(within(region).getByRole('region', { name: 'Account Google' })).toBeVisible();
    expect(within(region).getByRole('button', { name: 'Delete app account' })).toHaveClass('quiet');
    expect(region.querySelector('.card')).not.toBeInTheDocument();
    for (const paragraph of within(region).queryAllByRole('paragraph'))
      expect(paragraph).not.toHaveTextContent(/Your account|Your profile|kept for|up to 7 days|session|retention|privacy/i);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(screen.getByRole('contentinfo')).getByRole('button', { name: 'Privacy' })).toBeVisible();
    await userEvent.clear(name); await userEvent.type(name, '  Samira  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(name).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    expect(within(screen.getByRole('banner')).getByText('Sam', { exact: true })).toBeVisible();
    await act(async () => pending.resolve({ ...authSession().user, displayName: 'Samira' }));
    await screen.findByText('Your name is saved.');
    expect(name).toHaveValue('Samira'); expect(api.account.update).toHaveBeenCalledExactlyOnceWith('Samira');
    expect(within(screen.getByRole('banner')).getByText('Samira', { exact: true })).toBeVisible();
    expect(within(screen.getByRole('banner')).getByText(authSession().user.email)).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await userEvent.clear(name); await userEvent.type(name, 'Sam');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    expect(within(screen.getByRole('banner')).getByText('Sam', { exact: true })).toBeVisible();
    expect(api.account.update).toHaveBeenLastCalledWith('Sam');
    expect(Channel.instances[0].postMessage).toHaveBeenCalledTimes(2);
    expect(Channel.instances[0].postMessage).toHaveBeenLastCalledWith('profile');
    expect(api.save).not.toHaveBeenCalled();
    expect(api.startCall).not.toHaveBeenCalled();
  });

  it.each(['   ', 'x'.repeat(81), 'Sam\u200b'])('rejects an invalid display name without touching the saved profile', async value => {
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    fireEvent.change(name, { target: { value } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1–80 characters'); expect(api.account.update).not.toHaveBeenCalled();
    expect(name).toHaveValue(value);
  });

  it('retains a failed name edit with a consumer retry and ignores a late response after sign-out', async () => {
    vi.mocked(api.account.update).mockRejectedValueOnce(new TypeError('private network'));
    const pending = deferred<AuthSession['user']>();
    vi.mocked(api.account.update).mockReturnValueOnce(pending.promise);
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    await userEvent.clear(name); await userEvent.type(name, 'Samira');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).not.toHaveTextContent('private network'); expect(name).toHaveValue('Samira');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    await act(async () => pending.resolve({ ...authSession().user, displayName: 'Samira' }));
    expect(screen.queryByDisplayValue('Samira')).not.toBeInTheDocument();
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalledWith('profile');
  });

  it('requires DELETE and explicit app-account wording, then clears all private UI on confirmed deletion', async () => {
    const pending = deferred<{ deleted: true }>();
    vi.mocked(api.account.delete).mockReturnValue(pending.promise);
    show('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete app account' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete your app account?' });
    expect(dialog).toHaveTextContent('irreversibly deletes all your app figures, plan and assumptions');
    expect(dialog).toHaveTextContent('stops any conversation'); expect(dialog).toHaveTextContent('Your Google account will not be deleted.');
    expect(dialog).toHaveTextContent('Signing in again creates a new, empty app account. Deleted data cannot be restored.');
    const remove = within(dialog).getByRole('button', { name: 'Permanently delete app account' });
    expect(remove).toBeDisabled();
    const confirmation = within(dialog).getByRole('textbox', { name: 'Type DELETE to confirm' });
    await userEvent.type(confirmation, 'delete'); expect(remove).toBeDisabled();
    await userEvent.clear(confirmation); await userEvent.type(confirmation, 'DELETE');
    await userEvent.click(remove);
    expect(api.account.delete).toHaveBeenCalledExactlyOnceWith('DELETE');
    expect(screen.getByText('Deleting account…')).toBeVisible();
    expect(screen.queryByText(/have been deleted/)).not.toBeInTheDocument();
    await act(async () => pending.resolve({ deleted: true }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(screen.queryByText('user-one@example.com')).not.toBeInTheDocument();
    expect(Channel.instances[0].postMessage).toHaveBeenCalledWith({ type: 'delete', userId: authSession().user.id });
    expect(Stream.instances.every(item => item.closed)).toBe(true);
  });

  it('cannot restore a deleted account from an in-flight refresh or browser history', async () => {
    const refresh = deferred<AuthSession>();
    vi.mocked(api.auth.refresh).mockReturnValue(refresh.promise);
    const { router } = show('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete app account' }));
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.auth.refresh).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.auth.refresh).mock.calls[0][0]!;
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    await userEvent.click(screen.getByRole('button', { name: 'Permanently delete app account' }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(signal.aborted).toBe(true);
    await act(async () => refresh.resolve(authSession()));
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.queryByRole('button', { name: 'Profile menu' })).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(screen.queryByDisplayValue('Sam')).not.toBeInTheDocument();
    expect(api.auth.login).not.toHaveBeenCalled();
  });

  it('handles committed deletion before the HTTP body without recovery or a Settings return path', async () => {
    const body = deferred<string>();
    vi.mocked(api.account.delete).mockRestore();
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, text: () => body.promise } as Response);
    const { router } = show('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete app account' }));
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: 'Permanently delete app account' }));
    vi.mocked(api.auth.session).mockRejectedValue(new TypeError('Auth check must not run after deletion'));
    act(() => reportAuthLoss('accountDeleted'));
    const signin = await screen.findByRole('button', { name: 'Continue with Google' });
    expect(signin).toBeDisabled();
    expect(router.state.location.pathname).toBe('/login'); expect(router.state.location.search).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your saved plan is safe|Opening your plan|Please sign in again|Your sign-in|have been deleted/)).not.toBeInTheDocument();
    expect(api.auth.session).toHaveBeenCalledTimes(1);
    expect(Stream.instances.every(stream => stream.closed)).toBe(true);
    await act(async () => body.resolve('{"deleted":true}'));
    await waitFor(() => expect(signin).toBeEnabled());
    expect(Channel.instances[0].postMessage).toHaveBeenCalledWith({ type: 'delete', userId: authSession().user.id });
    act(() => reportAuthLoss('unauthenticated'));
    expect(signin).toBeVisible(); expect(api.auth.session).toHaveBeenCalledTimes(1);
  });

  it('does not let a concurrent auth failure discard a successful deletion', async () => {
    const pending = deferred<{ deleted: true }>();
    vi.mocked(api.account.delete).mockReturnValue(pending.promise);
    const { router } = show('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete app account' }));
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: 'Permanently delete app account' }));
    act(() => reportAuthLoss('unauthenticated'));
    expect(api.auth.session).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ deleted: true }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(router.state.location.pathname).toBe('/login'); expect(router.state.location.search).toBe('');
    expect(screen.queryByText(/Your saved plan is safe|Please sign in again|have been deleted/)).not.toBeInTheDocument();
  });

  it('handles another tab deleting this account quietly without signing out a different account', async () => {
    const { router } = show('/account');
    await screen.findByDisplayValue('Sam');
    act(() => Channel.instances[0].emit({ type: 'delete', userId: 'different-user' }));
    expect(screen.getByDisplayValue('Sam')).toBeVisible();
    act(() => Channel.instances[0].emit({ type: 'delete', userId: authSession().user.id }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(router.state.location.pathname).toBe('/login'); expect(router.state.location.search).toBe('');
    expect(api.auth.session).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Your saved plan is safe|Please sign in again|have been deleted/)).not.toBeInTheDocument();
  });

  it('does not retain a revoked login when deletion returns unauthorized', async () => {
    vi.mocked(api.account.delete).mockRejectedValue(unauthenticated());
    const { router } = show('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete app account' }));
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: 'Permanently delete app account' }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(router.state.location.pathname).toBe('/login'); expect(router.state.location.search).toBe('');
    expect(screen.queryByDisplayValue('Sam')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your saved plan is safe|Please sign in again|have been deleted/)).not.toBeInTheDocument();
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalled();
  });

  it('handles requiresSignin without auto-deleting after Google or retaining confirmation', async () => {
    vi.mocked(api.account.delete).mockRejectedValue(new ApiError(428, { code: 'requiresSignin', message: 'private recent sign-in' }));
    vi.mocked(api.auth.login).mockRejectedValue(new TypeError());
    const view = show('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete app account' }));
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: 'Permanently delete app account' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    expect(screen.getByText(/signing in does not delete anything/)).toBeVisible();
    expect(screen.queryByLabelText('Type DELETE to confirm')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(api.auth.login).toHaveBeenCalledWith('/account');
    view.unmount(); show('/account');
    await screen.findByDisplayValue('Sam');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(api.account.delete).toHaveBeenCalledTimes(1);
  });
});

describe('confirmed and uncertain logout', () => {
  it('keeps private data hidden when both logout and its status check fail, then retries sign-out', async () => {
    vi.mocked(api.auth.logout).mockRejectedValueOnce(new TypeError('private network'));
    show('/account'); await screen.findByDisplayValue('Sam');
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Let’s finish signing out.', level: 1 });
    vi.mocked(api.auth.session).mockRejectedValueOnce(new TypeError('private network'));
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Retry connection' }));
    await waitFor(() => expect(api.auth.session).toHaveBeenCalledTimes(2));
    expect(screen.queryByDisplayValue('Sam')).not.toBeInTheDocument();
    expect(screen.queryByText('You’re signed out.')).not.toBeInTheDocument();
    expect(Stream.instances.every(stream => stream.closed)).toBe(true);
    expect(api.current).toHaveBeenCalledTimes(1);
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Retry sign out' }));
    await screen.findByText('You’re signed out.');
    expect(api.auth.logout).toHaveBeenCalledTimes(2);
  });

  it('hides private state and closes streams while logout is pending, without claiming it succeeded', async () => {
    const pending = deferred<void>();
    vi.mocked(api.auth.logout).mockReturnValue(pending.promise);
    show('/money/spending');
    await screen.findByRole('listitem', { name: 'Rent' });
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(screen.getByRole('heading', { name: 'Signing out…' })).toBeVisible();
    expect(screen.queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
    expect(Stream.instances.every(item => item.closed)).toBe(true);
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await screen.findByText('You’re signed out.');
    expect(Channel.instances[0].postMessage).toHaveBeenCalledExactlyOnceWith('logout');
  });

  it('keeps failed-network logout uncertain and hidden, and confirms retry with the server', async () => {
    vi.mocked(api.auth.logout).mockRejectedValueOnce(new TypeError('private network'));
    show('/account'); await screen.findByDisplayValue('Sam');
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Let’s finish signing out.', level: 1 });
    const recovery = screen.getByRole('region', { name: 'Let’s finish signing out.' });
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(recovery).not.toHaveTextContent('private network');
    expect(recovery).toHaveTextContent('Your figures are hidden for now.');
    expect(screen.queryByDisplayValue('Sam')).not.toBeInTheDocument(); expect(screen.queryByText('You’re signed out.')).not.toBeInTheDocument();
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Retry sign out' }));
    await screen.findByText('You’re signed out.'); expect(api.auth.logout).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('checks the backend after a lost logout response (session survives: %s)', async survives => {
    vi.mocked(api.auth.logout).mockRejectedValueOnce(new TypeError());
    show('/account'); await screen.findByDisplayValue('Sam');
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Let’s finish signing out.', level: 1 });
    if (!survives) vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Retry connection' }));
    if (survives) await screen.findByDisplayValue('Sam'); else await screen.findByText('You’re signed out.');
    expect(api.auth.session).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale refresh so it cannot undo an explicit sign-out', async () => {
    const pending = deferred<AuthSession>();
    vi.mocked(api.auth.refresh).mockReturnValue(pending.promise);
    show('/money/spending'); await screen.findByRole('listitem', { name: 'Rent' });
    fireEvent(window, new Event('focus'));
    await userEvent.click(screen.getByRole('button', { name: 'Profile menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByText('You’re signed out.');
    await act(async () => pending.resolve(authSession()));
    expect(screen.queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
    act(() => reportAuthLoss('unauthenticated'));
    await waitFor(() => expect(api.auth.session).toHaveBeenCalledTimes(2));
  });
});