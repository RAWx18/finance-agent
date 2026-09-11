// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api, ApiError, authEpoch, errorMessage, exactNumbers, reportAuthLoss } from './api';
import type { Command, FactsInput, Settings, Snapshot } from './api';
import { draftFacts } from './money';

export type State = {
  phase: 'loading' | 'empty' | 'ready' | 'expired' | 'deleted' | 'unavailable' | 'unreadable';
  settings: Settings | null;
  snapshot: Snapshot | null;
  connection: 'connecting' | 'live' | 'reconnecting' | 'closed';
  draft: { facts: FactsInput; baseRevision: number; conflict: boolean } | null;
  pending: Command | null;
  busy: boolean;
  message: string;
  messageKind: 'status' | 'error';
};

export const initialState: State = {
  phase: 'loading', settings: null, snapshot: null, connection: 'closed',
  draft: null, pending: null, busy: false, message: '', messageKind: 'status',
};

type Action =
  | { type: 'loaded'; settings: Settings; snapshot: Snapshot | null }
  | { type: 'settings'; settings: Settings }
  | { type: 'started'; snapshot: Snapshot }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'connection'; connection: State['connection'] }
  | { type: 'terminal'; phase: State['phase']; message: string }
  | { type: 'edit' | 'cancel' | 'useSaved' | 'reconcile' | 'deleted' }
  | { type: 'draft'; facts: FactsInput }
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
    : cleared ? 'Planning assumptions and preview cleared. The reported baseline is shown.' : state.messageKind === 'error' ? '' : state.message, draft: state.draft ? {
    ...state.draft, conflict: state.draft.conflict || snapshot.revision > state.draft.baseRevision,
  } : null };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': return { ...state, settings: action.settings, snapshot: action.snapshot, phase: action.snapshot ? 'ready' : 'empty', message: '', messageKind: 'status' };
    case 'settings': return { ...state, settings: action.settings };
    case 'started': return state.snapshot?.sessionId === action.snapshot.sessionId
      ? receive(state, action.snapshot)
      : { ...initialState, settings: state.settings, phase: 'ready', snapshot: action.snapshot, message: 'Your session is saved. Figures will appear as you share them.' };
    case 'snapshot': return receive(state, action.snapshot);
    case 'connection': return { ...state, connection: action.connection };
    case 'terminal': return { ...state, phase: action.phase, connection: 'closed', busy: false, message: action.message, messageKind: 'status' };
    case 'edit':
    case 'useSaved': return state.snapshot && !state.pending ? { ...state, draft: { facts: draftFacts(state.snapshot), baseRevision: state.snapshot.revision, conflict: false }, message: '', messageKind: 'status' } : state;
    case 'cancel': return state.pending ? state : { ...state, draft: null, message: '', messageKind: 'status' };
    case 'draft': return state.draft && !state.pending ? { ...state, draft: { ...state.draft, facts: action.facts } } : state;
    case 'reconcile': return state.draft && state.snapshot && !state.pending ? { ...state, draft: { ...state.draft, baseRevision: state.snapshot.revision, conflict: false }, message: 'Review your draft alongside the saved figures, then save to replace them.', messageKind: 'status' } : state;
    case 'busy': return { ...state, busy: action.busy, message: action.busy ? '' : state.message, messageKind: action.busy ? 'status' : state.messageKind };
    case 'pending': return { ...state, pending: action.command, busy: true, message: '', messageKind: 'status' };
    case 'saved': {
      if (action.snapshot.sessionId !== state.snapshot?.sessionId) return state;
      const operation = state.pending?.operation.type;
      const messages = {
        replaceFacts: `Your figures are saved. ${action.snapshot.accepted?.adjustments.length ?? 0} planning assumption(s) remain saved; ${action.snapshot.invalidatedAssumptions?.length ?? 0} need fresh consent. The preview is cleared.`,
        previewAdjustments: 'Preview ready to review. Your saved projection has not changed.',
        acceptPreview: 'Planning assumptions saved. No payments or account changes have been made.',
        discardPreview: 'Preview rejected. Your saved projection has not changed.',
        clearAccepted: 'Planning assumptions and preview cleared. The reported baseline is shown.',
        respondToAction: 'Your answer is saved.',
      };
      return { ...receive(state, action.snapshot), pending: null,
        draft: operation === 'replaceFacts' ? null : state.draft, busy: false,
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

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const settings = await api.settings(controller.signal);
        let snapshot: Snapshot | null = null;
        try { snapshot = await api.current(controller.signal); }
        catch (error) {
          if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 410)) throw error;
          if (error.status === 410) {
            if (!controller.signal.aborted) {
              dispatch({ type: 'loaded', settings, snapshot: null });
              dispatch({ type: 'terminal', phase: 'expired', message: errorMessage(error) });
            }
            return;
          }
        }
        if (!controller.signal.aborted) dispatch({ type: 'loaded', settings, snapshot });
      } catch (error) {
        if (!controller.signal.aborted) dispatch({ type: 'terminal',
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
    stream.current = source;
    dispatch({ type: 'connection', connection: 'connecting' });
    source.onopen = () => dispatch({ type: 'connection', connection: 'live' });
    source.addEventListener('snapshot', (event) => {
      if (controller.signal.aborted || epoch !== authEpoch()) return;
      try {
        const snapshot = JSON.parse((event as MessageEvent<string>).data, exactNumbers) as Snapshot;
        dispatch({ type: 'snapshot', snapshot });
      } catch {
        source.close();
        dispatch({ type: 'terminal', phase: 'unavailable', message: 'The saved figures could not be read safely. Retry the connection.' });
      }
    });
    for (const name of ['unauthenticated', 'sessionExpired', 'authUnavailable'] as const) {
      source.addEventListener(name, () => {
        if (controller.signal.aborted) return;
        source.close(); controller.abort();
        reportAuthLoss(name, epoch);
      });
    }
    for (const name of ['expired', 'deleted', 'notFound', 'unavailable'] as const) {
      source.addEventListener(name, () => {
        source.close();
        dispatch({ type: 'terminal', phase: name === 'notFound' ? 'deleted' : name,
          message: name === 'unavailable' ? 'Live updates are unavailable. Your draft is still here.'
            : name === 'expired' ? 'This projection has expired. Start again with fresh figures.'
              : 'This projection was deleted or is no longer available.',
        });
      });
    }
    source.onerror = () => {
      if (controller.signal.aborted || epoch !== authEpoch()) { source.close(); return; }
      dispatch({ type: 'connection', connection: 'reconnecting' });
      // EventSource hides HTTP errors; this one-off check distinguishes a terminal session from a dropped stream.
      void api.current(controller.signal).then((snapshot) => {
        if (!controller.signal.aborted) dispatch({ type: 'snapshot', snapshot });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && ([404, 410, 503, 429].includes(error.status) || error.body.code === 'invalidStoredState')) {
          source.close();
          dispatch({ type: 'terminal', phase: error.body.code === 'invalidStoredState' ? 'unreadable'
            : error.status === 410 ? 'expired' : error.status === 404 ? 'deleted' : 'unavailable', message: errorMessage(error) });
        }
      });
    };
    return () => { controller.abort(); source.close(); stream.current = null; };
  }, [sessionId, state.phase, streamKey]);

  useEffect(() => () => { generation.current += 1; }, []);

  const perform = useCallback(async (action: 'start' | 'delete' | 'save', operation?: Command['operation']) => {
    if (lock.current) return;
    if (state.pending && action !== 'save') return;
    if (action === 'save' && !state.pending) {
      if (state.phase !== 'ready') return;
      if (operation && (state.draft || state.connection !== 'live')) return;
      if (!operation && (!state.draft || state.draft.conflict)) return;
    }
    if (state.pending?.operation.type !== 'replaceFacts' && state.pending && (state.phase !== 'ready' || state.connection !== 'live')) return;
    lock.current = true;
    dispatch({ type: 'busy', busy: true });
    const epoch = generation.current;
    let command: Command | null = null;
    try {
      if (action === 'delete') {
        await api.delete();
        if (epoch === generation.current) {
          stream.current?.close();
          generation.current += 1;
          dispatch({ type: 'deleted' });
        }
      } else if (action === 'start') {
        if (state.phase === 'expired' || state.phase === 'deleted') await api.delete();
        const snapshot = await api.start();
        if (epoch === generation.current) dispatch({ type: 'started', snapshot });
      } else {
        command = state.pending ?? {
          commandId: crypto.randomUUID(), expectedRevision: operation ? state.snapshot!.revision : state.draft!.baseRevision,
          operation: operation ?? { type: 'replaceFacts' as const, facts: state.draft!.facts },
        };
        dispatch({ type: 'pending', command });
        const snapshot = await api.save(command);
        if (epoch === generation.current) dispatch({ type: 'saved', snapshot });
      }
    } catch (error) {
      if (epoch !== generation.current) return;
      dispatch({ type: 'failure', message: errorMessage(error, command?.operation.type),
        uncertain: action === 'save' && (!(error instanceof ApiError) || error.status >= 500 || error.body.code === 'commandConflict'),
        snapshot: error instanceof ApiError ? error.body.snapshot : null,
      });
      if (error instanceof ApiError && [404, 410].includes(error.status)) {
        stream.current?.close();
        dispatch({ type: 'terminal', phase: error.status === 410 ? 'expired' : 'deleted', message: errorMessage(error) });
      }
    } finally {
      lock.current = false;
      if (epoch === generation.current) dispatch({ type: 'busy', busy: false });
    }
  }, [state]);

  function retryConnection() {
    if (state.snapshot) {
      dispatch({ type: 'terminal', phase: 'ready', message: '' });
      reconnect();
    } else reload();
  }

  return { state, dispatch, perform, retryConnection };
}