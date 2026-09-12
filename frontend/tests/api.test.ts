// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { api, ApiError, authEpoch, errorMessage, invalidateRequests, readSnapshot } from '../src/api';
import type { Command } from '../src/api';
import { adjustmentOptions, scenario, settings, snapshot } from './fixtures';
import { initialState, reducer } from '../src/session';

describe('same-origin API contract', () => {
  it('preserves the complete ordered options response, including choices that are not acceptance-ready', async () => {
    const value = structuredClone(adjustmentOptions);
    value.options.reverse(); value.options[0].acceptanceReady = false;
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(value)));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await expect(api.options(controller.signal)).resolves.toEqual(value);
    expect(fetch).toHaveBeenCalledWith('/api/session/options', { credentials: 'same-origin', signal: controller.signal });
    value.options = [];
    await expect(api.options()).resolves.toEqual(value);
  });

  it.each([null, false, [], {}])('rejects missing options envelopes %j', async value => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(api.options()).rejects.toThrow('Planning choices could not be read safely.');
  });

  it.each([
    { sessionId: undefined }, { sessionId: null }, { sessionId: '' }, { sessionId: '  ' }, { sessionId: 1 },
    ...['revision', 'sequence'].flatMap(field => [undefined, null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1].map(value => ({ [field]: value }))),
    ...[undefined, null, 'September 11, 2026', '2026-9-11', '2026-02-30', '2026-09-11T00:00:00Z'].map(today => ({ today })),
    { options: undefined }, { options: null }, { options: {} }, { options: [null] },
    { options: [adjustmentOptions.options[0], adjustmentOptions.options[0]] },
  ])('rejects malformed options envelope %j', async fields => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...adjustmentOptions, ...fields }))));
    await expect(api.options()).rejects.toThrow();
  });

  it.each([
    ...['eventId', 'recordId', 'label', 'dependencyKey'].flatMap(field => [undefined, null, '', '  ', 1].map(value => ({ [field]: value }))),
    { kind: 'essential' }, { kind: undefined }, { date: '2026-02-29' }, { date: '2026-09-27T00:00:00Z' }, { date: undefined },
    ...['originalPaise', 'minimumPaise'].flatMap(field => [undefined, null, -1, 0.5, '100', Number.MAX_SAFE_INTEGER + 1].map(value => ({ [field]: value }))),
    { originalPaise: 0 }, { minimumPaise: 200000 }, { minimumPaise: 200001 },
    { acceptanceReady: undefined }, { acceptanceReady: null }, { acceptanceReady: 'true' }, { acceptanceReady: 1 },
  ])('rejects the whole response instead of filtering a malformed option %j', async fields => {
    const value = { ...adjustmentOptions, options: [adjustmentOptions.options[1], { ...adjustmentOptions.options[0], ...fields }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(api.options()).rejects.toThrow();
  });

  it('accepts nullable and omitted scenarios and optional consent metadata without inventing fields', async () => {
    const value = snapshot();
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(value)));
    vi.stubGlobal('fetch', fetch);
    await expect(api.current()).resolves.toEqual(value);
    value.preview = null; value.accepted = null;
    await expect(api.current()).resolves.toEqual(value);
    value.preview = scenario(); value.accepted = scenario('accepted-one');
    value.preview.adjustments[0].acceptanceReady = false;
    value.accepted.adjustments[0].acceptedRevision = 0;
    delete value.preview.adjustments[0].acceptedRevision;
    await expect(api.current()).resolves.toEqual(value);
    expect(readSnapshot(value)).toBe(value);
  });

  it('preserves full multi-occurrence review data, minimum amounts, unknowns and removal identities', async () => {
    const value = snapshot();
    value.preview = scenario();
    value.preview.adjustments.push({ ...adjustmentOptions.options[1], amountPaise: adjustmentOptions.options[1].minimumPaise, acceptedRevision: 0 });
    value.preview.removedAssumptionIds = ['another:2026-09-28'];
    value.preview.plan.budgetBasis = { datedProjectionComplete: false, unresolvedAmounts: [
      { recordId: 'undated', reason: 'missingDate', amount: { amountPaise: null, status: 'unknown' }, recurrence: 'once' },
    ] };
    value.preview.plan.timingRisks = [{ date: '2026-09-13', exposurePaise: 700000, remainingGapPaise: 0 }];
    value.preview.plan.events[0].amountPaise = null;
    value.preview.plan.events[0].amountStatus = 'unknown';
    value.preview.plan.events[0].balancePaise = null;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(api.current()).resolves.toEqual(value);
  });

  it.each([
    { id: undefined }, { id: '' }, { id: ' ' }, { id: 1 },
    ...[undefined, null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1].map(sourceRevision => ({ sourceRevision })),
    ...[undefined, null, '', '2026-09-11', '2026-02-30T04:00:00Z', '2026-09-11T99:00:00Z'].map(createdAt => ({ createdAt })),
    { adjustments: undefined }, { adjustments: null }, { adjustments: {} }, { adjustments: [null] },
    { adjustments: [scenario().adjustments[0], scenario().adjustments[0]] },
    ...[undefined, null, -1, 0.5, '100', Number.MAX_SAFE_INTEGER + 1].map(reducedOutflowPaise => ({ reducedOutflowPaise })),
    { removedAssumptionIds: null }, { removedAssumptionIds: {} }, { removedAssumptionIds: [''] },
    { removedAssumptionIds: [1] }, { removedAssumptionIds: ['one', 'one'] }, { plan: undefined }, { plan: null }, { plan: {} },
  ])('rejects malformed preview and accepted scenario metadata %j', async fields => {
    for (const key of ['preview', 'accepted']) {
      const value = { ...snapshot(), [key]: { ...scenario(), ...fields } };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
      await expect(api.current()).rejects.toThrow();
      expect(() => readSnapshot(value)).toThrow();
    }
  });

  it.each([
    { eventId: '' }, { recordId: null }, { label: undefined }, { dependencyKey: '' }, { kind: 'debt' },
    { date: '2026-02-30' }, { acceptanceReady: 'false' }, { acceptanceReady: undefined },
    { originalPaise: 0 }, { minimumPaise: -1 }, { minimumPaise: 200000 },
    ...[undefined, null, -1, 0.5, '0', 200000, 200001, Number.MAX_SAFE_INTEGER + 1].map(amountPaise => ({ amountPaise })),
    ...[-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1].map(acceptedRevision => ({ acceptedRevision })),
    { kind: 'card', minimumPaise: 100000, amountPaise: 99999 },
  ])('rejects malformed adjustments in either scenario %j', async fields => {
    for (const key of ['preview', 'accepted']) {
      const value = { ...snapshot(), [key]: { ...scenario(), adjustments: [{ ...scenario().adjustments[0], ...fields }] } };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
      await expect(api.current()).rejects.toThrow();
      expect(() => readSnapshot(value)).toThrow();
    }
  });

  it.each([
    ...['reliableIncomePaise', 'uncertainIncomePaise', 'outflowPaise', 'peakGapPaise', 'reserveShortfallPaise']
      .flatMap(field => [undefined, -1, '1', Number.MAX_SAFE_INTEGER + 1].map(value => ({ [field]: value }))),
    { closingPaise: undefined }, { closingPaise: '100' }, { troughPaise: 0.5 },
    { firstGap: undefined }, { firstGap: {} }, { firstGap: { date: '2026-02-30', amountPaise: 1 } },
    { firstGap: { date: '2026-09-11', amountPaise: -1 } }, { peakGapDate: 'tomorrow' },
    { evaluatedOn: undefined }, { evaluatedOn: '2026-02-30' }, { projectionPartial: 'false' },
    { events: null }, { events: {} }, { events: [null] },
    { events: [scenario().plan.events[0], scenario().plan.events[0]] },
    ...[{ id: '' }, { recordId: undefined }, { kind: 'card' }, { date: '2026-02-30' }, { amountPaise: -1 },
      { balancePaise: '1' }, { amountBasis: 'invented' }, { included: 'false' }]
      .map(fields => ({ events: [{ ...scenario().plan.events[0], ...fields }] })),
    { timingRisks: null }, { timingRisks: [null] }, { timingRisks: [{ date: '2026-09-11', exposurePaise: 1, remainingGapPaise: -1 }] },
    { budgetBasis: null }, { budgetBasis: {} }, { budgetBasis: { datedProjectionComplete: 'true', unresolvedAmounts: [] } },
    { budgetBasis: { datedProjectionComplete: false, unresolvedAmounts: null } },
    { budgetBasis: { datedProjectionComplete: false, unresolvedAmounts: [null] } },
    ...[{ recordId: '' }, { reason: 'invented' }, { amount: { amountPaise: '100', status: 'exact' } },
      { amount: { amountPaise: -1, status: 'exact' } }, { amount: { amountPaise: null, status: 'invented' } }, { recurrence: 'yearly' }]
      .map(fields => ({ budgetBasis: { datedProjectionComplete: false, unresolvedAmounts: [
        { recordId: 'undated', reason: 'missingDate', amount: { amountPaise: null, status: 'unknown' }, recurrence: 'once', ...fields },
      ] } })),
  ])('rejects malformed review plans in baseline, preview and accepted data %j', async fields => {
    for (const key of ['plan', 'preview', 'accepted']) {
      const plan = { ...scenario().plan, ...fields };
      const value = { ...snapshot(), [key]: key === 'plan' ? plan : { ...scenario(), plan } };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
      await expect(api.current()).rejects.toThrow();
      expect(() => readSnapshot(value)).toThrow();
    }
  });

  it('validates command responses and preserves command concurrency guards', async () => {
    const command: Command = { commandId: crypto.randomUUID(), expectedRevision: 0, expectedSequence: 0,
      operation: { type: 'previewAdjustments', adjustments: [{ eventId: adjustmentOptions.options[0].eventId, amount: '0' }] } };
    const value = { ...snapshot(), preview: scenario(), accepted: null };
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(value)));
    vi.stubGlobal('fetch', fetch);
    await expect(api.save(command)).resolves.toEqual(value);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(command);
    value.preview.adjustments[0].amountPaise = -1;
    await expect(api.save(command)).rejects.toThrow('The saved figures could not be read safely.');
  });

  it.each([false, [], {}, { ...snapshot(), sequence: 1, preview: {} },
    { ...snapshot(), sequence: 1, accepted: { ...scenario(), plan: {} } },
    { ...snapshot(), sequence: 1, workspace: { ...snapshot().workspace, cards: [null] } },
    { ...snapshot(), sequence: Number.MAX_SAFE_INTEGER + 1 },
  ])('prevents malformed error snapshots from replacing the last valid reducer state: %j', async value => {
    const state = reducer(initialState, { type: 'loaded', snapshot: snapshot(), settings });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'stalePreview', message: 'Private diagnostic', snapshot: value }), { status: 409 })));
    const error = await api.current().catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.body).toEqual({ code: 'unavailable', message: 'The request could not be completed.' });
    const failed = reducer(state, { type: 'failure', message: errorMessage(error), snapshot: error.body.snapshot });
    expect(failed.snapshot).toBe(state.snapshot);
    expect(failed.messageKind).toBe('error');
  });

  it('allows a validated error snapshot to reach the reducer with the original error semantics', async () => {
    const state = reducer(initialState, { type: 'loaded', snapshot: snapshot(), settings });
    const value = { ...snapshot(), sequence: 1, preview: scenario(), accepted: null };
    const body = { code: 'stalePreview', message: 'Private diagnostic', snapshot: value };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 })));
    const error = await api.current().catch(error => error);
    expect(error).toBeInstanceOf(ApiError); expect(error.body).toEqual(body);
    const failed = reducer(state, { type: 'failure', message: errorMessage(error, 'previewAdjustments'), snapshot: error.body.snapshot });
    expect(failed.snapshot).toEqual(value); expect(failed.messageKind).toBe('error');
    expect(failed.message).not.toContain('Private diagnostic');
  });

  it.each(['voiceStartupSeconds', 'voiceShutdownSeconds'] as const)('rejects missing or invalid %s instead of inventing a deadline', async field => {
    for (const value of [undefined, null, 0, -1, '45', Infinity]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...settings, [field]: value }))));
      await expect(api.settings()).rejects.toThrow('Conversation settings could not be read safely.');
    }
  });
  it('reads the configured assistant name from server settings without a local identity default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...settings, assistantName: 'Maya' }))));
    await expect(api.settings()).resolves.toEqual({ ...settings, assistantName: 'Maya' });
  });

  it.each([undefined, null, '', '  ', 12, 'Maya\n', 'Maya\u007f'])('rejects invalid assistant identity %j instead of substituting a name', async assistantName => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...settings, assistantName }))));
    await expect(api.settings()).rejects.toThrow('Conversation settings could not be read safely.');
  });

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
    expect(errorMessage(error, 'previewAdjustments')).toBe('Another preview changed while you were choosing amounts. Review the current preview before replacing it.');
    expect(errorMessage(error, 'discardPreview')).toBe('This preview is no longer available to close. Review the current proposal before trying again. Closing a preview does not reject it.');
    expect(errorMessage(error, 'rejectPreview')).toBe('This preview is no longer available to reject. Review the current proposal before trying again.');
  });
  it('explains an exact declined proposal without sending the consumer through a pointless refresh', () => {
    const message = errorMessage(new ApiError(409, { code: 'proposalRejected', message: 'Private diagnostic' }), 'previewAdjustments');
    expect(message).toBe('This exact set of proposed changes was previously declined. Choose another amount or a different set of changes to preview.');
    expect(message).not.toMatch(/refresh|Private diagnostic/i);
  });
  it.each(['previewAdjustments', 'acceptPreview', 'discardPreview', 'rejectPreview', 'clearAccepted'] as const)('keeps unconfirmed %s failures safe to retry without claiming anything was saved', operation => {
    for (const error of [new TypeError('Failed to fetch'), new Error('The saved figures could not be read safely.'), new SyntaxError('Malformed JSON')]) {
      const message = errorMessage(error, operation);
      expect(message).toBe('This proposal action could not be confirmed. Keep this page open, check your connection, and retry the same action safely.');
      expect(message).not.toMatch(/is saved|was saved|not saved|has not changed|Failed to fetch|Malformed JSON/);
    }
    expect(errorMessage(new Error(), 'replaceFacts')).toBe('We could not reach your projection. Check your connection and retry.');
  });
  it.each([[422, 'invalidActionResponse'], [409, 'staleRevision']] as const)('explains an unsupported or stale answer (%s %s) as a changed next step', (status, code) => {
    const message = errorMessage(new ApiError(status, { code, message: 'private action diagnostic' }), 'respondToAction');
    expect(message).toBe('Your answer was not saved because this next step has changed or is no longer available. Review the current next step before answering again.');
    expect(message).not.toMatch(/Check amounts|Your draft|comparing again|private action diagnostic/);
  });
  it('keeps draft and spending-choice revision guidance separate from action responses', () => {
    const error = new ApiError(409, { code: 'staleRevision', message: 'private revision diagnostic' });
    expect(errorMessage(error, 'replaceFacts')).toContain('Your draft is still here');
    expect(errorMessage(error, 'updateFacts')).toBe('Saved figures changed elsewhere. Review the current figures before retrying your corrections.');
    expect(errorMessage(error, 'previewAdjustments')).toContain('refresh your choices before comparing again');
    expect(errorMessage(new ApiError(422, { code: 'validationError', message: 'private input' }), 'replaceFacts')).toContain('Check amounts, dates');
  });
  it('uses cookie-owned call endpoints and allows termination during page teardown', async () => {
    const callId = crypto.randomUUID();
    const state = { callId, status: 'ended', cleanupConfirmed: true, message: null };
    const join = { callId, conversationSlug: 'chat-a', url: 'https://test.daily.co/room', token: 'test-token', expiresAt: new Date(Date.now() + 60000).toISOString() };
    const fetch = vi.fn().mockImplementation((_path, init: RequestInit) => Promise.resolve(new Response(JSON.stringify(init.method === 'POST' ? join : state))));
    vi.stubGlobal('fetch', fetch);
    const body = JSON.stringify({ callId });
    const controller = new AbortController();
    await api.call(); await api.startCall(callId); await api.endCall(callId, controller.signal);
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/session/call', { credentials: 'same-origin', signal: undefined });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/session/call', { credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/session/call', { credentials: 'same-origin', method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, signal: controller.signal });
  });

  it.each([null, [], {}, { callId: 'invalid' }, { callId: null, status: 'active', cleanupConfirmed: true, message: null },
    { callId: null, status: 'ended', message: null }, { callId: null, status: 'unknown', cleanupConfirmed: true, message: null },
  ])('rejects malformed call state without claiming termination: %j', async value => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(api.call()).rejects.toThrow();
  });

  it.each([{ token: '' }, { token: null }, { expiresAt: 'invalid' }, { url: 'https://evil.example/room' },
    { url: 'https://test.daily.co.evil.example/room' }, { url: 'https://user:secret@test.daily.co/room' },
    { url: 'https://test.daily.co/room?token=secret' }, { url: 'http://test.daily.co/room' },
  ])('rejects malformed credentials before provider connection: %j', async fields => {
    const callId = crypto.randomUUID();
    const join = { callId, conversationSlug: 'chat-a', url: 'https://test.daily.co/room', token: 'test-token', expiresAt: new Date(Date.now() + 60000).toISOString(), ...fields };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(join))));
    await expect(api.startCall(callId)).rejects.toThrow();
  });

  it('rejects expired media credentials without treating the financial session as expired', async () => {
    const callId = crypto.randomUUID();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ callId, conversationSlug: 'chat-a', url: 'https://test.daily.co/room',
      token: 'test-token', expiresAt: new Date(Date.now() - 1).toISOString() }))));
    await expect(api.startCall(callId)).rejects.toMatchObject({ status: 410, body: { code: 'callExpired' } });
  });

  it('rejects a termination response for another call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ callId: crypto.randomUUID(), status: 'ended', cleanupConfirmed: true, message: null }))));
    await expect(api.endCall(crypto.randomUUID())).rejects.toThrow('Call ownership could not be confirmed.');
  });

  it.each([null, [], {}, { message: 'private provider detail' }])('retains authentication-loss handling for malformed errors: %j', async body => {
    const lost = vi.fn(); window.addEventListener('auth:loss', lost);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 401 })));
    try {
      await expect(api.call()).rejects.toMatchObject({ status: 401, body: { code: 'unavailable' } });
      expect(lost).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('auth:loss', lost); }
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
    const user = { id: 'user-one', displayName: 'Sam', googleName: 'Sam Google', email: 'sam@example.com' };
    const fetch = vi.fn().mockImplementation(async (path: string, init: RequestInit) => path === '/api/auth/logout'
      ? new Response(null, { status: 204 }) : new Response(JSON.stringify(path === '/api/auth/settings'
        ? { googleAvailable: true, sessionHours: 168 } : path === '/api/auth/login' ? { url: 'https://accounts.google.com/o/oauth2/v2/auth' }
          : path === '/api/account' ? init.method === 'DELETE' ? { deleted: true } : user
            : { user, expiresAt: new Date(Date.now() + 3600000).toISOString() })));
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

  it('restores a valid Google identity when Google omits the optional profile name', async () => {
    const user = { id: 'user-one', displayName: 'Google user', googleName: '', email: 'sam@example.com' };
    const session = { user, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async path => new Response(JSON.stringify(path === '/api/account' ? user : session))));
    await expect(api.auth.session()).resolves.toEqual(session);
    await expect(api.auth.refresh()).resolves.toEqual(session);
    await expect(api.account.update('Google user')).resolves.toEqual(user);
  });

  it.each([{ googleName: null }, { googleName: 123 }, { id: '' }, { displayName: '' }, { email: '' }])('still rejects invalid identity fields %j', async fields => {
    const user = { id: 'user-one', displayName: 'Sam', googleName: '', email: 'sam@example.com', ...fields };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ user, expiresAt: '2099-01-01T00:00:00Z' }))));
    await expect(api.auth.session()).rejects.toThrow('The account could not be read safely.');
  });

  it.each([null, {}, { user: null, expiresAt: 'invalid' },
    { user: { id: 'user', displayName: 'Sam', googleName: 'Sam', email: 123 }, expiresAt: '2099-01-01T00:00:00Z' },
    { user: { id: 'user', displayName: 'Sam', googleName: 'Sam', email: 'sam@example.com' }, expiresAt: '2000-01-01T00:00:00Z' },
  ])('rejects malformed or expired authentication responses: %j', async value => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(value))));
    await expect(api.auth.session()).rejects.toThrow();
    await expect(api.auth.refresh()).rejects.toThrow();
  });

  it('rejects malformed availability, login, profile, deletion and logout confirmations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{}')));
    await expect(api.auth.settings()).rejects.toThrow();
    await expect(api.auth.login('/app')).rejects.toThrow();
    await expect(api.account.update('Sam')).rejects.toThrow();
    await expect(api.account.delete('DELETE')).rejects.toThrow();
    await expect(api.auth.logout()).rejects.toThrow();
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