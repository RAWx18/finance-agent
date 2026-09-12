// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipecatClient } from '@pipecat-ai/client-js';
import { DailyTransport } from '@pipecat-ai/daily-transport';
import { appRouter, mockAuth } from './appSupport';
import { api } from '../src/api';
import type { Snapshot } from '../src/api';
import { adjustmentOptions, planningSnapshot, scenario, settings, Stream } from './fixtures';
import { projectWorkspace } from './workspace';

vi.mock('@pipecat-ai/client-js', async original => ({
  ...await original<typeof import('@pipecat-ai/client-js')>(), PipecatClient: vi.fn(),
}));
vi.mock('@pipecat-ai/daily-transport', () => ({ DailyTransport: vi.fn() }));

let saved: Snapshot;

beforeEach(() => {
  mockAuth();
  saved = projectWorkspace({ ...planningSnapshot(), preview: scenario() });
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.mocked(PipecatClient).mockClear();
  vi.mocked(DailyTransport).mockClear();
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'current').mockResolvedValue(saved);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(api, 'options').mockResolvedValue(adjustmentOptions);
  vi.spyOn(api, 'save').mockResolvedValue(projectWorkspace({ ...saved, sequence: 1, preview: null }));
  vi.spyOn(api, 'delete').mockResolvedValue({ deleted: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function review(router = appRouter()) {
  projectWorkspace(saved);
  render(<RouterProvider router={router} />);
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
    expect(consent).toBeDisabled();
    act(() => stream.emit('snapshot', saved));
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
    expect(within(picture).getByRole('article', { name: 'Dated cash requirements' })).toHaveTextContent('₹10,000.00');

    const accepted = structuredClone(saved);
    accepted.sequence++; accepted.revision++;
    accepted.accepted = accepted.preview;
    accepted.preview = null;
    for (const adjustment of accepted.accepted!.adjustments) adjustment.acceptedRevision = accepted.revision;
    await act(async () => response.resolve(projectWorkspace(accepted)));
    expect(within(picture).queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    expect(within(picture).getByRole('article', { name: 'Dated cash requirements' })).toHaveTextContent('₹12,000.00');
    expect(within(picture).getByRole('article', { name: /Accepted planning assumptions/ })).toHaveTextContent('Accepted does not mean paid');
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled();
    expect(api.options).not.toHaveBeenCalled();
    expect(PipecatClient).not.toHaveBeenCalled();
    expect(DailyTransport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects the inline preview without sending consent or replacing the reported picture', async () => {
    const stream = await review();
    act(() => stream.emit('snapshot', saved));
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    await userEvent.click(within(proposal).getByRole('button', { name: 'Reject preview' }));
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: saved.revision,
      operation: { type: 'rejectPreview', previewId: saved.preview!.id } });
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(within(picture).getByRole('article', { name: 'Dated cash requirements' })).toHaveTextContent('₹10,000.00');
    expect(within(picture).queryByRole('article', { name: /Accepted planning assumptions/ })).not.toBeInTheDocument();
  });

  it.each(['reconnecting', 'unavailable'] as const)('disables reviewed inline actions when updates become %s', async connection => {
    const stream = await review();
    act(() => stream.emit('snapshot', saved));
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

  it('hides the background proposal in Money and requires fresh consent on each review surface', async () => {
    const stream = await review();
    act(() => stream.emit('snapshot', saved));
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    const consent = within(proposal).getByRole('checkbox');
    await userEvent.click(consent);
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' }));
    expect(proposal).not.toBeVisible();
    expect(consent).not.toBeChecked();
    expect(consent).toBeDisabled();
    expect(within(proposal.closest('.journey-layout') as HTMLElement).getByRole('button', { name: 'Review proposed change', hidden: true })).not.toBeVisible();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Money navigation' })).getByRole('link', { name: 'Plan changes' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/money/changes');
    const comparison = within(screen.getByRole('region', { name: 'Plan changes content' })).getByRole('region', { name: 'Spending change preview' });
    expect(within(comparison).getByRole('checkbox')).not.toBeChecked();
    await userEvent.click(within(comparison).getByRole('checkbox'));
    expect(within(comparison).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    expect(proposal).toBeVisible();
    expect(consent).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' }));
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Money navigation' })).getByRole('link', { name: 'Plan changes' }));
    expect(within(comparison).getByRole('checkbox')).not.toBeChecked();
    expect(within(comparison).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('protects an active focused correction from navigation and resets inline consent after discarding', async () => {
    const router = appRouter();
    const stream = await review(router);
    act(() => stream.emit('snapshot', saved));
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    await userEvent.click(within(proposal).getByRole('checkbox'));
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' }));
    await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
    const correction = screen.getByRole('dialog', { name: /Correct cash on/ });
    const cash = within(correction).getByRole('textbox', { name: 'Amount (₹)' });
    await userEvent.clear(cash);
    await userEvent.type(cash, '6000');
    await act(async () => { await router.navigate('/app'); });
    expect(router.state.location.pathname).toBe('/money');
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/money');
    expect(correction).toBeVisible();
    expect(proposal).not.toBeVisible();
    const consent = within(proposal).getByRole('checkbox', { hidden: true });
    expect(consent).not.toBeChecked();
    expect(consent).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions', hidden: true })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview', hidden: true })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Finish your correction' })).toHaveTextContent('Save or discard the correction before leaving Money.');
    expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' })).toHaveAccessibleDescription('Unsaved corrections');
    expect(cash).toHaveValue('6000');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await userEvent.click(within(correction).getByRole('button', { name: /Close correct cash/ }));
    expect(correction).toHaveTextContent('Discard this unsaved correction? Your saved plan stays unchanged.');
    await userEvent.click(within(correction).getByRole('button', { name: 'Keep editing' }));
    expect(cash).toHaveValue('6000');
    expect(within(correction).getByRole('button', { name: 'Save correction' })).toBeEnabled();
    await userEvent.click(within(correction).getByRole('button', { name: /Close correct cash/ }));
    await userEvent.click(within(correction).getByRole('button', { name: 'Discard correction' }));
    expect(screen.queryByRole('dialog', { name: /Correct cash on/ })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Money in this plan' })).toHaveTextContent('₹5,000.00');
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app');
    expect(proposal).toBeVisible();
    expect(within(proposal).getByRole('checkbox')).toBeEnabled();
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeEnabled();
    expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' })).not.toHaveAccessibleDescription();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('locks inline actions during deletion after returning from Money with no command pending', async () => {
    const response = deferred<Awaited<ReturnType<typeof api.delete>>>();
    vi.mocked(api.delete).mockReturnValueOnce(response.promise);
    const stream = await review();
    act(() => stream.emit('snapshot', saved));
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' }));
    await userEvent.click(screen.getByRole('button', { name: 'Plan tools' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Plan tools' })).getByRole('button', { name: 'Delete plan' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Delete this plan?' }))
      .getByRole('button', { name: 'Delete plan' }));
    expect(api.delete).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
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
    act(() => stream.emit('snapshot', saved));
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
    const after = within(proposal).getByRole('region', { name: 'After · preview' });
    await userEvent.click(within(after).getByText('More calculated results', { selector: 'summary' }));
    expect(within(after).getByText('Assumed closing cash').parentElement).toHaveTextContent('₹2,345.67');
    expect(within(after).getByText('Assumed closing cash').parentElement).toBeVisible();
    expect(api.save).not.toHaveBeenCalled();
    vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace({ ...corrected, revision: 1, sequence: 2, accepted: corrected.preview, preview: null }));
    await userEvent.click(consent);
    await userEvent.click(within(proposal).getByRole('button', { name: 'Accept planning assumptions' }));
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ commandId: expect.any(String), expectedRevision: corrected.revision,
      operation: { type: 'acceptPreview', previewId: 'replacement', confirmed: true, consentScope: 'unconditional' } });
  });

  it('retries an unavailable answer outside Money content with the identical command and body', async () => {
    saved.plan.decisionAssessment = { ...saved.plan.decisionAssessment,
      actions: [{ id: 'verifyRent', kind: 'verifyTerms', question: 'Can you confirm the reported Rent terms?',
        recordIds: ['rent'], beforeDate: null, consequenceIds: [], ifDeclinedConsequenceIds: [] }],
      nextActionId: 'verifyRent',
    };
    const response = deferred<Snapshot>();
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Response lost'))
      .mockRejectedValueOnce(new TypeError('Response lost again')).mockReturnValueOnce(response.promise);
    const stream = await review();
    act(() => stream.emit('snapshot', saved));
    await userEvent.click(screen.getByRole('button', { name: 'Return to conversation' }));
    const answer = screen.getByRole('button', { name: 'I cannot confirm this now' });
    await userEvent.click(answer);
    const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
    await waitFor(() => expect(within(notice).getByRole('button', { name: 'Retry same action' })).toBeEnabled());
    const command = vi.mocked(api.save).mock.calls[0][0];
    const body = JSON.stringify(command);
    expect(command).toEqual({ commandId: expect.any(String), expectedRevision: saved.revision,
      operation: { type: 'respondToAction', actionId: 'verifyRent', response: 'unavailable' } });
    expect(answer).toBeDisabled();
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(within(proposal).getByRole('checkbox')).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeDisabled();
    expect(notice).toBeVisible();
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Save not confirmed' })).toBe(notice);
    expect(within(screen.getByRole('region', { name: 'Your financial picture' })).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByText('Your action is not confirmed. Retry the same action before making another change.')).not.toBeInTheDocument();

    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' }));
    const money = within(screen.getByRole('region', { name: 'Money content' }));
    expect(screen.getByRole('main')).toHaveAttribute('data-route', '/money');
    expect(within(screen.getByRole('navigation', { name: 'Money navigation' })).getByRole('link', { name: 'Money' })).toHaveAttribute('aria-current', 'page');
    expect(money.getByRole('button', { name: 'Correct starting cash' })).toBeDisabled();
    expect(money.getByRole('button', { name: 'I cannot confirm this now' })).toBeDisabled();
    expect(money.queryByRole('region', { name: 'Custom changes' })).not.toBeInTheDocument();
    expect(money.queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
    expect(money.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' })).toBeEnabled());
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
    await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));

    const corrected = structuredClone(saved);
    corrected.sequence = 2; corrected.revision = 2;
    corrected.preview = { ...scenario('replacement'), sourceRevision: 2 };
    corrected.preview.plan.closingPaise = 234567;
    corrected.plan.decisionAssessment!.actions![0].id = 'verifyCurrentTerms';
    corrected.plan.decisionAssessment!.nextActionId = 'verifyCurrentTerms';
    act(() => stream.emit('snapshot', corrected));
    expect(screen.getByRole('button', { name: 'I cannot confirm this now' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => stream.onerror?.());
    expect(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' })).toBeDisabled();
    await userEvent.click(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' }));
    expect(api.save).toHaveBeenCalledTimes(2);
    act(() => stream.onopen?.());
    expect(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' })).toBeDisabled();
    act(() => stream.emit('snapshot', saved));
    expect(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' })).toBeDisabled();
    act(() => stream.emit('snapshot', corrected));
    await waitFor(() => expect(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' })).toBeEnabled());
    await userEvent.click(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(within(screen.getByRole('alert', { name: 'Save not confirmed' })).getByRole('button', { name: 'Retry same action' })).toBeDisabled());
    expect(api.save).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.save).mock.calls[2][0]).toBe(command);
    expect(vi.mocked(api.save).mock.calls.map(([value]) => JSON.stringify(value))).toEqual([body, body, body]);
    await act(async () => response.resolve(projectWorkspace({ ...saved, revision: 1, sequence: 1, preview: null })));
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Save not confirmed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I cannot confirm this now' })).toBeEnabled();
    const after = within(proposal).getByRole('region', { name: 'After · preview' });
    await userEvent.click(within(after).getByText('More calculated results', { selector: 'summary' }));
    expect(within(after).getByText('Assumed closing cash').parentElement).toHaveTextContent('₹2,345.67');
    expect(within(after).getByText('Assumed closing cash').parentElement).toBeVisible();
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('checkbox')).toBeEnabled();
    expect(api.options).not.toHaveBeenCalled();
    expect(PipecatClient).not.toHaveBeenCalled();
    expect(DailyTransport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});