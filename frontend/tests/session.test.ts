// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Command } from '../src/api';
import { draftFacts } from '../src/money';
import { initialState, reducer } from '../src/session';
import { scenario, settings, snapshot } from './fixtures';

describe('session snapshot and command reducer', () => {
  it('hides the previous workspace throughout selection and rejects its late snapshots after switching', () => {
    const a = { ...snapshot(), conversationSlug: 'chat-a', sequence: 5, revision: 3 };
    const b = { ...snapshot(), sessionId: 'chat-b-session', conversationSlug: 'chat-b', sequence: 6, revision: 4 };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: a });
    state = reducer(state, { type: 'connection', connection: 'live' });
    state = reducer(state, { type: 'selecting' });
    expect(state.snapshot).toBeNull(); expect(state.connection).toBe('closed'); expect(state.busy).toBe(true);
    expect(reducer(state, { type: 'snapshot', snapshot: { ...a, sequence: 7 } })).toBe(state);
    state = reducer(state, { type: 'started', snapshot: b });
    expect(state.snapshot).toBe(b); expect(state.connection).toBe('closed'); expect(state.busy).toBe(false);
    expect(reducer(state, { type: 'snapshot', snapshot: { ...a, sequence: 8 } })).toBe(state);
  });

  it.each<{ operation: Command['operation']; message: string }>([
    { operation: { type: 'replaceFacts', facts: draftFacts(snapshot()) },
      message: 'Your figures are saved. 1 planning assumption(s) remain saved; 0 need fresh consent. The preview is cleared.' },
    { operation: { type: 'updateFacts', changes: { expectedRevision: 1, opening: { amount: '20', status: 'exact' } } },
      message: 'Your corrections are saved. 1 planning assumption(s) remain saved; 0 need fresh consent. The preview is cleared.' },
    { operation: { type: 'rejectPreview', previewId: 'preview-one' },
      message: 'Your decision not to use this proposal is saved. No payments or account changes have been made.' },
  ])('confirms $operation.type after an uncertain save using the returned snapshot', ({ operation, message }) => {
    const saved = { ...snapshot(), revision: 1, sequence: 2, accepted: scenario('accepted'), preview: scenario() };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'pending', command: { commandId: 'confirmation', expectedRevision: 1, operation } });
    state = reducer(state, { type: 'failure', uncertain: true, message: 'Your save is not confirmed.' });
    const confirmed = { ...saved, revision: 2, sequence: 3, preview: null,
      facts: operation.type === 'updateFacts' ? { ...saved.facts, opening: { amountPaise: 2000, status: 'exact' as const } } : saved.facts,
      rejectedProposals: operation.type === 'rejectPreview' ? [{ id: saved.preview.id, adjustments: saved.preview.adjustments }] : [],
    };
    state = reducer(state, { type: 'saved', snapshot: confirmed });
    expect(state.snapshot).toBe(confirmed);
    expect(state.snapshot?.accepted).toBe(saved.accepted);
    expect(state.pending).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.messageKind).toBe('status');
    expect(state.message).toBe(message);
  });
  it('reports a saved correction without granting fresh consent or inventing results', () => {
    const saved = { ...snapshot(), revision: 1, sequence: 2, accepted: scenario('accepted'), preview: scenario() };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'pending', command: { commandId: 'correction', expectedRevision: 1,
      operation: { type: 'updateFacts', changes: { expectedRevision: 1, opening: { amount: '20', status: 'exact' } } } } });
    const corrected = { ...saved, revision: 2, sequence: 3, preview: null, accepted: null,
      invalidatedAssumptions: [{ eventId: 'optional:2026-09-27', reason: 'Confirm a fresh proposal.' }] };
    state = reducer(state, { type: 'saved', snapshot: corrected });
    expect(state.snapshot).toBe(corrected);
    expect(state.pending).toBeNull();
    expect(state.message).toBe('Your corrections are saved. 0 planning assumption(s) remain saved; 1 need fresh consent. The preview is cleared.');
    expect(state.messageKind).toBe('status');
  });
  it('reports an explicit proposal rejection while preserving previously accepted assumptions', () => {
    const saved = { ...snapshot(), revision: 1, sequence: 2, accepted: scenario('accepted'), preview: scenario() };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'pending', command: { commandId: 'rejection', expectedRevision: 1,
      operation: { type: 'rejectPreview', previewId: saved.preview.id } } });
    const rejected = { ...saved, revision: 2, sequence: 3, preview: null,
      rejectedProposals: [{ id: saved.preview.id, adjustments: saved.preview.adjustments }] };
    state = reducer(state, { type: 'saved', snapshot: rejected });
    expect(state.snapshot).toBe(rejected);
    expect(state.snapshot?.accepted).toBe(saved.accepted);
    expect(state.pending).toBeNull();
    expect(state.message).toBe('Your decision not to use this proposal is saved. No payments or account changes have been made.');
    expect(state.messageKind).toBe('status');
  });
  it('clears a known failed command but preserves its preview, facts and saved consent until an explicit discard', () => {
    const accepted = scenario('accepted'); accepted.adjustments[0].acceptedRevision = 1;
    const saved = { ...snapshot(), revision: 1, sequence: 2, accepted, preview: scenario() };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'pending', command: { commandId: 'answer', expectedRevision: saved.revision,
      operation: { type: 'respondToAction', actionId: 'preview-spending', response: 'declined' } } });
    state = reducer(state, { type: 'failure', message: 'Review the open proposal first.', snapshot: structuredClone(saved) });
    state = reducer(state, { type: 'busy', busy: false });
    expect(state.pending).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.snapshot).toBe(saved);
    expect(state.snapshot?.accepted?.adjustments[0].acceptedRevision).toBe(1);
    expect(state.messageKind).toBe('error');
    expect(state.message).toBe('Review the open proposal first.');

    state = reducer(state, { type: 'busy', busy: true });
    expect(state.message).toBe('');
    expect(state.messageKind).toBe('status');
    state = reducer(state, { type: 'pending', command: { commandId: 'discard', expectedRevision: saved.revision,
      operation: { type: 'discardPreview', previewId: saved.preview.id } } });
    state = reducer(state, { type: 'saved', snapshot: { ...saved, sequence: 3, preview: null } });
    expect(state.pending).toBeNull();
    expect(state.messageKind).toBe('status');
    expect(state.snapshot?.facts).toEqual(saved.facts);
    expect(state.snapshot?.accepted).toEqual(accepted);
    expect(state.snapshot?.plan).toEqual(saved.plan);
    expect(state.snapshot?.preview).toBeNull();
    expect(state.snapshot?.facts.decision?.responses ?? []).toEqual([]);
  });
  it('clears failure guidance only for a newer same-session snapshot, retaining an uncertain command', () => {
    const saved = { ...snapshot(), sequence: 2 };
    const command = { commandId: 'answer', expectedRevision: saved.revision,
      operation: { type: 'respondToAction' as const, actionId: 'clarify:opening', response: 'unavailable' as const } };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'pending', command });
    state = reducer(state, { type: 'failure', message: 'Check the outcome before retrying.', uncertain: true });
    state = reducer(state, { type: 'connection', connection: 'live' });
    expect(state.messageKind).toBe('error');
    for (const value of [saved, { ...saved, sequence: 1 }, { ...saved, sessionId: 'another', sequence: 3 }])
      expect(reducer(state, { type: 'snapshot', snapshot: value })).toBe(state);
    state = reducer(state, { type: 'snapshot', snapshot: { ...saved, sequence: 3 } });
    expect(state.messageKind).toBe('status');
    expect(state.message).toBe('');
    expect(state.pending).toBe(command);
  });
  it('applies a clock refresh without changing facts or their revision', () => {
    const saved = { ...snapshot(), revision: 2, sequence: 3 };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    const refreshed = { ...saved, sequence: 4, plan: { ...saved.plan, evaluatedOn: '2026-09-12',
      decisionAssessment: { ...saved.plan.decisionAssessment, nextQuestionId: null, nextActionId: 'reconcile',
        actions: [{ id: 'reconcile', kind: 'reconcileStatus' as const, recordIds: [], beforeDate: '2026-09-12',
          question: 'Confirm which elapsed commitments remain unpaid.', consequenceIds: [], ifDeclinedConsequenceIds: [] }] } } };
    state = reducer(state, { type: 'snapshot', snapshot: refreshed });
    expect(state.snapshot?.plan.evaluatedOn).toBe('2026-09-12');
    expect(state.snapshot?.plan.decisionAssessment?.nextActionId).toBe('reconcile');
    expect(state.snapshot?.facts).toEqual(saved.facts);
    expect(state.snapshot?.revision).toBe(2);
    expect(reducer(state, { type: 'snapshot', snapshot: saved })).toBe(state);
    expect(reducer(state, { type: 'snapshot', snapshot: refreshed })).toBe(state);
  });
  it('applies sequence-only previews and replacements without changing baseline or accepted assumptions', () => {
    const saved = { ...snapshot(), accepted: scenario('accepted') };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'snapshot', snapshot: { ...saved, sequence: 1, preview: scenario() } });
    state = reducer(state, { type: 'snapshot', snapshot: { ...saved, sequence: 2, preview: scenario('replacement') } });
    expect(state.snapshot?.revision).toBe(0);
    expect(state.snapshot?.preview?.id).toBe('replacement');
    expect(state.snapshot?.accepted).toEqual(saved.accepted);
    expect(state.snapshot?.facts).toEqual(saved.facts);
    expect(state.snapshot?.plan).toEqual(saved.plan);
  });
  it('does not restore accepted assumptions or claim a superseded save is current', () => {
    const accepted = { ...snapshot(), revision: 1, sequence: 2, accepted: scenario() };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: accepted });
    state = reducer(state, { type: 'pending', command: { commandId: 'accept', expectedRevision: 0, operation: { type: 'acceptPreview', previewId: 'preview-one', confirmed: true, consentScope: 'unconditional' } } });
    state = reducer(state, { type: 'snapshot', snapshot: { ...snapshot(), revision: 2, sequence: 3 } });
    expect(state.message).toBe('Planning assumptions and preview cleared. The reported baseline is shown.');
    state = reducer(state, { type: 'saved', snapshot: accepted });
    expect(state.snapshot?.accepted).toBeUndefined();
    expect(state.snapshot?.sequence).toBe(3);
    expect(state.message).toContain('later changes superseded');
    expect(state.pending).toBeNull();
  });
  it('clears a corrected preview while retaining unaffected accepted occurrences and explaining fresh consent', () => {
    const accepted = scenario('accepted');
    accepted.adjustments[0].acceptedRevision = 1;
    const saved = { ...snapshot(), revision: 1, sequence: 2, accepted, preview: scenario() };
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'pending', command: { commandId: 'correct', expectedRevision: 1,
      operation: { type: 'updateFacts', changes: { expectedRevision: 1, opening: { amount: '20.10', status: 'exact' } } } } });
    const corrected = { ...saved, revision: 2, sequence: 3, preview: null };
    state = reducer(state, { type: 'saved', snapshot: corrected });
    expect(state.snapshot?.accepted).toEqual(accepted);
    expect(state.snapshot?.preview).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.message).toBe('Your corrections are saved. 1 planning assumption(s) remain saved; 0 need fresh consent. The preview is cleared.');
  });
  it('reports affected occurrences without clearing unaffected assumptions on a live correction', () => {
    const accepted = scenario('accepted');
    accepted.adjustments[0].acceptedRevision = 1;
    const saved = { ...snapshot(), revision: 1, sequence: 2, accepted, preview: scenario() };
    const affected = { ...accepted.adjustments[0], eventId: 'other:2026-09-27', recordId: 'other', label: 'Other purchase' };
    let state = reducer(initialState, { type: 'loaded', settings,
      snapshot: { ...saved, accepted: { ...accepted, adjustments: [...accepted.adjustments, affected] } } });
    const corrected = { ...saved, revision: 2, sequence: 3, preview: null,
      invalidatedAssumptions: [{ eventId: affected.eventId, reason: 'Occurrence terms changed; confirm a fresh proposal.' }] };
    state = reducer(state, { type: 'snapshot', snapshot: corrected });
    expect(state.snapshot?.accepted).toEqual(accepted);
    expect(state.snapshot?.preview).toBeNull();
    expect(state.snapshot?.invalidatedAssumptions).toEqual(corrected.invalidatedAssumptions);
    expect(state.message).toBe('1 planning assumption(s) need fresh consent. 1 remain saved.');
    expect(reducer(state, { type: 'snapshot', snapshot: saved })).toBe(state);
  });
  it('ignores old sequences, duplicates, and snapshots from another session', () => {
    const saved = { ...snapshot(), revision: 3, sequence: 4 };
    const state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    for (const value of [{ ...saved, sequence: 3 }, saved, { ...saved, sessionId: 'another', sequence: 5 }]) {
      expect(reducer(state, { type: 'snapshot', snapshot: value })).toBe(state);
    }
  });
  it('preserves a pending correction and its base revision during live corrections and reconnects', () => {
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: snapshot() });
    const command: Command = { commandId: 'correction', expectedRevision: 0,
      operation: { type: 'updateFacts', changes: { expectedRevision: 0, opening: { status: 'exact', amount: '20.10' } } } };
    const original = structuredClone(command);
    state = reducer(state, { type: 'pending', command });
    state = reducer(state, { type: 'failure', uncertain: true, message: 'Retry' });
    state = reducer(state, { type: 'connection', connection: 'reconnecting' });
    state = reducer(state, { type: 'snapshot', snapshot: { ...snapshot(), revision: 1, sequence: 1 } });
    expect(state.pending).toBe(command);
    expect(state.pending).toEqual(original);
    expect(state.snapshot?.revision).toBe(1);
    expect(state.snapshot?.facts.opening.amountPaise).toBeNull();
  });
  it('retains an uncertain correction until confirmation without rolling back newer facts', () => {
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: snapshot() });
    const command: Command = { commandId: 'id', expectedRevision: 0,
      operation: { type: 'updateFacts', changes: { expectedRevision: 0, opening: { amount: '20', status: 'exact' } } } };
    state = reducer(state, { type: 'pending', command });
    state = reducer(state, { type: 'failure', uncertain: true, message: 'Retry' });
    expect(state.pending).toBe(command);
    state = reducer(state, { type: 'snapshot', snapshot: { ...snapshot(), sequence: 3, revision: 3 } });
    state = reducer(state, { type: 'saved', snapshot: { ...snapshot(), sequence: 1, revision: 1 } });
    expect(state.snapshot?.revision).toBe(3);
    expect(state.pending).toBeNull();
  });
  it('keeps saved facts on terminal events but explicit deletion clears the session', () => {
    const saved = snapshot();
    let state = reducer(initialState, { type: 'loaded', settings, snapshot: saved });
    state = reducer(state, { type: 'terminal', phase: 'expired', message: 'Expired' });
    expect(state.snapshot).toBe(saved);
    state = reducer(state, { type: 'deleted' });
    expect(state.phase).toBe('empty');
    expect(state.snapshot).toBeNull();
    expect(state.pending).toBeNull();
  });
});