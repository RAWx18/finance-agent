// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, invalidateRequests } from '../src/api';
import { draftFacts } from '../src/money';
import { useSession } from '../src/session';
import { planningSnapshot, settings, snapshot, Stream } from './fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network')));
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'current').mockResolvedValue(snapshot());
});

describe('release recovery: financial freshness and command ownership', () => {
  it('requires an explicit operation for a new write, including full replacement', async () => {
    vi.spyOn(api, 'save').mockResolvedValue({ ...snapshot(), sequence: 1, revision: 1 });
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const operation = { type: 'replaceFacts' as const, facts: draftFacts(snapshot()) };
    await act(async () => result.current.perform('save', operation));
    expect(api.save).not.toHaveBeenCalled();
    act(() => Stream.instances[0].emit('snapshot', snapshot()));
    const state = result.current.state;
    await act(async () => result.current.perform('save'));
    expect(api.save).not.toHaveBeenCalled();
    expect(result.current.state).toBe(state);
    await act(async () => result.current.perform('save', operation));
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: 0, operation });
    expect(result.current.state.pending).toBeNull();
  });

  it('blocks concurrent writes, start and delete and cannot replace an uncertain command on retry', async () => {
    const response = deferred<ReturnType<typeof snapshot>>();
    vi.spyOn(api, 'save').mockReturnValueOnce(response.promise).mockResolvedValueOnce({ ...snapshot(), sequence: 1, revision: 1 });
    vi.spyOn(api, 'start'); vi.spyOn(api, 'delete');
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0].emit('snapshot', snapshot()));
    let saving!: ReturnType<typeof result.current.perform>;
    act(() => { saving = result.current.perform('save', { type: 'updateFacts', changes: {
      expectedRevision: 0, opening: { amount: '20.10', status: 'exact' },
    } }); });
    const command = result.current.state.pending;
    const body = JSON.stringify(command);
    for (const action of ['start', 'delete', 'save'] as const)
      await act(async () => result.current.perform(action, { type: 'clearAccepted' }));
    expect(api.save).toHaveBeenCalledOnce();
    expect(api.start).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
    await act(async () => { response.reject(new TypeError('Response lost')); await saving; });
    for (const action of ['start', 'delete'] as const) await act(async () => result.current.perform(action));
    expect(api.start).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
    await act(async () => result.current.perform('save', { type: 'clearAccepted' }));
    expect(vi.mocked(api.save).mock.calls.map(([value]) => JSON.stringify(value))).toEqual([body, body]);
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(result.current.state.pending).toBeNull();
  });

  it.each([true, false])('keeps current SSE conflicts, ambiguity and responses through a focused correction: conflict=%s', async conflict => {
    const saved = planningSnapshot();
    saved.facts.records.push({ ...structuredClone(saved.facts.records[0]), id: 'officeRent', label: 'Office rent' });
    saved.facts.records[1].schedule.certainty = 'estimate';
    const conflicts: NonNullable<typeof saved.facts.conflicts> = [{ id: 'rent:amount', recordId: 'rent', field: 'amount',
      values: [{ id: 'reported', amountPaise: 1200000, status: 'exact' }, { id: 'disputed', amountPaise: 1100000, status: 'estimate' }] }];
    saved.facts = { ...saved.facts, conflicts: conflict ? [] : conflicts };
    saved.facts.decision = { ...saved.facts.decision!, ambiguousRecordIds: conflict ? [] : ['rent', 'officeRent'],
      responses: conflict ? [] : [{ actionId: 'clarify:opening', response: 'unavailable', dependencyKey: 'opening-basis' }] };
    const corrected = structuredClone(saved);
    corrected.sequence = 1; corrected.revision = 1;
    corrected.facts = { ...corrected.facts, conflicts: conflict ? conflicts : [] };
    corrected.facts.decision = { ...corrected.facts.decision!, ambiguousRecordIds: conflict ? ['rent', 'officeRent'] : [],
      responses: conflict ? [{ actionId: 'clarify:opening', response: 'unavailable', dependencyKey: 'opening-basis' }] : [] };
    corrected.facts.records[1].amount.amountPaise = 750000;
    corrected.facts.records[1].schedule.date = '2026-09-19';
    corrected.facts.coverage.essential = 'reviewed';
    vi.mocked(api.current).mockResolvedValue(saved);
    const confirmed = { ...corrected, sequence: 2, revision: 2,
      facts: { ...corrected.facts, opening: { status: 'exact' as const, amountPaise: 620025 } } };
    vi.spyOn(api, 'save').mockResolvedValue(confirmed);
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0].emit('snapshot', corrected));
    expect(result.current.state.snapshot?.facts).toEqual(corrected.facts);
    await act(async () => result.current.perform('save'));
    expect(api.save).not.toHaveBeenCalled();
    await act(async () => result.current.perform('save', { type: 'updateFacts', changes: {
      expectedRevision: 1, opening: { status: 'exact', amount: '6200.25' },
    } }));
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: 1,
      operation: { type: 'updateFacts', changes: { expectedRevision: 1, opening: { status: 'exact', amount: '6200.25' } } } });
    expect(result.current.state.snapshot?.facts).toEqual(confirmed.facts);
    expect(result.current.state.snapshot?.facts.records).toEqual(corrected.facts.records);
    expect(result.current.state.snapshot?.facts.records[1].schedule.certainty).toBe('estimate');
    expect(result.current.state.snapshot?.facts.coverage).toEqual(corrected.facts.coverage);
    expect(result.current.state.snapshot?.facts.conflicts).toEqual(corrected.facts.conflicts);
    expect(result.current.state.snapshot?.facts.decision).toEqual(corrected.facts.decision);
  });

  it.each(['start', 'delete', 'save'] as const)('ignores stale authentication successes and failures for %s', async action => {
    for (const failure of [false, true]) {
      const mutation = deferred<ReturnType<typeof snapshot>>();
      const deletion = deferred<{ deleted: true }>();
      vi.spyOn(api, 'start').mockReturnValue(mutation.promise);
      vi.spyOn(api, 'save').mockReturnValue(mutation.promise);
      vi.spyOn(api, 'delete').mockReturnValue(deletion.promise);
      const { result, unmount } = renderHook(useSession);
      await waitFor(() => expect(result.current.state.phase).toBe('ready'));
      act(() => Stream.instances.at(-1)!.emit('snapshot', snapshot()));
      let pending!: ReturnType<typeof result.current.perform>;
      act(() => { pending = result.current.perform(action, action === 'save'
        ? { type: 'updateFacts', changes: { expectedRevision: 0, opening: { amount: '20', status: 'exact' } } } : undefined); });
      expect(action === 'delete' ? api.delete : action === 'start' ? api.start : api.save).toHaveBeenCalled();
      const state = result.current.state;
      act(() => invalidateRequests());
      await act(async () => {
        if (failure) {
          const error = new ApiError(410, { code: 'expired', message: 'Expired', snapshot: { ...snapshot(), sequence: 9, revision: 9 } });
          if (action === 'delete') deletion.reject(error); else mutation.reject(error);
        } else if (action === 'delete') deletion.resolve({ deleted: true });
        else mutation.resolve({ ...snapshot(), sequence: 9, revision: 9 });
        await pending;
      });
      expect(result.current.state).toBe(state);
      unmount();
    }
  });

  it('does not start a replacement session after authentication expires during deletion', async () => {
    const deletion = deferred<{ deleted: true }>();
    vi.spyOn(api, 'delete').mockReturnValue(deletion.promise);
    vi.spyOn(api, 'start');
    const { result } = renderHook(useSession);
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    act(() => result.current.dispatch({ type: 'terminal', phase: 'expired', message: 'Expired' }));
    let pending!: ReturnType<typeof result.current.perform>;
    act(() => { pending = result.current.perform('start'); });
    const state = result.current.state;
    act(() => invalidateRequests());
    await act(async () => { deletion.resolve({ deleted: true }); await pending; });
    expect(api.start).not.toHaveBeenCalled();
    expect(result.current.state).toBe(state);
  });

  it('retries the exact uncertain correction despite a later SSE ambiguity change', async () => {
    vi.spyOn(api, 'save').mockRejectedValueOnce(new TypeError('Response lost after commit'))
      .mockResolvedValueOnce({ ...snapshot(), revision: 1, sequence: 1 });
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0].emit('snapshot', snapshot()));
    await act(async () => result.current.perform('save', { type: 'updateFacts', changes: {
      expectedRevision: 0, opening: { amount: '20', status: 'exact' },
    } }));
    const command = result.current.state.pending;
    const body = JSON.stringify(command);
    const corrected = { ...snapshot(), revision: 2, sequence: 2 };
    corrected.facts.decision = { ...corrected.facts.decision!, ambiguousRecordIds: ['rent', 'officeRent'] };
    act(() => Stream.instances[0].emit('snapshot', corrected));
    expect(result.current.state.pending).toBe(command);
    await act(async () => result.current.perform('save'));
    expect(vi.mocked(api.save).mock.calls.map(([value]) => JSON.stringify(value))).toEqual([body, body]);
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(result.current.state.snapshot?.facts.decision?.ambiguousRecordIds).toEqual(['rent', 'officeRent']);
    expect(result.current.state.pending).toBeNull();
  });

  it('confirms a deliberate deletion when its stream notification arrives before the HTTP response', async () => {
    const deletion = deferred<{ deleted: true }>();
    vi.spyOn(api, 'delete').mockReturnValue(deletion.promise);
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const stream = Stream.instances[0];
    act(() => stream.emit('snapshot', snapshot()));
    let pending!: ReturnType<typeof result.current.perform>;
    act(() => { pending = result.current.perform('delete'); });
    act(() => stream.emit('deleted', {}));
    expect(stream.closed).toBe(true);
    await act(async () => { deletion.resolve({ deleted: true }); await pending; });
    expect(result.current.state.phase).toBe('empty');
    expect(result.current.state.snapshot).toBeNull();
    expect(result.current.state.pending).toBeNull();
    expect(result.current.state.busy).toBe(false);
    expect(api.delete).toHaveBeenCalledOnce();
  });

  it('requires a matching valid snapshot, not socket open or a successful fallback read', async () => {
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const stream = Stream.instances[0];
    act(() => stream.onopen?.());
    expect(result.current.state.connection).toBe('connecting');
    act(() => stream.emit('snapshot', { ...snapshot(), sessionId: 'another' }));
    expect(result.current.state.connection).toBe('connecting');
    act(() => stream.emit('snapshot', snapshot()));
    expect(result.current.state.connection).toBe('live');
    await act(async () => stream.onerror?.());
    expect(api.current).toHaveBeenCalledTimes(2);
    expect(result.current.state.connection).toBe('reconnecting');
    act(() => stream.onopen?.());
    expect(result.current.state.connection).toBe('reconnecting');
    act(() => stream.emit('snapshot', snapshot()));
    expect(result.current.state.connection).toBe('live');
  });

  it.each([null, {}, { ...snapshot(), facts: null }, { ...snapshot(), sequence: 0.25 }])('closes corrupt snapshots and rejects their queued follow-up events: %j', async value => {
    vi.spyOn(api, 'save').mockRejectedValue(new TypeError('Response lost'));
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const stream = Stream.instances[0];
    act(() => stream.emit('snapshot', snapshot()));
    await act(async () => result.current.perform('save', { type: 'updateFacts', changes: {
      expectedRevision: 0, opening: { amount: '20', status: 'exact' },
    } }));
    const command = result.current.state.pending;
    const saved = result.current.state.snapshot;
    act(() => {
      stream.emit('snapshot', value);
      stream.emit('snapshot', { ...snapshot(), sequence: 7 });
      stream.onopen?.();
    });
    expect(stream.closed).toBe(true);
    expect(result.current.state.phase).toBe('unavailable');
    expect(result.current.state.snapshot?.sequence).toBe(0);
    expect(result.current.state.snapshot).toBe(saved);
    expect(result.current.state.pending).toBe(command);
    act(() => result.current.retryConnection());
    await waitFor(() => expect(Stream.instances).toHaveLength(2));
    act(() => {
      stream.emit('deleted', {});
      stream.emit('snapshot', { ...snapshot(), sequence: 9 });
      Stream.instances[1].emit('snapshot', { ...snapshot(), sequence: 2 });
    });
    expect(result.current.state.phase).toBe('ready');
    expect(result.current.state.snapshot?.sequence).toBe(2);
    expect(result.current.state.connection).toBe('live');
    expect(result.current.state.pending).toBe(command);
  });

  it('ignores an earlier failed reconnect probe after a newer valid snapshot', async () => {
    const probe = deferred<ReturnType<typeof snapshot>>();
    vi.mocked(api.current).mockResolvedValueOnce(snapshot()).mockReturnValueOnce(probe.promise);
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const stream = Stream.instances[0];
    act(() => stream.onerror?.());
    act(() => stream.emit('snapshot', { ...snapshot(), sequence: 3 }));
    await act(async () => probe.reject(new Error('Earlier probe failed')));
    expect(result.current.state.connection).toBe('live');
    expect(result.current.state.snapshot?.sequence).toBe(3);
    act(() => stream.emit('snapshot', { ...snapshot(), sequence: 2 }));
    expect(result.current.state.snapshot?.sequence).toBe(3);
  });

  it('ignores queued snapshots and terminal events from an expired authentication epoch', async () => {
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const stream = Stream.instances[0];
    act(() => { invalidateRequests(); stream.emit('snapshot', { ...snapshot(), sequence: 9 }); stream.emit('deleted', {}); stream.onopen?.(); });
    expect(result.current.state.snapshot?.sequence).toBe(0);
    expect(result.current.state.phase).toBe('ready');
    expect(result.current.state.connection).toBe('connecting');
  });

  it('retains the exact uncertain UUID and body across lost updates, correction and retry', async () => {
    vi.spyOn(api, 'save').mockRejectedValueOnce(new TypeError('Response lost after commit'))
      .mockResolvedValueOnce({ ...snapshot(), revision: 1, sequence: 1 });
    const { result } = renderHook(useSession);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const stream = Stream.instances[0];
    act(() => stream.emit('snapshot', snapshot()));
    await act(async () => result.current.perform('save', { type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' }));
    const command = result.current.state.pending;
    const body = JSON.stringify(command);
    await act(async () => stream.onerror?.());
    await act(async () => result.current.perform('save'));
    expect(api.save).toHaveBeenCalledTimes(1);
    act(() => stream.emit('snapshot', { ...snapshot(), revision: 2, sequence: 2 }));
    await act(async () => result.current.perform('save'));
    expect(vi.mocked(api.save).mock.calls.map(([value]) => JSON.stringify(value))).toEqual([body, body]);
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    expect(result.current.state.pending).toBeNull();
    expect(result.current.state.snapshot?.revision).toBe(2);
    expect(result.current.state.message).toContain('later changes superseded');
  });
});