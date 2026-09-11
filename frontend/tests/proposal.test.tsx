// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipecatClient } from '@pipecat-ai/client-js';
import { DailyTransport } from '@pipecat-ai/daily-transport';
import { App, mockAuth } from './appSupport';
import { api } from '../src/api';
import type { Snapshot } from '../src/api';
import { adjustmentOptions, planningSnapshot, scenario, settings, Stream } from './fixtures';

vi.mock('@pipecat-ai/client-js', async original => ({
  ...await original<typeof import('@pipecat-ai/client-js')>(), PipecatClient: vi.fn(),
}));
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: vi.fn() }));

let saved: Snapshot;

beforeEach(() => {
  mockAuth();
  saved = { ...planningSnapshot(), preview: scenario() };
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.mocked(PipecatClient).mockClear();
  vi.mocked(DailyTransport).mockClear();
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'current').mockResolvedValue(saved);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(api, 'options').mockResolvedValue(adjustmentOptions);
  vi.spyOn(api, 'save').mockResolvedValue({ ...saved, sequence: 1, preview: null });
  vi.spyOn(api, 'delete').mockResolvedValue({ deleted: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function review() {
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: /Review saved picture/ }));
  await waitFor(() => expect(Stream.instances).toHaveLength(1));
  return Stream.instances[0];
}

