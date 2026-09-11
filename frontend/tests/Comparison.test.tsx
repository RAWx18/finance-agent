// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, mockAuth } from './appSupport';
import { api, ApiError } from '../src/api';
import type { AdjustmentOptions, Snapshot } from '../src/api';
import { adjustmentOptions, planningSnapshot, scenario, settings, Stream } from './fixtures';

beforeEach(() => {
  mockAuth();
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(api, 'current').mockResolvedValue(planningSnapshot());
  vi.spyOn(api, 'options').mockResolvedValue(adjustmentOptions);
  vi.spyOn(api, 'save').mockResolvedValue({ ...planningSnapshot(), sequence: 1, preview: scenario() });
});

async function open() {
  const user = userEvent.setup();
  render(<App />);
  const figures = await screen.findByRole('button', { name: 'Your figures' });
  await waitFor(() => expect(figures).toBeEnabled());
  await user.click(figures);
  await screen.findByRole('button', { name: 'Edit figures' });
  act(() => Stream.instances.at(-1)!.onopen?.());
  await user.click(screen.getByRole('button', { name: 'Spending changes' }));
  return user;
}

async function add(user: ReturnType<typeof userEvent.setup>, amount = '0', index = 0) {
  const edit = screen.queryByRole('button', { name: 'Edit selections' });
  if (edit) await user.click(edit);
  await user.click(await screen.findByRole('button', { name: 'Add a change' }));
  await user.selectOptions(await screen.findByLabelText('Payment or expense'), adjustmentOptions.options[index].eventId);
  await user.type(screen.getByLabelText('Planned amount (₹)'), amount);
  await user.click(screen.getByRole('button', { name: 'Add to preview' }));
}

