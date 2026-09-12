// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api, ApiError, authEpoch, errorMessage, exactNumbers, reportAuthLoss, readSnapshot } from './api';
import type { Command, Settings, Snapshot } from './api';

export type State = {
  phase: 'loading' | 'empty' | 'ready' | 'expired' | 'deleted' | 'unavailable' | 'unreadable';
  settings: Settings | null;
  snapshot: Snapshot | null;
  connection: 'connecting' | 'live' | 'reconnecting' | 'closed';
  pending: Command | null;
  busy: boolean;
  message: string;
  messageKind: 'status' | 'error';
};

export const initialState: State = {
  phase: 'loading', settings: null, snapshot: null, connection: 'closed',
  pending: null, busy: false, message: '', messageKind: 'status',
};

type Action =
  | { type: 'loaded'; settings: Settings; snapshot: Snapshot | null }
  | { type: 'settings'; settings: Settings }
  | { type: 'selecting' }
  | { type: 'started'; snapshot: Snapshot }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'connection'; connection: State['connection'] }
  | { type: 'terminal'; phase: State['phase']; message: string }
  | { type: 'deleted' }
  | { type: 'busy'; busy: boolean }
  | { type: 'pending'; command: Command }
  | { type: 'saved'; snapshot: Snapshot }
  | { type: 'failure'; message: string; uncertain?: boolean; snapshot?: Snapshot | null };

function receive(state: State, snapshot: Snapshot): State {
  if (!state.snapshot || snapshot.sessionId !== state.snapshot.sessionId || snapshot.sequence <= state.snapshot.sequence) return state;
  const cleared = (state.snapshot.accepted || state.snapshot.preview) && !snapshot.accepted && !snapshot.preview;
  const affected = snapshot.invalidatedAssumptions?.length ?? 0;
  return { ...state, snapshot, messageKind: 'status', message: affected
    ? `${affected} planning assumption(s) need fresh consent. ${snapshot.accepted?.adjustments.length ?? 0} remain saved.`
    : cleared ? 'Planning assumptions and preview cleared. The reported baseline is shown.' : state.messageKind === 'error' ? '' : state.message };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': return { ...state, settings: action.settings, snapshot: action.snapshot, phase: action.snapshot ? 'ready' : 'empty', busy: false, message: '', messageKind: 'status' };
    case 'settings': return { ...state, settings: action.settings };
    case 'selecting': return { ...initialState, settings: state.settings, busy: true };
    case 'started': return state.snapshot?.sessionId === action.snapshot.sessionId
      ? receive(state, action.snapshot)
      : { ...initialState, settings: state.settings, phase: 'ready', snapshot: action.snapshot, message: 'Your session is saved. Figures will appear as you share them.' };
    case 'snapshot': return receive(state, action.snapshot);
    case 'connection': return { ...state, connection: action.connection };
    case 'terminal': return { ...state, phase: action.phase, connection: 'closed', busy: false, message: action.message, messageKind: 'status' };
    case 'busy': return { ...state, busy: action.busy, message: action.busy ? '' : state.message, messageKind: action.busy ? 'status' : state.messageKind };
    case 'pending': return { ...state, pending: action.command, busy: true, message: '', messageKind: 'status' };
    case 'saved': {
      if (action.snapshot.sessionId !== state.snapshot?.sessionId) return state;
      const operation = state.pending?.operation.type;
      const messages: Record<Command['operation']['type'], string> = {
        replaceFacts: `Your figures are saved. ${action.snapshot.accepted?.adjustments.length ?? 0} planning assumption(s) remain saved; ${action.snapshot.invalidatedAssumptions?.length ?? 0} need fresh consent. The preview is cleared.`,
        updateFacts: `Your corrections are saved. ${action.snapshot.accepted?.adjustments.length ?? 0} planning assumption(s) remain saved; ${action.snapshot.invalidatedAssumptions?.length ?? 0} need fresh consent. The preview is cleared.`,
        previewAdjustments: 'Preview ready to review. Your saved projection has not changed.',
        acceptPreview: 'Planning assumptions saved. No payments or account changes have been made.',
        discardPreview: 'Preview closed, not rejected. Your saved projection has not changed.',
        rejectPreview: 'Your decision not to use this proposal is saved. No payments or account changes have been made.',
        clearAccepted: 'Planning assumptions and preview cleared. The reported baseline is shown.',
        respondToAction: 'Your answer is saved.',
      };
      return { ...receive(state, action.snapshot), pending: null, busy: false,
        messageKind: 'status',
        message: action.snapshot.sequence < state.snapshot.sequence
          ? 'The action was confirmed, but later changes superseded it. The latest saved projection is shown.'
          : operation ? messages[operation] : state.messageKind === 'error' ? '' : state.message,
      };
    }
    case 'failure': return { ...action.snapshot ? receive(state, action.snapshot) : state,
      pending: action.uncertain ? state.pending : null, busy: false, message: action.message, messageKind: 'error',
    };
    case 'deleted': return { ...initialState, settings: state.settings, phase: 'empty', message: 'Projection deleted from this service.' };
  }
}