describe('App inline financial actions', () => {
  it('requires live updates and explicit consent before accepting the exact inline proposal', async () => {
    const response = deferred<Snapshot>();
    vi.mocked(api.save).mockReturnValueOnce(response.promise);
    const stream = await review();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    const proposal = within(picture).getByRole('region', { name: 'Spending change preview' });
    const consent = within(proposal).getByRole('checkbox');
    const accept = within(proposal).getByRole('button', { name: 'Accept planning assumptions' });
    const reject = within(proposal).getByRole('button', { name: 'Reject preview' });
    expect(proposal).toBeVisible();
    expect(consent).not.toBeChecked();
    for (const control of [consent, accept, reject]) expect(control).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();

    act(() => stream.onopen?.());
    expect(consent).toBeEnabled();
    expect(reject).toBeEnabled();
    expect(accept).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    expect(within(proposal).getByRole('heading', { name: 'Spending change preview' })).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(consent).toHaveAccessibleName(/including removals, unconditionally—not dependent on uncertain income or payee agreement/);
    await userEvent.click(accept);
    expect(api.save).not.toHaveBeenCalled();
    await userEvent.click(consent);
    expect(accept).toBeEnabled();
    expect(api.save).not.toHaveBeenCalled();
    await userEvent.click(accept);
    expect(api.save).toHaveBeenCalledExactlyOnceWith({
      commandId: expect.any(String), expectedRevision: saved.revision,
      operation: { type: 'acceptPreview', previewId: saved.preview!.id, confirmed: true, consentScope: 'unconditional' },
    });
    expect(consent).not.toBeChecked();
    for (const control of [consent, accept, reject]) expect(control).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    expect(within(picture).getByText('Projected closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹10,000.00');

    const accepted = structuredClone(saved);
    accepted.sequence++; accepted.revision++;
    accepted.accepted = accepted.preview;
    accepted.preview = null;
    for (const adjustment of accepted.accepted!.adjustments) adjustment.acceptedRevision = accepted.revision;
    await act(async () => response.resolve(accepted));
    expect(within(picture).queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    expect(within(picture).getByText('Assumed closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹12,000.00');
    expect(within(picture).getByText('Includes saved assumptions, not completed payments.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled();
    expect(api.options).not.toHaveBeenCalled();
    expect(PipecatClient).not.toHaveBeenCalled();
    expect(DailyTransport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects the inline preview without sending consent or replacing the reported picture', async () => {
    const stream = await review();
    act(() => stream.onopen?.());
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    await userEvent.click(within(proposal).getByRole('button', { name: 'Reject preview' }));
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: saved.revision,
      operation: { type: 'discardPreview', previewId: saved.preview!.id } });
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).getByText('Projected closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹10,000.00');
    expect(within(picture).queryByRole('button', { name: 'Saved planning assumptions' })).not.toBeInTheDocument();
  });

  it.each(['reconnecting', 'unavailable'] as const)('disables reviewed inline actions when updates become %s', async connection => {
    const stream = await review();
    act(() => stream.onopen?.());
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    const consent = within(proposal).getByRole('checkbox');
    const accept = within(proposal).getByRole('button', { name: 'Accept planning assumptions' });
    const reject = within(proposal).getByRole('button', { name: 'Reject preview' });
    await userEvent.click(consent);
    expect(accept).toBeEnabled();
    act(() => {
      if (connection === 'reconnecting') stream.onerror?.();
      else stream.emit('unavailable', { code: 'unavailable', message: 'Updates unavailable' });
    });
    expect(proposal).toBeVisible();
    for (const control of [consent, accept, reject]) {
      expect(control).toBeDisabled();
      await userEvent.click(control);
    }
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('hides the background proposal in Your figures and requires fresh consent on each review surface', async () => {
    const stream = await review();
    act(() => stream.onopen?.());
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    const consent = within(proposal).getByRole('checkbox');
    await userEvent.click(consent);
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    expect(proposal).not.toBeVisible();
    expect(consent).not.toBeChecked();
    expect(consent).toBeDisabled();
    expect(proposal.closest('.journey-layout')!.querySelector('button.detail-button')).not.toBeVisible();
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    await userEvent.click(figures.getByRole('button', { name: 'Spending changes' }));
    const comparison = figures.getByRole('region', { name: 'Spending change preview' });
    expect(within(comparison).getByRole('checkbox')).not.toBeChecked();
    await userEvent.click(within(comparison).getByRole('checkbox'));
    expect(within(comparison).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(figures.getByRole('link', { name: 'Back to conversation' }));
    expect(proposal).toBeVisible();
    expect(consent).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    expect(within(comparison).getByRole('checkbox')).not.toBeChecked();
    expect(within(comparison).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('keeps inline actions locked by a dismissed draft until the draft is discarded', async () => {
    const stream = await review();
    act(() => stream.onopen?.());
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    await userEvent.click(figures.getByRole('button', { name: 'Edit figures' }));
    const cash = figures.getByRole('textbox', { name: 'Available cash (₹)' });
    await userEvent.clear(cash);
    await userEvent.type(cash, '6000');
    await userEvent.click(figures.getByRole('link', { name: 'Back to conversation' }));
    expect(proposal).toBeVisible();
    expect(within(proposal).getByRole('checkbox')).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeDisabled();
    await userEvent.click(within(proposal).getByRole('button', { name: 'Reject preview' }));
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Review your draft' }));
    expect(cash).toHaveValue('6000');
    await userEvent.click(figures.getByRole('button', { name: 'Discard draft' }));
    await userEvent.click(figures.getByRole('link', { name: 'Back to conversation' }));
    expect(within(proposal).getByRole('checkbox')).toBeEnabled();
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeEnabled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('locks inline actions during deletion after returning from Your figures with no command pending', async () => {
    const response = deferred<Awaited<ReturnType<typeof api.delete>>>();
    vi.mocked(api.delete).mockReturnValueOnce(response.promise);
    const stream = await review();
    act(() => stream.onopen?.());
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    await userEvent.click(figures.getByRole('button', { name: 'Delete plan' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Delete this plan?' }))
      .getByRole('button', { name: 'Delete saved figures and draft' }));
    expect(api.delete).toHaveBeenCalledOnce();
    await userEvent.click(figures.getByRole('link', { name: 'Back to conversation' }));
    expect(proposal).toBeVisible();
    expect(within(proposal).getByRole('checkbox')).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
    await act(async () => response.resolve({ deleted: true }));
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
  });

  it('requires fresh inline consent after a newer proposal and ignores older snapshots', async () => {
    const stream = await review();
    act(() => stream.onopen?.());
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    const consent = within(proposal).getByRole('checkbox');
    await userEvent.click(consent);
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    const corrected = structuredClone(saved);
    corrected.sequence++;
    corrected.preview = scenario('replacement');
    corrected.preview.plan.closingPaise = 234567;
    act(() => stream.emit('snapshot', corrected));
    expect(consent).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    act(() => stream.emit('snapshot', saved));
    expect(consent).not.toBeChecked();
    expect(within(proposal).getByRole('region', { name: 'After · preview' })).toHaveTextContent('₹2,345.67');
    expect(api.save).not.toHaveBeenCalled();
    vi.mocked(api.save).mockResolvedValueOnce({ ...corrected, revision: 1, sequence: 2, accepted: corrected.preview, preview: null });
    await userEvent.click(consent);
    await userEvent.click(within(proposal).getByRole('button', { name: 'Accept planning assumptions' }));
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: corrected.revision,
      operation: { type: 'acceptPreview', previewId: 'replacement', confirmed: true, consentScope: 'unconditional' } });
  });

  it('retries an unavailable answer inside Overview and outside Your figures with the identical command and body', async () => {
    saved.plan.decisionAssessment = { ...saved.plan.decisionAssessment,
      actions: [{ id: 'verifyRent', kind: 'verifyTerms', question: 'Can you confirm the reported Rent terms?',
        recordIds: ['rent'], beforeDate: null, consequenceIds: [], ifDeclinedConsequenceIds: [] }],
      nextActionId: 'verifyRent',
    };
    const response = deferred<Snapshot>();
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'))
      .mockRejectedValueOnce(new TypeError('Response lost again')).mockReturnValueOnce(response.promise);
    const stream = await review();
    act(() => stream.onopen?.());
    await userEvent.click(screen.getByRole('button', { name: 'Return to conversation' }));
    const answer = screen.getByRole('button', { name: 'I cannot confirm this now' });
    await userEvent.click(answer);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same action' })).toBeEnabled());
    const command = vi.mocked(api.save).mock.calls[0][0];
    const body = JSON.stringify(command);
    expect(command).toEqual({ commandId: expect.any(String), expectedRevision: saved.revision,
      operation: { type: 'respondToAction', actionId: 'verifyRent', response: 'unavailable' } });
    expect(answer).toBeDisabled();
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(within(proposal).getByRole('checkbox')).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeDisabled();
    expect(screen.getByText('Your action is not confirmed. Retry the same action before making another change.')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    expect(figures.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(figures.getByRole('button', { name: 'Edit figures' })).toBeDisabled();
    expect(figures.queryByRole('region', { name: 'Spending changes' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry same action' })).toHaveLength(1);
    await userEvent.click(figures.getByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(figures.getByRole('button', { name: 'Retry same action' })).toBeEnabled());
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    await userEvent.click(figures.getByRole('link', { name: 'Back to conversation' }));

    const corrected = structuredClone(saved);
    corrected.sequence = 2; corrected.revision = 2;
    corrected.preview = { ...scenario('replacement'), sourceRevision: 2 };
    corrected.preview.plan.closingPaise = 234567;
    corrected.plan.decisionAssessment!.actions![0].id = 'verifyCurrentTerms';
    corrected.plan.decisionAssessment!.nextActionId = 'verifyCurrentTerms';
    act(() => stream.emit('snapshot', corrected));
    expect(answer).toBeDisabled();
    const retry = screen.getByRole('button', { name: 'Retry same action' });
    expect(screen.queryByRole('dialog', { name: 'Your figures' })).not.toBeInTheDocument();
    act(() => stream.onerror?.());
    expect(retry).toBeDisabled();
    await userEvent.click(retry);
    expect(api.save).toHaveBeenCalledTimes(2);
    act(() => stream.onopen?.());
    await userEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(api.save).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.save).mock.calls[2][0]).toBe(command);
    expect(vi.mocked(api.save).mock.calls.map(([value]) => JSON.stringify(value))).toEqual([body, body, body]);
    await act(async () => response.resolve({ ...saved, revision: 1, sequence: 1, preview: null }));
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(answer).toBeEnabled();
    expect(within(proposal).getByRole('region', { name: 'After · preview' })).toHaveTextContent('₹2,345.67');
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('checkbox')).toBeEnabled();
    expect(api.options).not.toHaveBeenCalled();
    expect(PipecatClient).not.toHaveBeenCalled();
    expect(DailyTransport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});