describe('integrated spending comparison', () => {
  it('loads only in Spending changes and shows server next steps with associated records', async () => {
    const user = userEvent.setup();
    render(<App />);
    const figures = await screen.findByRole('button', { name: 'Your figures' });
    await waitFor(() => expect(figures).toBeEnabled());
    await user.click(figures);
    await screen.findByRole('region', { name: 'Next steps' });
    expect(api.options).not.toHaveBeenCalled();
    const steps = screen.getByRole('region', { name: 'Next steps' });
    expect(steps).toHaveTextContent('₹7,000.00');
    expect(steps).toHaveTextContent('13 Sept 2026');
    expect(steps).toHaveTextContent('Rent');
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('region', { name: 'Spending changes' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Next steps' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.queryByRole('region', { name: 'Spending changes' })).not.toBeInTheDocument();
    expect(vi.mocked(api.options).mock.calls[0][0]?.aborted).toBe(true);
    await user.click(screen.getByRole('link', { name: 'Back to conversation' }));
    act(() => Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), revision: 1, sequence: 1 }));
    expect(api.options).toHaveBeenCalledTimes(1);
  });

  it('includes assumptions accepted over live updates before the comparison is opened', async () => {
    const user = userEvent.setup();
    render(<App />);
    const figures = await screen.findByRole('button', { name: 'Your figures' });
    await waitFor(() => expect(figures).toBeEnabled());
    await user.click(figures);
    await screen.findByRole('button', { name: 'Edit figures' });
    const accepted = scenario('acceptedElsewhere');
    accepted.adjustments[0].acceptedRevision = 1;
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1 });
    act(() => {
      Stream.instances.at(-1)!.onopen?.();
      Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), sequence: 2, revision: 1, accepted });
    });
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    expect(screen.getByRole('list', { name: 'Selected changes' })).toHaveTextContent('Optional purchase');
    await add(user, '2000', 1);
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, operation: {
      type: 'previewAdjustments', adjustments: [
        { eventId: adjustmentOptions.options[0].eventId, amount: '0.00' },
        { eventId: adjustmentOptions.options[1].eventId, amount: '2000' },
      ],
    } }));
  });

  it.each([['1.234', 0, 'up to two decimal places'], ['2000', 0, 'less than'], ['1999.99', 1, 'at least']])('rejects invalid amount %s for option %s', async (value, index, message) => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add a change' }));
    await user.selectOptions(await screen.findByLabelText('Payment or expense'), adjustmentOptions.options[index as number].eventId);
    await user.type(screen.getByLabelText('Planned amount (₹)'), value as string);
    await user.click(screen.getByRole('button', { name: 'Add to preview' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message as string);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(api.save).not.toHaveBeenCalled();
  });

  it('selects a hypothetical card amount without sending consent and explains minimums', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add a change' }));
    await user.selectOptions(await screen.findByLabelText('Payment or expense'), adjustmentOptions.options[1].eventId);
    expect(screen.getByText(/required minimum is not payoff/)).toBeVisible();
    await user.type(screen.getByLabelText('Planned amount (₹)'), '2000');
    await user.click(screen.getByRole('button', { name: 'Add to preview' }));
    expect(api.save).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ operation: { type: 'previewAdjustments', adjustments: [{ eventId: adjustmentOptions.options[1].eventId, amount: '2000' }] } }));
  });

  it('edits selected changes in a modal, cancels another selection, and retains choices across views', async () => {
    const user = await open();
    await add(user, '500');
    await user.click(screen.getByRole('button', { name: 'Edit Optional purchase' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose a spending change' });
    expect(within(dialog).getByLabelText('Payment or expense')).toHaveValue(adjustmentOptions.options[0].eventId);
    const amount = within(dialog).getByLabelText('Planned amount (₹)');
    expect(amount).toHaveValue('500');
    await user.clear(amount);
    await user.type(amount, '750');
    await user.click(within(dialog).getByRole('button', { name: 'Add to preview' }));
    expect(screen.queryByRole('dialog', { name: 'Choose a spending change' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a change' }));
    await user.selectOptions(screen.getByLabelText('Payment or expense'), adjustmentOptions.options[1].eventId);
    await user.type(screen.getByLabelText('Planned amount (₹)'), '2000');
    await user.click(screen.getByRole('button', { name: 'Cancel selection' }));
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    const selected = screen.getByRole('list', { name: 'Selected changes' });
    expect(within(selected).getAllByRole('listitem')).toHaveLength(1);
    expect(selected).toHaveTextContent('₹750');
    expect(selected).not.toHaveTextContent('Card payment');
    expect(api.save).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'previewAdjustments', adjustments: [{ eventId: adjustmentOptions.options[0].eventId, amount: '750' }] });
  });

  it('previews without changing saved cards, explicitly accepts, then clears without baseline drift', async () => {
    const user = await open();
    await add(user);
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    const preview = await screen.findByRole('region', { name: 'Spending change preview' });
    const before = within(preview).getByRole('region', { name: 'Before · reported figures' });
    const after = within(preview).getByRole('region', { name: 'After · preview' });
    expect(within(before).getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    expect(within(after).getByText('Assumed closing cash').parentElement).toHaveTextContent('₹12,000.00');
    for (const values of [before, after]) {
      expect(within(values).getByText('First cash gap').parentElement).toHaveTextContent('₹7,000.00 · 13 Sept 2026');
      expect(within(values).getByText('Largest cash gap').parentElement).toHaveTextContent('₹16,000.00 · 18 Sept 2026');
    }
    expect(preview).toHaveTextContent('Not all costs are included');
    expect(preview).toHaveTextContent('These balances are not available to spend.');
    expect(screen.getByText('Projected closing cash', { selector: '.metrics dt' })).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    vi.mocked(api.save).mockResolvedValueOnce({ ...planningSnapshot(), sequence: 2, revision: 1, accepted: scenario() });
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1 });
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(api.save).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { type: 'acceptPreview', previewId: 'preview-one', confirmed: true, consentScope: 'unconditional' } }));
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Assumed closing cash', { selector: '.metrics dt' }).parentElement).toHaveTextContent('₹12,000.00');
    expect(screen.getByRole('region', { name: 'Saved planning assumptions' })).toHaveTextContent('₹2,000.00 less planned spending');
    vi.mocked(api.save).mockResolvedValueOnce({ ...planningSnapshot(), sequence: 3, revision: 2 });
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    await user.click(screen.getByRole('button', { name: 'Clear saved assumptions' }));
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Projected closing cash', { selector: '.metrics dt' })).toBeVisible();
    expect(screen.getByText('Projected closing cash', { selector: '.metrics dt' }).parentElement).toHaveTextContent('₹10,000.00');
  });

  it('allows an unknown-changeability hypothesis but cannot accept it by reviewing the proposal', async () => {
    const options = { ...adjustmentOptions, options: adjustmentOptions.options.map(item => ({ ...item, acceptanceReady: false })) };
    const proposal = scenario();
    proposal.adjustments[0].acceptanceReady = false;
    vi.mocked(api.options).mockResolvedValue(options);
    vi.mocked(api.save).mockResolvedValue({ ...planningSnapshot(), sequence: 1, preview: proposal });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add a change' }));
    await user.selectOptions(await screen.findByLabelText('Payment or expense'), options.options[0].eventId);
    expect(screen.getByText(/You can preview while unsure/)).toBeVisible();
    await user.type(screen.getByLabelText('Planned amount (₹)'), '0');
    await user.click(screen.getByRole('button', { name: 'Add to preview' }));
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    const preview = await screen.findByRole('region', { name: 'Spending change preview' });
    expect(preview).toHaveTextContent('To save, first confirm “Can this spending change?”');
    await user.click(within(preview).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'previewAdjustments', adjustments: [{ eventId: options.options[0].eventId, amount: '0' }] });
    expect(within(preview).getByRole('region', { name: 'Before · reported figures' })).toHaveTextContent('₹10,000.00');
  });

  it.each(['stale revision', 'one unready adjustment', 'unready retained adjustment'])('blocks acceptance for %s despite exact review', async reason => {
    const preview = scenario();
    if (reason === 'stale revision') preview.sourceRevision = 1;
    else preview.adjustments.push({ ...adjustmentOptions.options[1], amountPaise: 200000,
      acceptanceReady: false, acceptedRevision: reason === 'unready retained adjustment' ? 1 : null });
    vi.mocked(api.current).mockResolvedValue({ ...planningSnapshot(), sequence: 1, preview });
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('names removed saved occurrences and accepts the whole server proposal with retained consent', async () => {
    const accepted = scenario('accepted');
    accepted.adjustments[0].acceptedRevision = 1;
    accepted.adjustments.push({ ...adjustmentOptions.options[1], amountPaise: 200000, acceptedRevision: 1 });
    accepted.reducedOutflowPaise = 400000;
    accepted.plan = { ...accepted.plan, closingPaise: 1400000, outflowPaise: 2100000 };
    const saved = { ...planningSnapshot(), revision: 1, sequence: 2, accepted };
    const proposal = { ...scenario(), sourceRevision: 1, adjustments: [accepted.adjustments[1]],
      removedAssumptionIds: [accepted.adjustments[0].eventId] };
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1 });
    vi.mocked(api.save).mockResolvedValueOnce({ ...saved, sequence: 3, preview: proposal });
    const user = await open();
    expect(screen.getByRole('list', { name: 'Selected changes' })).toHaveTextContent('Card payment');
    await user.click(screen.getByRole('button', { name: 'Remove Optional purchase' }));
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    const preview = await screen.findByRole('region', { name: 'Spending change preview' });
    const removed = within(preview).getByRole('list', { name: 'Removed assumptions' });
    expect(removed).toHaveTextContent('Optional purchase · 27 Sept 2026 · ₹0.00 assumed → ₹2,000.00 reported');
    expect(preview).toHaveTextContent('Consent saved for this occurrence; not a completed action.');
    expect(preview).toHaveTextContent('Accepting saves this whole proposal, including removals. No payment is made.');
    expect(within(preview).getByRole('checkbox')).toHaveAccessibleName(/including removals, unconditionally—not dependent on uncertain income or payee agreement/);
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Assumed closing cash', { selector: '.metrics dt' }).parentElement).toHaveTextContent('₹14,000.00');
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'previewAdjustments', adjustments: [{ eventId: accepted.adjustments[1].eventId, amount: '2000.00' }] });
    await user.click(within(preview).getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    expect(api.save).toHaveBeenCalledTimes(1);
    vi.mocked(api.save).mockResolvedValueOnce({ ...saved, revision: 2, sequence: 4, accepted: proposal, preview: null });
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(vi.mocked(api.save).mock.calls[1][0].operation).toEqual({ type: 'acceptPreview', previewId: proposal.id, confirmed: true, consentScope: 'unconditional' });
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    const assumptions = screen.getByRole('region', { name: 'Saved planning assumptions' });
    expect(assumptions).toHaveTextContent('Card payment');
    expect(assumptions).not.toHaveTextContent('Optional purchase');
  });

  it('locks drafts and disconnected sessions without losing selected changes', async () => {
    const user = await open();
    await add(user);
    await user.click(screen.getByRole('button', { name: 'Edit figures' }));
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    expect(screen.getByText(/Save or discard your figure edits before comparing/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Edit figures' }));
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    act(() => Stream.instances.at(-1)!.onerror?.());
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Selected changes' })).toHaveTextContent('Optional purchase');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('rejects a preview without saving assumptions', async () => {
    vi.mocked(api.current).mockResolvedValue({ ...planningSnapshot(), sequence: 1, preview: scenario() });
    vi.mocked(api.save).mockResolvedValueOnce({ ...planningSnapshot(), sequence: 2 });
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Reject preview' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Spending change preview' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Projected closing cash', { selector: '.metrics dt' })).toBeVisible();
    expect(screen.getByText('Projected closing cash', { selector: '.metrics dt' }).parentElement).toHaveTextContent('₹10,000.00');
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ operation: { type: 'discardPreview', previewId: 'preview-one' } }));
  });

  it.each(['previewAdjustments', 'acceptPreview', 'discardPreview', 'clearAccepted'])('retries %s with the identical command and locks editing', async (operation) => {
    const saved = { ...planningSnapshot(), sequence: 1, preview: scenario(), accepted: operation === 'clearAccepted' ? scenario('accepted') : null };
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce({ ...saved, sequence: 2 });
    const user = await open();
    if (operation === 'previewAdjustments') { await add(user); await user.click(screen.getByRole('button', { name: 'Preview selected changes' })); }
    if (operation === 'acceptPreview') { await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ })); await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' })); }
    if (operation === 'discardPreview') await user.click(screen.getByRole('button', { name: 'Reject preview' }));
    if (operation === 'clearAccepted') await user.click(screen.getByRole('button', { name: 'Clear saved assumptions' }));
    const retry = await screen.findByRole('button', { name: 'Retry same action' });
    expect(screen.getByRole('button', { name: 'Edit figures' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Choose a spending change' })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button').filter(button => /Add a change|Edit selections|Review current preview|Accept planning assumptions|Reject preview|Clear saved assumptions/.test(button.textContent ?? ''))) expect(button).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument());
    const calls = vi.mocked(api.save).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(calls[1][0]);
    expect(calls[1][0].operation.type).toBe(operation);
    if (operation === 'acceptPreview') expect(calls[1][0].operation).toEqual({ type: 'acceptPreview', previewId: 'preview-one', confirmed: true, consentScope: 'unconditional' });
  });

  it('requires exact review again for a replacement preview at the same revision', async () => {
    vi.mocked(api.current).mockResolvedValue({ ...planningSnapshot(), sequence: 1, preview: scenario() });
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    act(() => Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), sequence: 2, preview: scenario('another-preview') }));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ operation: { type: 'acceptPreview', previewId: 'another-preview', confirmed: true, consentScope: 'unconditional' } }));
  });

  it('requires fresh consent after a day rollover even when the preview ID and financial revision stay unchanged', async () => {
    const saved = { ...planningSnapshot(), sequence: 1, preview: scenario() };
    vi.mocked(api.current).mockResolvedValue(saved);
    const user = await open();
    const consent = screen.getByRole('checkbox', { name: /I agree to the exact amounts/ });
    await user.click(consent);
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    const refreshed = structuredClone(saved);
    refreshed.sequence++;
    refreshed.plan.evaluatedOn = '2026-09-12';
    refreshed.preview!.plan.evaluatedOn = '2026-09-12';
    act(() => Stream.instances.at(-1)!.emit('snapshot', refreshed));
    expect(consent).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    act(() => Stream.instances.at(-1)!.emit('snapshot', saved));
    expect(consent).not.toBeChecked();
    expect(api.save).not.toHaveBeenCalled();
    await user.click(consent);
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: saved.revision,
      operation: { type: 'acceptPreview', previewId: saved.preview.id, confirmed: true, consentScope: 'unconditional' } }));
  });

  it.each(['reconnect', 'draft', 'selections', 'overview'] as const)('requires consent again after leaving a fresh review through %s', async interruption => {
    vi.mocked(api.current).mockResolvedValue({ ...planningSnapshot(), sequence: 1, preview: scenario() });
    const user = await open();
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    if (interruption === 'reconnect') {
      act(() => Stream.instances.at(-1)!.onerror?.());
      expect(screen.getByRole('checkbox')).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
      act(() => Stream.instances.at(-1)!.onopen?.());
    } else if (interruption === 'draft') {
      await user.click(screen.getByRole('button', { name: 'Edit figures' }));
      await user.click(screen.getByRole('button', { name: 'Discard draft' }));
      await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    } else if (interruption === 'selections') {
      await user.click(screen.getByRole('button', { name: 'Edit selections' }));
      expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Review current preview' }));
    } else {
      await user.click(screen.getByRole('button', { name: 'Overview' }));
      await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    }
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('distinguishes loading, error and empty results and ignores late responses after revision changes', async () => {
    let resolve!: (value: AdjustmentOptions) => void;
    vi.mocked(api.options).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const user = await open();
    expect(screen.getByText('Loading choices…')).toBeVisible();
    vi.mocked(api.options).mockRejectedValueOnce(new Error('Offline'));
    act(() => Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), revision: 1, sequence: 1 }));
    await screen.findByText(/Choices could not be loaded/);
    await act(async () => resolve(adjustmentOptions));
    expect(screen.getByRole('alert')).toHaveTextContent('Choices could not be loaded');
    expect(screen.getByRole('button', { name: 'Add a change' })).toBeDisabled();
    vi.mocked(api.options).mockResolvedValueOnce({ ...adjustmentOptions, revision: 1, options: [] });
    await user.click(screen.getByRole('button', { name: 'Retry loading choices' }));
    expect(await screen.findByText(/No eligible spending changes/)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invalidates a selection when only its dependency key changes and explains affected consent', async () => {
    vi.mocked(api.current).mockResolvedValue({ ...planningSnapshot(), accepted: scenario() });
    const user = await open();
    await add(user);
    await user.click(screen.getByRole('button', { name: 'Edit figures' }));
    expect(screen.getByText(/Saving clears the preview. Changes affecting saved assumptions need fresh consent/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    await user.click(screen.getByRole('button', { name: 'Spending changes' }));
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1,
      options: adjustmentOptions.options.map(item => ({ ...item, dependencyKey: `${item.dependencyKey}-corrected` })) });
    act(() => Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), revision: 1, sequence: 1,
      invalidatedAssumptions: [{ eventId: adjustmentOptions.options[0].eventId, reason: 'Occurrence terms changed; confirm a fresh proposal.' }] }));
    expect(screen.getAllByText('1 planning assumption(s) need fresh consent. 0 remain saved.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review refreshed choices' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Review refreshed choices' }));
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('needs review');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('explains expired eligibility and leaves the preview reviewable after rejection', async () => {
    const saved: Snapshot = { ...planningSnapshot(), sequence: 1, preview: scenario() };
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new ApiError(409, { code: 'stalePreview', message: 'Date passed', snapshot: saved }));
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    await screen.findAllByText(/a date may have passed/);
    expect(screen.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
    expect(within(screen.getByRole('region', { name: 'Spending change preview' })).getByRole('region', { name: 'Before · reported figures' })).toHaveTextContent('₹10,000.00');
  });
});