// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { api, ApiError, authEpoch, errorMessage, invalidateRequests } from '../src/api';
import { snapshot } from './fixtures';

describe('same-origin API contract', () => {
  it('distinguishes unreadable saved data from a network outage without leaking details', () => {
    const message = errorMessage(new ApiError(500, { code: 'invalidStoredState', message: 'private stored value' }));
    expect(message).toContain('The service is reachable');
    expect(message).toContain('They have not been deleted');
    expect(message).not.toContain('private stored value');
  });
  it('explains a conflicting answer without treating it as preview acceptance or exposing diagnostics', () => {
    const error = new ApiError(409, { code: 'stalePreview', message: 'private proposal diagnostic' });
    expect(errorMessage(error, 'respondToAction')).toBe('Your answer was not saved because the open proposal differs from this suggested cut. Review the proposal or choose “Reject preview” before answering again.');
    expect(errorMessage(error, 'respondToAction')).not.toContain('private proposal diagnostic');
    expect(errorMessage(error, 'acceptPreview')).toContain('no longer available to accept');
    expect(errorMessage(error, 'discardPreview')).toBe('This preview is no longer available to reject. Review the current proposal before trying again.');
  });
  it.each([[422, 'invalidActionResponse'], [409, 'staleRevision']] as const)('explains an unsupported or stale answer (%s %s) as a changed next step', (status, code) => {
    const message = errorMessage(new ApiError(status, { code, message: 'private action diagnostic' }), 'respondToAction');
    expect(message).toBe('Your answer was not saved because this next step has changed or is no longer available. Review the current next step before answering again.');
    expect(message).not.toMatch(/Check amounts|Your draft|comparing again|private action diagnostic/);
  });
  it('keeps draft and spending-choice revision guidance separate from action responses', () => {
    const error = new ApiError(409, { code: 'staleRevision', message: 'private revision diagnostic' });
    expect(errorMessage(error, 'replaceFacts')).toContain('Your draft is still here');
    expect(errorMessage(error, 'previewAdjustments')).toContain('refresh your choices before comparing again');
    expect(errorMessage(new ApiError(422, { code: 'validationError', message: 'private input' }), 'replaceFacts')).toContain('Check amounts, dates');
  });
  it('uses cookie-owned call endpoints and allows termination during page teardown', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetch);
    await api.call(); await api.startCall(); await api.endCall();
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/session/call', { credentials: 'same-origin', signal: undefined });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/session/call', { credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/session/call', { credentials: 'same-origin', method: 'DELETE', keepalive: true });
  });
  it('establishes ownership only through explicit JSON POST with same-origin credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot())));
    vi.stubGlobal('fetch', fetch);
    await api.start();
    expect(fetch).toHaveBeenCalledWith('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' });
  });
  it.each([[410, 'expired'], [503, 'unavailable'], [404, 'notFound']])('preserves the %s error envelope', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: 'Synthetic failure', snapshot: null }), { status: Number(status) })));
    await expect(api.current()).rejects.toMatchObject({ status, body: { code, snapshot: null } });
    expect(errorMessage(new ApiError(Number(status), { code: String(code), message: 'Internal detail' }))).not.toContain('Internal detail');
  });

  it('uses the cookie-backed authentication and account contracts including empty logout responses', async () => {
    const fetch = vi.fn().mockImplementation(async (path: string) => path === '/api/auth/logout'
      ? new Response(null, { status: 204 }) : new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await api.auth.settings(); await api.auth.session(); await api.auth.refresh(); await api.auth.login('/figures');
    await expect(api.auth.logout()).resolves.toBeUndefined();
    await api.account.update('Sam'); await api.account.delete('DELETE');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/auth/settings', '/api/auth/session', '/api/auth/refresh', '/api/auth/login', '/api/auth/logout', '/api/account', '/api/account',
    ]);
    expect(fetch.mock.calls.every(([, init]) => init.credentials === 'same-origin')).toBe(true);
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(fetch.mock.calls[3][1]).toMatchObject({ method: 'POST', body: '{"returnTo":"/figures"}' });
    expect(fetch.mock.calls[5][1]).toMatchObject({ method: 'PATCH', body: '{"displayName":"Sam"}' });
    expect(fetch.mock.calls[6][1]).toMatchObject({ method: 'DELETE', body: '{"confirmation":"DELETE"}' });
  });

  it.each([[401, 'unauthenticated'], [401, 'sessionExpired'], [503, 'authUnavailable']] as const)('notifies auth loss while retaining the original %s %s envelope', async (status, code) => {
    const lost = vi.fn(); window.addEventListener('auth:loss', lost);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: 'Private diagnostic' }), { status })));
    try {
      await expect(api.current()).rejects.toMatchObject({ status, body: { code } });
      expect(lost).toHaveBeenCalledOnce(); expect(lost.mock.calls[0][0].detail).toBe(code);
    } finally { window.removeEventListener('auth:loss', lost); }
  });

  it('does not loop auth-session errors or treat ordinary network loss as logout', async () => {
    const lost = vi.fn(); window.addEventListener('auth:loss', lost);
    const error = new TypeError('Network failed');
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"code":"unauthenticated","message":"Sign in"}', { status: 401 })).mockRejectedValueOnce(error);
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(api.auth.session()).rejects.toMatchObject({ status: 401 });
      await expect(api.current()).rejects.toBe(error);
      expect(lost).not.toHaveBeenCalled();
    } finally { window.removeEventListener('auth:loss', lost); }
  });

  it('ignores a previous identity’s response and its unauthorized signal', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(yes => { resolve = yes; });
    const lost = vi.fn(); window.addEventListener('auth:loss', lost);
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
    try {
      const result = api.current(); const epoch = authEpoch();
      invalidateRequests(); expect(authEpoch()).toBeGreaterThan(epoch);
      resolve(new Response('{"code":"unauthenticated","message":"Sign in"}', { status: 401 }));
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(lost).not.toHaveBeenCalled();
    } finally { window.removeEventListener('auth:loss', lost); }
  });
});