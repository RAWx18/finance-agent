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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Channel {
  static instances: Channel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor() { Channel.instances.push(this); }
  emit(value: unknown) { this.onmessage?.(new MessageEvent('message', { data: value })); }
}

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
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(api, 'save').mockResolvedValue(planningSnapshot());
  vi.spyOn(api.account, 'update').mockImplementation(async displayName => ({ ...authSession().user, displayName }));
  vi.spyOn(api.account, 'delete').mockResolvedValue({ deleted: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network')));
});

describe('authentication boundary and routes', () => {
  it('restores auth before every financial read without creating a plan or microphone session', async () => {
    const pending = deferred<AuthSession>();
    vi.mocked(api.auth.session).mockReturnValue(pending.promise);
    show('/figures', true);
    expect(screen.getByRole('heading', { name: 'Checking your sign-in…' })).toBeVisible();
    expect(api.settings).not.toHaveBeenCalled(); expect(api.current).not.toHaveBeenCalled(); expect(api.call).not.toHaveBeenCalled();
    await act(async () => pending.resolve(authSession()));
    await screen.findByRole('region', { name: 'Your figures' });
    await waitFor(() => expect(api.current).toHaveBeenCalled());
    expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
    expect(api.auth.session).toHaveBeenCalledBefore(vi.mocked(api.settings));
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
  });

  it.each(['/app', '/figures', '/account', '/'])('gates an unauthorized deep link %s with a safe return path', async path => {
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    const { router } = show(path);
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe(path === '/figures' || path === '/account' ? `?returnTo=${path}` : '');
    expect(api.settings).not.toHaveBeenCalled(); expect(api.current).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
    expect(screen.queryByText(/private auth/)).not.toBeInTheDocument();
  });

  it('redirects the signed-in root and keeps figures, drafts, dates and browser history in one financial session', async () => {
    const { router } = show('/');
    await screen.findByRole('button', { name: 'Your figures' });
    expect(router.state.location.pathname).toBe('/app');
    await userEvent.click(screen.getByRole('link', { name: 'Your figures' }));
    const figures = screen.getByRole('region', { name: 'Your figures' });
    expect(router.state.location.pathname).toBe('/figures');
    expect(within(figures).getByRole('heading', { level: 1 })).toHaveFocus();
    expect(figures).toHaveTextContent('11 Sept 2026 – 10 Oct 2026');
    expect(figures).toHaveTextContent('Starting figures from');
    await userEvent.click(within(figures).getByRole('button', { name: 'Edit figures' }));
    const cash = within(figures).getByLabelText('Available cash (₹)');
    await userEvent.clear(cash); await userEvent.type(cash, '777');
    await userEvent.click(screen.getByRole('link', { name: 'Account' }));
    await screen.findByRole('heading', { name: 'Your account' });
    await act(async () => router.navigate(-1));
    expect(cash).toBeVisible(); expect(cash).toHaveValue('777');
    await act(async () => router.navigate(-1));
    expect(screen.getByRole('button', { name: 'Review your draft' })).toBeVisible();
    await act(async () => router.navigate(1));
    expect(cash).toBeVisible(); expect(api.current).toHaveBeenCalledTimes(1); expect(api.start).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'failed', 'expired', 'unavailable'])('offers nonterminal recovery for callback error %s', async error => {
    vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    vi.mocked(api.auth.login).mockRejectedValue(new TypeError('private diagnostic'));
    const { router } = show(`/login?error=${error}&returnTo=/account`);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    expect(screen.getByRole('alert')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(api.auth.login).toHaveBeenCalledExactlyOnceWith('/account');
    expect(router.state.location.search).toBe('?returnTo=/account');
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    expect(screen.getByRole('alert')).not.toHaveTextContent('private diagnostic');
  });

  it.each(['https://other.example/account', '//other.example', '/app?email=private@example.com'])('rejects an unapproved return target %s', async returnTo => {
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
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
  });

  it('keeps an auth outage distinct from anonymous and retries before exposing any cached financial content', async () => {
    vi.mocked(api.auth.session).mockRejectedValueOnce(new ApiError(503, { code: 'authUnavailable', message: 'private provider failure' }));
    show('/figures');
    await screen.findByRole('heading', { name: 'Sign-in connection unavailable' });
    expect(api.settings).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByRole('region', { name: 'Your figures' });
    expect(api.auth.session).toHaveBeenCalledTimes(2);
  });
});

describe('auth expiry, revalidation and race isolation', () => {
  it.each(['unauthenticated', 'sessionExpired', 'authUnavailable'] as const)('closes SSE and clears financial data on %s', async code => {
    show('/figures');
    await screen.findByText('Rent', { selector: '.saved-items h3' });
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    vi.mocked(api.auth.session).mockRejectedValue(new ApiError(code === 'authUnavailable' ? 503 : 401, { code, message: 'private diagnostic' }));
    act(() => Stream.instances[0].emit(code, { code }));
    expect(screen.queryByText('Rent', { selector: '.saved-items h3' })).not.toBeInTheDocument();
    expect(Stream.instances[0].closed).toBe(true);
    if (code === 'authUnavailable') await screen.findByRole('heading', { name: 'Sign-in connection unavailable' });
    else await screen.findByRole('button', { name: 'Continue with Google' });
    expect(api.auth.session).toHaveBeenCalledTimes(2);
  });

  it('checks refresh on focus and blocks on transient errors rather than leaving a private cache usable', async () => {
    show('/figures');
    await screen.findByText('Rent', { selector: '.saved-items h3' });
    vi.mocked(api.auth.refresh).mockRejectedValueOnce(new ApiError(503, { code: 'authUnavailable', message: 'private diagnostic' }));
    fireEvent(window, new Event('focus'));
    await screen.findByRole('heading', { name: 'Sign-in connection unavailable' });
    expect(screen.queryByText('Rent', { selector: '.saved-items h3' })).not.toBeInTheDocument();
    expect(Stream.instances.every(item => item.closed)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByText('Rent', { selector: '.saved-items h3' });
    expect(api.current).toHaveBeenCalledTimes(2);
  });

  it('refreshes while visible on the five-minute cadence but never starts voice', async () => {
    show();
    await screen.findByRole('button', { name: 'Your figures' });
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
    vi.mocked(api.current).mockReturnValueOnce(first.promise).mockResolvedValue(second);
    show('/figures');
    await waitFor(() => expect(api.current).toHaveBeenCalledTimes(1));
    vi.mocked(api.auth.refresh).mockResolvedValue(authSession('user-two'));
    fireEvent(window, new Event('focus'));
    await screen.findByText('Second user bill', { selector: '.saved-items h3' });
    await act(async () => first.resolve(planningSnapshot()));
    expect(screen.queryByText('Rent', { selector: '.saved-items h3' })).not.toBeInTheDocument();
    expect(screen.getByText('Second user bill', { selector: '.saved-items h3' })).toBeVisible();
    expect(api.current).toHaveBeenCalledTimes(2);
  });

  it('ignores pending first-user commands after identity changes without replaying them for a second user', async () => {
    const pending = deferred<Snapshot>();
    vi.mocked(api.save).mockReturnValue(pending.promise);
    show('/figures');
    await screen.findByText('Rent', { selector: '.saved-items h3' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit figures' }));
    const cash = screen.getByLabelText('Available cash (₹)');
    await userEvent.clear(cash); await userEvent.type(cash, '111');
    await userEvent.click(screen.getByRole('button', { name: 'Save figures' }));
    vi.mocked(api.auth.refresh).mockResolvedValue(authSession('user-two'));
    const second = structuredClone(planningSnapshot()); second.facts.opening.amountPaise = 22200;
    vi.mocked(api.current).mockResolvedValue(second);
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByLabelText('Available cash (₹)')).not.toBeInTheDocument());
    const late = structuredClone(planningSnapshot()); late.sequence = 5; late.facts.opening.amountPaise = 11100;
    await act(async () => pending.resolve(late));
    expect(screen.getByText('Available cash', { selector: 'dt' }).parentElement).toHaveTextContent('₹222.00');
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('treats a cross-tab logout hint only as a reason to recheck the backend', async () => {
    show('/figures');
    await screen.findByText('Rent', { selector: '.saved-items h3' });
    const pending = deferred<AuthSession>();
    vi.mocked(api.auth.session).mockReturnValueOnce(pending.promise);
    act(() => Channel.instances[0].emit('logout'));
    expect(screen.queryByText('Rent', { selector: '.saved-items h3' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Checking your sign-in…' })).toBeVisible();
    await act(async () => pending.resolve(authSession()));
    await screen.findByText('Rent', { selector: '.saved-items h3' });
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
  it('shows the display name with readonly Google identity and independent retention, then saves a trimmed name', async () => {
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    expect(name).toHaveValue('Sam');
    expect(screen.getByText('Sam Google')).toBeVisible(); expect(screen.getByText('user-one@example.com')).toBeVisible();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    await screen.findByText(/kept for 24 hours/); expect(screen.getByText(/up to 7 days/)).toBeVisible();
    await userEvent.clear(name); await userEvent.type(name, '  Samira  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByText('Your name is saved.');
    expect(name).toHaveValue('Samira'); expect(api.account.update).toHaveBeenCalledExactlyOnceWith('Samira');
    expect(Channel.instances[0].postMessage).toHaveBeenCalledExactlyOnceWith('profile');
    expect(api.save).not.toHaveBeenCalled();
  });

  it.each(['   ', 'x'.repeat(81), 'Sam\u200b'])('rejects an invalid display name without touching the saved profile', async value => {
    show('/account');
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    fireEvent.change(name, { target: { value } });
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByRole('alert')).not.toHaveTextContent('private network'); expect(name).toHaveValue('Samira');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
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
    expect(Channel.instances[0].postMessage).toHaveBeenCalledWith('delete');
    expect(Stream.instances.every(item => item.closed)).toBe(true);
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
  it('hides private state and closes streams while logout is pending, without claiming it succeeded', async () => {
    const pending = deferred<void>();
    vi.mocked(api.auth.logout).mockReturnValue(pending.promise);
    show('/figures');
    await screen.findByText('Rent', { selector: '.saved-items h3' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('heading', { name: 'Signing out…' })).toBeVisible();
    expect(screen.queryByText('Rent', { selector: '.saved-items h3' })).not.toBeInTheDocument();
    expect(Stream.instances.every(item => item.closed)).toBe(true);
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await screen.findByText('You’re signed out.');
    expect(Channel.instances[0].postMessage).toHaveBeenCalledExactlyOnceWith('logout');
  });

  it('keeps failed-network logout uncertain and hidden, and confirms retry with the server', async () => {
    vi.mocked(api.auth.logout).mockRejectedValueOnce(new TypeError('private network'));
    show('/account'); await screen.findByDisplayValue('Sam');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign-out not confirmed' });
    expect(screen.queryByDisplayValue('Sam')).not.toBeInTheDocument(); expect(screen.queryByText('You’re signed out.')).not.toBeInTheDocument();
    expect(Channel.instances[0].postMessage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry sign out' }));
    await screen.findByText('You’re signed out.'); expect(api.auth.logout).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('checks the backend after a lost logout response (session survives: %s)', async survives => {
    vi.mocked(api.auth.logout).mockRejectedValueOnce(new TypeError());
    show('/account'); await screen.findByDisplayValue('Sam');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign-out not confirmed' });
    if (!survives) vi.mocked(api.auth.session).mockRejectedValue(unauthenticated());
    await userEvent.click(screen.getByRole('button', { name: 'Check sign-in' }));
    if (survives) await screen.findByDisplayValue('Sam'); else await screen.findByText('You’re signed out.');
    expect(api.auth.session).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale refresh so it cannot undo an explicit sign-out', async () => {
    const pending = deferred<AuthSession>();
    vi.mocked(api.auth.refresh).mockReturnValue(pending.promise);
    show('/figures'); await screen.findByText('Rent', { selector: '.saved-items h3' });
    fireEvent(window, new Event('focus'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('You’re signed out.');
    await act(async () => pending.resolve(authSession()));
    expect(screen.queryByText('Rent', { selector: '.saved-items h3' })).not.toBeInTheDocument();
    act(() => reportAuthLoss('unauthenticated'));
    await waitFor(() => expect(api.auth.session).toHaveBeenCalledTimes(2));
  });
});