export function useSession() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [loadKey, reload] = useReducer((value: number) => value + 1, 0);
  const [streamKey, reconnect] = useReducer((value: number) => value + 1, 0);
  const lock = useRef(false);
  const generation = useRef(0);
  const stream = useRef<EventSource | null>(null);
  const deleting = useRef(false);
  const selection = useRef<Promise<Snapshot | undefined> | null>(null);
  const latest = useRef(state.snapshot);
  useEffect(() => {
    if (state.snapshot || state.phase === 'empty' || state.phase === 'deleted') latest.current = state.snapshot;
  }, [state.snapshot, state.phase]);

  useEffect(() => {
    const controller = new AbortController();
    const version = generation.current;
    const epoch = authEpoch();
    const current = () => !controller.signal.aborted && version === generation.current && epoch === authEpoch();
    const load = async () => {
      try {
        const settings = await api.settings(controller.signal);
        if (current()) dispatch({ type: 'settings', settings });
        let snapshot: Snapshot | null = null;
        try { snapshot = await api.current(controller.signal); }
        catch (error) {
          if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 410)) throw error;
          if (error.status === 410) {
            if (current()) {
              dispatch({ type: 'loaded', settings, snapshot: null });
              dispatch({ type: 'terminal', phase: 'expired', message: errorMessage(error) });
            }
            return;
          }
        }
        if (current()) dispatch({ type: 'loaded', settings, snapshot });
      } catch (error) {
        if (current()) dispatch({ type: 'terminal',
          phase: error instanceof ApiError && error.body.code === 'invalidStoredState' ? 'unreadable' : 'unavailable',
          message: errorMessage(error) });
      }
    };
    void load();
    return () => controller.abort();
  }, [loadKey]);

  const sessionId = state.snapshot?.sessionId;
  useEffect(() => {
    if (!sessionId || state.phase !== 'ready') return;
    const controller = new AbortController();
    const source = new EventSource('/api/session/events');
    const epoch = authEpoch();
    const version = generation.current;
    stream.current = source;
    let recovery = 0;
    const current = () => !controller.signal.aborted && epoch === authEpoch() && version === generation.current && stream.current === source;
    dispatch({ type: 'connection', connection: streamKey ? 'reconnecting' : 'connecting' });
    // An open socket is not evidence that its financial picture is current.
    source.onopen = () => { if (current()) recovery++; };
    source.addEventListener('snapshot', (event) => {
      if (!current()) return;
      try {
        const snapshot = readSnapshot(JSON.parse((event as MessageEvent<string>).data, exactNumbers));
        if (snapshot.sessionId !== sessionId || snapshot.sequence < (latest.current?.sequence ?? 0)) return;
        latest.current = snapshot;
        recovery++;
        dispatch({ type: 'snapshot', snapshot });
        dispatch({ type: 'connection', connection: 'live' });
      } catch {
        source.close(); controller.abort();
        dispatch({ type: 'terminal', phase: 'unavailable', message: 'The saved figures could not be read safely. Retry the connection.' });
      }
    });
    for (const name of ['unauthenticated', 'sessionExpired', 'authUnavailable'] as const) {
      source.addEventListener(name, () => {
        if (!current()) return;
        source.close(); controller.abort();
        reportAuthLoss(name, epoch);
      });
    }
    for (const name of ['expired', 'deleted', 'notFound', 'unavailable'] as const) {
      source.addEventListener(name, () => {
        if (!current()) return;
        source.close(); controller.abort();
        if (name === 'deleted' && deleting.current) return;
        if (name !== 'unavailable') generation.current++;
        dispatch({ type: 'terminal', phase: name === 'notFound' ? 'deleted' : name,
          message: name === 'unavailable' ? 'Live updates are unavailable. Your last saved figures are still shown.'
            : name === 'expired' ? 'This projection has expired. Start again with fresh figures.'
              : 'This projection was deleted or is no longer available.',
        });
      });
    }
    source.onerror = () => {
      if (!current()) { source.close(); return; }
      const version = ++recovery;
      dispatch({ type: 'connection', connection: 'reconnecting' });
      // EventSource hides HTTP errors; this one-off check distinguishes a terminal session from a dropped stream.
      void api.current(controller.signal).then((snapshot) => {
        if (current() && version === recovery) dispatch({ type: 'snapshot', snapshot });
      }).catch((error: unknown) => {
        if (!current() || version !== recovery) return;
        if (error instanceof ApiError && ([404, 410, 503, 429].includes(error.status) || error.body.code === 'invalidStoredState')) {
          source.close(); controller.abort();
          dispatch({ type: 'terminal', phase: error.body.code === 'invalidStoredState' ? 'unreadable'
            : error.status === 410 ? 'expired' : error.status === 404 ? 'deleted' : 'unavailable', message: errorMessage(error) });
        }
      });
    };
    return () => { controller.abort(); source.close(); stream.current = null; };
  }, [sessionId, state.phase, streamKey]);

  useEffect(() => () => { generation.current += 1; }, []);

  const selectConversation = useCallback(async (slug: string, signal: AbortSignal) => {
    if (signal.aborted || lock.current && !selection.current || state.pending) return;
    const prior = selection.current;
    const version = ++generation.current;
    const epoch = authEpoch();
    const current = () => version === generation.current && epoch === authEpoch();
    lock.current = true;
    stream.current?.close(); stream.current = null;
    dispatch({ type: 'selecting' });
    const request = (async () => {
      await prior?.catch(() => undefined);
      if (!current() || signal.aborted) return;
      // Serialize selection mutations; aborting HTTP cannot undo a server-side chat switch.
      const snapshot = await api.history.continue(slug);
      if (!current() || signal.aborted) return;
      if (snapshot.conversationSlug !== slug || snapshot.sequence < (latest.current?.sequence ?? 0))
        throw new Error('Conversation selection could not be confirmed.');
      latest.current = snapshot;
      dispatch({ type: 'started', snapshot });
      return snapshot;
    })();
    selection.current = request;
    try {
      const snapshot = await request;
      if (!snapshot && current()) dispatch({ type: 'terminal', phase: 'unavailable', message: 'Choose a conversation again to confirm its saved figures.' });
      return snapshot;
    } catch (error) {
      if (current()) {
        try {
          const snapshot = await api.current();
          if (current()) { latest.current = snapshot; dispatch({ type: 'started', snapshot }); }
        } catch {
          if (current()) dispatch({ type: 'terminal', phase: 'unavailable', message: 'Could not open this conversation. Please try again.' });
        }
      }
      throw error;
    } finally {
      if (selection.current === request) { selection.current = null; lock.current = false; }
      if (current()) dispatch({ type: 'busy', busy: false });
    }
  }, [state.pending]);

  const perform = useCallback(async (action: 'start' | 'delete' | 'save', operation?: Command['operation']) => {
    if (lock.current) return;
    if (state.pending && action !== 'save') return;
    if (action === 'save' && !state.pending) {
      if (!operation || state.phase !== 'ready' || state.connection !== 'live') return;
    }
    if (state.pending?.operation.type !== 'replaceFacts' && state.pending && (state.phase !== 'ready' || state.connection !== 'live')) return;
    lock.current = true;
    deleting.current = action === 'delete';
    dispatch({ type: 'busy', busy: true });
    const epoch = generation.current;
    const authentication = authEpoch();
    const current = () => epoch === generation.current && authentication === authEpoch();
    let command: Command | null = null;
    try {
      if (action === 'delete') {
        await api.delete();
        if (current()) {
          stream.current?.close();
          stream.current = null;
          generation.current += 1;
          dispatch({ type: 'deleted' });
        }
      } else if (action === 'start') {
        if (state.phase === 'expired' || state.phase === 'deleted') await api.delete();
        if (!current()) return;
        const snapshot = await api.start();
        if (current()) dispatch({ type: 'started', snapshot });
      } else {
        command = state.pending ?? {
          commandId: crypto.randomUUID(), expectedRevision: state.snapshot!.revision, operation: operation!,
        };
        dispatch({ type: 'pending', command });
        const snapshot = await api.save(command);
        if (current()) { dispatch({ type: 'saved', snapshot }); return snapshot; }
      }
    } catch (error) {
      if (!current()) return;
      dispatch({ type: 'failure', message: errorMessage(error, command?.operation.type),
        uncertain: action === 'save' && (!(error instanceof ApiError) || error.status >= 500 || error.body.code === 'commandConflict'),
        snapshot: error instanceof ApiError ? error.body.snapshot : null,
      });
      if (error instanceof ApiError && [404, 410].includes(error.status)) {
        stream.current?.close();
        stream.current = null;
        dispatch({ type: 'terminal', phase: error.status === 410 ? 'expired' : 'deleted', message: errorMessage(error) });
      }
    } finally {
      lock.current = false;
      deleting.current = false;
      if (current()) dispatch({ type: 'busy', busy: false });
    }
  }, [state]);

  function retryConnection() {
    if (state.busy || lock.current) return;
    if (state.snapshot) {
      dispatch({ type: 'terminal', phase: 'ready', message: '' });
      dispatch({ type: 'connection', connection: 'reconnecting' });
      reconnect();
    } else {
      dispatch({ type: 'busy', busy: true });
      reload();
    }
  }

  return { state, dispatch, perform, retryConnection, selectConversation };
}