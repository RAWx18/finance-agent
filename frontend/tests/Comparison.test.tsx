// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, mockAuth } from './appSupport';
import { api, ApiError } from '../src/api';
import type { AdjustmentOptions, Snapshot } from '../src/api';
import { Comparison } from '../src/Comparison';
import { ProposalReview } from '../src/ScenarioDetails';
import { moneyRoutes } from '../src/moneyRoutes';
import type { MoneyRoute } from '../src/moneyRoutes';
import { ToastViewport } from '../src/Toast';
import * as notifications from '../src/Toast';
import { adjustmentOptions, planningSnapshot, scenario, settings, Stream } from './fixtures';
import { projectWorkspace } from './workspace';

beforeEach(() => {
  mockAuth();
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(api, 'current').mockResolvedValue(planningSnapshot());
  vi.spyOn(api, 'options').mockResolvedValue(adjustmentOptions);
  vi.spyOn(api, 'save').mockResolvedValue(projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: scenario() }));
});

async function navigate(user: ReturnType<typeof userEvent.setup>, path: MoneyRoute) {
  await user.click(within(screen.getByRole('navigation', { name: 'Money navigation' })).getByRole('link', { name: moneyRoutes[path] }));
  await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-route', path));
}

async function open() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: /Review saved picture/ });
  await waitFor(() => expect(api.call).toHaveBeenCalledOnce());
  const money = within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' });
  await waitFor(() => expect(money).not.toHaveAttribute('aria-disabled', 'true'));
  await user.click(money);
  await screen.findByRole('region', { name: 'Money content' });
  await waitFor(() => expect(Stream.instances).toHaveLength(1));
  const initial = await vi.mocked(api.current).mock.results.at(-1)!.value as Snapshot;
  act(() => { Stream.instances.at(-1)!.onopen?.(); Stream.instances.at(-1)!.emit('snapshot', initial); });
  await navigate(user, '/money/changes');
  await user.click(within(screen.getByRole('region', { name: 'Suggested plan changes' })).getByRole('button', { name: /Choose .*changes/ }));
  await screen.findByRole('region', { name: 'Custom changes' });
  return user;
}

async function closing(user: ReturnType<typeof userEvent.setup>, amount: string) {
  await navigate(user, '/money');
  await user.click(within(screen.getByRole('region', { name: 'What needs attention' })).getByRole('button', { name: 'Plan details' }));
  const dialog = screen.getByRole('dialog', { name: 'Plan details' });
  expect(within(dialog).getByText('Projected closing cash · Calculated').parentElement).toHaveTextContent(amount);
  expect(dialog).toHaveTextContent('Closing cash is not spare spending money.');
  await user.click(within(dialog).getByRole('button', { name: 'Close plan details' }));
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
  it('loads custom choices only on request in Plan changes and shows server next steps with associated records', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: /Review saved picture/ });
    await waitFor(() => expect(api.call).toHaveBeenCalledOnce());
    const money = within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' });
    await waitFor(() => expect(money).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(money);
    const page = within(await screen.findByRole('region', { name: 'Money content' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-route', '/money'));
    const steps = page.getByRole('region', { name: 'What needs attention' });
    expect(api.options).not.toHaveBeenCalled();
    expect(steps).toHaveTextContent('₹7,000.00');
    expect(steps).toHaveTextContent('13 Sept 2026');
    expect(steps).toHaveTextContent('Contact the provider before the due date.');
    expect(page.getByRole('region', { name: 'Next money and payments' })).toHaveTextContent('Rent');
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0].emit('snapshot', planningSnapshot()));
    await navigate(user, '/money/changes');
    expect(screen.getByRole('region', { name: 'Suggested plan changes' })).toBeVisible();
    expect(api.options).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Choose .*changes/ }));
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('region', { name: 'Custom changes' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'What needs attention' })).not.toBeInTheDocument();
    await navigate(user, '/money');
    expect(screen.queryByRole('region', { name: 'Custom changes' })).not.toBeInTheDocument();
    expect(vi.mocked(api.options).mock.calls[0][0]?.aborted).toBe(true);
    await user.click(screen.getByRole('link', { name: 'Continue conversation' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-route', '/app'));
    act(() => Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), revision: 1, sequence: 1 }));
    expect(api.options).toHaveBeenCalledTimes(1);
  });

  it('includes assumptions accepted over live updates before the comparison is opened', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: /Review saved picture/ });
    await waitFor(() => expect(api.call).toHaveBeenCalledOnce());
    const money = within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' });
    await waitFor(() => expect(money).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(money);
    await screen.findByRole('button', { name: 'Correct starting cash' });
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const accepted = scenario('acceptedElsewhere');
    accepted.adjustments[0].acceptedRevision = 1;
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1 });
    act(() => {
      Stream.instances.at(-1)!.onopen?.();
      Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), sequence: 2, revision: 1, accepted });
    });
    await navigate(user, '/money/changes');
    await user.click(screen.getByRole('button', { name: /Choose .*changes/ }));
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
    expect(screen.getByLabelText('Planned amount (₹)')).toHaveAttribute('aria-invalid', 'true');
    expect(within(screen.getByRole('dialog', { name: 'Choose a spending change' })).getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
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
    await navigate(user, '/money');
    await navigate(user, '/money/changes');
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
    const before = within(preview).getByRole('region', { name: 'Before · active plan' });
    const after = within(preview).getByRole('region', { name: 'After · preview' });
    for (const values of [before, after]) await user.click(within(values).getByText('More calculated results', { selector: 'summary' }));
    expect(within(before).getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    expect(within(after).getByText('Assumed closing cash').parentElement).toHaveTextContent('₹12,000.00');
    for (const values of [before, after]) {
      expect(within(values).getByText('First cash gap').parentElement).toHaveTextContent('₹7,000.00 · 13 Sept 2026');
      expect(within(values).getByText('Largest cash gap').parentElement).toHaveTextContent('₹16,000.00 · 18 Sept 2026');
    }
    expect(preview).toHaveTextContent('Not all costs are included');
    expect(preview).toHaveTextContent('These balances are not available to spend.');
    expect(screen.queryByRole('region', { name: 'What needs attention' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await closing(user, '₹10,000.00');
    await navigate(user, '/money/changes');
    vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace({ ...planningSnapshot(), sequence: 2, revision: 1, accepted: scenario() }));
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1 });
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(api.save).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { type: 'acceptPreview', previewId: 'preview-one', confirmed: true, consentScope: 'unconditional' } }));
    expect(screen.getByRole('region', { name: 'Current planning changes' })).toHaveTextContent('₹2,000.00 less planned spending');
    await closing(user, '₹12,000.00');
    vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace({ ...planningSnapshot(), sequence: 3, revision: 2 }));
    await navigate(user, '/money/changes');
    await user.click(screen.getByRole('button', { name: 'Restore reported amounts' }));
    await user.click(screen.getByRole('button', { name: 'Restore all reported amounts' }));
    expect(screen.getByRole('region', { name: 'Current planning changes' })).toHaveTextContent('Your reported plan is active');
    await closing(user, '₹10,000.00');
  });

  it('allows an unknown-changeability hypothesis but cannot accept it by reviewing the proposal', async () => {
    const options = { ...adjustmentOptions, options: adjustmentOptions.options.map(item => ({ ...item, acceptanceReady: false })) };
    const proposal = scenario();
    proposal.adjustments[0].acceptanceReady = false;
    vi.mocked(api.options).mockResolvedValue(options);
    vi.mocked(api.save).mockResolvedValue(projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: proposal }));
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
    expect(within(preview).getByRole('checkbox')).toBeDisabled();
    await user.click(within(preview).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'previewAdjustments', adjustments: [{ eventId: options.options[0].eventId, amount: '0' }] });
    const before = within(preview).getByRole('region', { name: 'Before · active plan' });
    await user.click(within(before).getByText('More calculated results', { selector: 'summary' }));
    expect(within(before).getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
  });

  it.each(['stale revision', 'one unready adjustment', 'unready retained adjustment'])('blocks acceptance for %s despite exact review', async reason => {
    const preview = scenario();
    if (reason === 'stale revision') preview.sourceRevision = 1;
    else preview.adjustments.push({ ...adjustmentOptions.options[1], amountPaise: 200000,
      acceptanceReady: false, acceptedRevision: reason === 'unready retained adjustment' ? 1 : null });
    vi.mocked(api.current).mockResolvedValue(projectWorkspace({ ...planningSnapshot(), sequence: 1, preview }));
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('names removed saved occurrences and accepts the whole server proposal with retained consent', async () => {
    const accepted = scenario('accepted');
    accepted.adjustments[0].acceptedRevision = 1;
    accepted.adjustments.push({ ...adjustmentOptions.options[1], amountPaise: 200000, acceptedRevision: 1 });
    accepted.reducedOutflowPaise = 400000;
    accepted.plan = { ...accepted.plan, closingPaise: 1400000, outflowPaise: 2100000 };
    const saved = projectWorkspace({ ...planningSnapshot(), revision: 1, sequence: 2, accepted });
    const proposal = { ...scenario(), sourceRevision: 1, adjustments: [accepted.adjustments[1]],
      removedAssumptionIds: [accepted.adjustments[0].eventId] };
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1 });
    vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace({ ...saved, sequence: 3, preview: proposal }));
    const user = await open();
    expect(screen.getByRole('list', { name: 'Selected changes' })).toHaveTextContent('Card payment');
    await user.click(screen.getByRole('button', { name: 'Remove Optional purchase' }));
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    const preview = await screen.findByRole('region', { name: 'Spending change preview' });
    const removed = within(preview).getByRole('list', { name: 'Removed assumptions' });
    expect(removed).toHaveTextContent('Optional purchase · 27 Sept 2026 · ₹0.00 Saved → ₹2,000.00 Reported');
    await user.click(within(preview).getByText('Terms for this change', { selector: 'summary' }));
    expect(preview).toHaveTextContent('Consent saved for this occurrence; not a completed action.');
    expect(preview).toHaveTextContent('Accepting saves this whole proposal, including removals. No payment is made.');
    expect(within(preview).getByRole('checkbox')).toHaveAccessibleName(/including removals, unconditionally—not dependent on uncertain income or payee agreement/);
    const before = within(preview).getByRole('region', { name: 'Before · active plan' });
    await user.click(within(before).getByText('More calculated results', { selector: 'summary' }));
    expect(within(before).getByText('Projected closing cash').parentElement).toHaveTextContent('₹14,000.00');
    await user.click(within(preview).getByRole('button', { name: 'Reported baseline' }));
    const baseline = screen.getByRole('dialog', { name: 'Reported baseline' });
    const reported = within(baseline).getByRole('region', { name: 'Before · reported figures' });
    await user.click(within(reported).getByText('More calculated results', { selector: 'summary' }));
    expect(within(reported).getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    await user.click(within(baseline).getByRole('button', { name: 'Close reported baseline' }));
    await closing(user, '₹14,000.00');
    await navigate(user, '/money/changes');
    expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'previewAdjustments', adjustments: [{ eventId: accepted.adjustments[1].eventId, amount: '2000.00' }] });
    await user.click(within(preview).getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    expect(api.save).toHaveBeenCalledTimes(1);
    vi.mocked(api.save).mockResolvedValueOnce(projectWorkspace({ ...saved, revision: 2, sequence: 4, accepted: proposal, preview: null }));
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(vi.mocked(api.save).mock.calls[1][0].operation).toEqual({ type: 'acceptPreview', previewId: proposal.id, confirmed: true, consentScope: 'unconditional' });
    const assumptions = screen.getByRole('region', { name: 'Current planning changes' });
    expect(assumptions).toHaveTextContent('Card payment');
    expect(assumptions).not.toHaveTextContent('Optional purchase');
  });

  it('locks the shared comparison for drafts and disconnected sessions without losing selected changes', async () => {
    const user = userEvent.setup();
    const props = { snapshot: planningSnapshot(), settings, active: true,
      locked: false, pending: false, onCommand: vi.fn() };
    const view = render(<Comparison {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a change' })).toBeEnabled());
    await add(user);
    view.rerender(<Comparison {...props} locked />);
    expect(screen.getByText(/Finish any open correction and wait for live updates/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Optional purchase' })).toBeDisabled();
    view.rerender(<Comparison {...props} />);
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeEnabled();
    view.rerender(<Comparison {...props} locked />);
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Selected changes' })).toHaveTextContent('Optional purchase');
    expect(screen.getByRole('button', { name: 'Remove Optional purchase' })).toBeDisabled();
    expect(props.onCommand).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('rejects a preview without saving assumptions', async () => {
    vi.mocked(api.current).mockResolvedValue(projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: scenario() }));
    vi.mocked(api.save).mockResolvedValueOnce({ ...planningSnapshot(), sequence: 2 });
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Reject preview' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Spending change preview' })).not.toBeInTheDocument());
    await closing(user, '₹10,000.00');
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ operation: { type: 'rejectPreview', previewId: 'preview-one' } }));
  });

  it.each(['previewAdjustments', 'acceptPreview', 'rejectPreview', 'discardPreview', 'clearAccepted'])('retries %s with the identical command and locks editing', async (operation) => {
    const saved = projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: scenario(), accepted: operation === 'clearAccepted' ? scenario('accepted') : null });
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce({ ...saved, sequence: 2 });
    const user = await open();
    if (operation === 'previewAdjustments') { await add(user); await user.click(screen.getByRole('button', { name: 'Preview selected changes' })); }
    if (operation === 'acceptPreview') { await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ })); await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' })); }
    if (operation === 'rejectPreview') await user.click(screen.getByRole('button', { name: 'Reject preview' }));
    if (operation === 'discardPreview') await user.click(screen.getByRole('button', { name: 'Close preview' }));
    if (operation === 'clearAccepted') {
      await user.click(screen.getByRole('button', { name: 'Restore reported amounts' }));
      await user.click(screen.getByRole('button', { name: 'Restore all reported amounts' }));
    }
    const notice = await screen.findByRole('alert', { name: 'Save not confirmed' });
    const retry = within(notice).getByRole('button', { name: 'Retry same action' });
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Save not confirmed' })).toBe(notice);
    expect(within(screen.getByRole('region', { name: 'Plan changes content' })).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Plan changes content' })).queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(notice).not.toHaveTextContent('Lost response');
    await navigate(user, '/money');
    expect(screen.getByRole('button', { name: 'Correct starting cash' })).toBeDisabled();
    await navigate(user, '/money/changes');
    expect(screen.queryByRole('dialog', { name: 'Choose a spending change' })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button').filter(button => /Add a change|Edit selections|Review current preview|Accept planning assumptions|Reject preview|Restore reported amounts/.test(button.getAttribute('aria-label') ?? button.textContent ?? ''))) expect(button).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert', { name: 'Save not confirmed' })).not.toBeInTheDocument();
    const calls = vi.mocked(api.save).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(calls[1][0]);
    expect(calls[1][0].operation.type).toBe(operation);
    if (operation === 'acceptPreview') expect(calls[1][0].operation).toEqual({ type: 'acceptPreview', previewId: 'preview-one', confirmed: true, consentScope: 'unconditional' });
  });

  it('requires exact review again for a replacement preview at the same revision', async () => {
    vi.mocked(api.current).mockResolvedValue(projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: scenario() }));
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
    const saved = projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: scenario() });
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
      operation: { type: 'acceptPreview', previewId: saved.preview!.id, confirmed: true, consentScope: 'unconditional' } }));
  });

  it.each(['reconnect', 'correction', 'selections', 'overview'] as const)('requires consent again after leaving a fresh review through %s', async interruption => {
    const saved = projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: scenario() });
    vi.mocked(api.current).mockResolvedValue(saved);
    const user = await open();
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    if (interruption === 'reconnect') {
      act(() => Stream.instances.at(-1)!.onerror?.());
      expect(screen.getByRole('checkbox')).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
      act(() => Stream.instances.at(-1)!.onopen?.());
      act(() => Stream.instances.at(-1)!.emit('snapshot', saved));
    } else if (interruption === 'correction') {
      await navigate(user, '/money');
      await user.click(screen.getByRole('button', { name: 'Correct starting cash' }));
      const dialog = screen.getByRole('dialog', { name: /Correct cash on/ });
      await user.clear(within(dialog).getByLabelText('Amount (₹)'));
      await user.type(within(dialog).getByLabelText('Amount (₹)'), '6000');
      await user.click(within(dialog).getByRole('button', { name: /Close correct cash/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Discard correction' }));
      await navigate(user, '/money/changes');
    } else if (interruption === 'selections') {
      await user.click(screen.getByRole('button', { name: 'Edit selections' }));
      expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Review current preview' }));
    } else {
      await navigate(user, '/money');
      await navigate(user, '/money/changes');
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
    const notice = screen.getByRole('alert', { name: 'Spending choices unavailable' });
    expect(notice).toHaveTextContent('Choices could not be loaded');
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert')).toBe(notice);
    expect(within(screen.getByRole('region', { name: 'Plan changes content' })).queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Custom changes' })).queryByText(/Choices could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading choices…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a change' })).toBeDisabled();
    vi.mocked(api.options).mockResolvedValueOnce({ ...adjustmentOptions, revision: 1, options: [] });
    await user.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No eligible spending changes/)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invalidates a selection when only its dependency key changes and explains affected consent', async () => {
    vi.mocked(api.current).mockResolvedValue(projectWorkspace({ ...planningSnapshot(), accepted: scenario() }));
    const user = await open();
    await add(user);
    await navigate(user, '/money');
    await user.click(screen.getByRole('button', { name: 'Correct starting cash' }));
    const dialog = screen.getByRole('dialog', { name: /Correct cash on/ });
    expect(dialog).toHaveTextContent('Saving clears the preview. Affected saved changes need fresh consent; unrelated changes remain.');
    await user.click(within(dialog).getByRole('button', { name: /Close correct cash/ }));
    await navigate(user, '/money/changes');
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1,
      options: adjustmentOptions.options.map(item => ({ ...item, dependencyKey: `${item.dependencyKey}-corrected` })) });
    act(() => Stream.instances.at(-1)!.emit('snapshot', { ...planningSnapshot(), revision: 1, sequence: 1,
      invalidatedAssumptions: [{ eventId: adjustmentOptions.options[0].eventId, reason: 'Occurrence terms changed; confirm a fresh proposal.' }] }));
    await user.click(screen.getByRole('button', { name: '1 changes need fresh consent' }));
    const consent = screen.getByRole('dialog', { name: '1 changes need fresh consent' });
    expect(consent).toHaveTextContent('These changes are no longer included. Unaffected saved changes remain.');
    expect(consent).toHaveTextContent('Occurrence terms changed; confirm a fresh proposal.');
    await user.click(within(consent).getByRole('button', { name: 'Close 1 changes need fresh consent' }));
    expect(screen.getByRole('region', { name: 'Current planning changes' })).toHaveTextContent('Your reported plan is active');
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review refreshed choices' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Review refreshed choices' }));
    await user.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('needs review');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('explains expired eligibility and leaves the preview reviewable after rejection', async () => {
    const saved = projectWorkspace({ ...planningSnapshot(), sequence: 1, preview: scenario() });
    vi.mocked(api.current).mockResolvedValue(saved);
    vi.mocked(api.save).mockRejectedValueOnce(new ApiError(409, { code: 'stalePreview', message: 'Date passed', snapshot: saved }));
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the exact amounts and payments or expenses shown/ }));
    await user.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    const notice = await screen.findByRole('alert', { name: 'Action needs attention' });
    expect(notice).toHaveTextContent(/a date may have passed/);
    expect(within(screen.getByRole('complementary', { name: 'Notifications' })).getByRole('alert', { name: 'Action needs attention' })).toBe(notice);
    expect(within(screen.getByRole('region', { name: 'Plan changes content' })).queryByRole('alert', { name: 'Action needs attention', hidden: true })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Plan changes content' })).queryByText(/a date may have passed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
    const before = within(screen.getByRole('region', { name: 'Spending change preview' })).getByRole('region', { name: 'Before · active plan' });
    await user.click(within(before).getByText('More calculated results', { selector: 'summary' }));
    expect(within(before).getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
  });
});

describe('spending choice notifications', () => {
  it('disables retries while locked, preserves selections, and clears the failure on recovery', async () => {
    const user = userEvent.setup();
    const notify = vi.spyOn(notifications, 'notify');
    vi.mocked(api.options).mockRejectedValueOnce(new TypeError('private service diagnostic'));
    const props = { snapshot: projectWorkspace({ ...planningSnapshot(), accepted: scenario() }), settings, active: true,
      locked: true, pending: false, onCommand: vi.fn() };
    const view = render(<><Comparison {...props} /><ToastViewport /></>);
    const notice = await screen.findByRole('alert', { name: 'Spending choices unavailable' });
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(notice).not.toHaveTextContent('private service diagnostic');
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'choices:load', severity: 'error', duration: null }));
    expect(screen.getByRole('list', { name: 'Selected changes' })).toHaveTextContent('Optional purchase');
    view.rerender(<><Comparison {...props} locked={false} /><ToastViewport /></>);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a change' })).toBeEnabled());
    expect(api.options).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Selected changes' })).toHaveTextContent('Optional purchase');
    expect(props.onCommand).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'unmounted'])('dismisses its notification and invalidates its retry when %s', async state => {
    const notify = vi.spyOn(notifications, 'notify');
    vi.mocked(api.options).mockRejectedValue(new TypeError('Offline'));
    const props = { snapshot: planningSnapshot(), settings, active: true, locked: false,
      pending: false, onCommand: vi.fn() };
    const view = render(<><Comparison {...props} /><ToastViewport /></>);
    await screen.findByRole('alert', { name: 'Spending choices unavailable' });
    const retry = notify.mock.calls.at(-1)![0].action!.onClick;
    if (state === 'inactive') view.rerender(<><Comparison {...props} active={false} /><ToastViewport /></>);
    else view.rerender(<ToastViewport />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { await retry(); });
    expect(api.options).toHaveBeenCalledTimes(1);
    expect(props.onCommand).not.toHaveBeenCalled();
  });

  it('does not notify for a request that fails after leaving the view', async () => {
    let reject!: (reason: unknown) => void;
    vi.mocked(api.options).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const notify = vi.spyOn(notifications, 'notify');
    const view = render(<><Comparison snapshot={planningSnapshot()} settings={settings} active locked={false}
      pending={false} onCommand={vi.fn()} /><ToastViewport /></>);
    expect(within(screen.getByRole('region', { name: 'Custom changes' })).getByRole('status')).toHaveTextContent('Loading choices');
    view.rerender(<ToastViewport />);
    expect(vi.mocked(api.options).mock.calls[0][0]?.aborted).toBe(true);
    await act(async () => reject(new Error('Offline')));
    expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Money custom comparison', () => {
  it('edits and removes selections with named icon controls and sends the complete replacement set', async () => {
    const accepted = { ...scenario('accepted'), adjustments: adjustmentOptions.options.map(item => ({ ...item, amountPaise: item.minimumPaise, acceptedRevision: 0 })) };
    const saved = projectWorkspace({ ...planningSnapshot(), accepted });
    const onCommand = vi.fn();
    render(<Comparison snapshot={saved} settings={settings} active locked={false} pending={false} onCommand={onCommand} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a change' })).toBeEnabled());
    const selected = screen.getByRole('list', { name: 'Selected changes' });
    expect(selected).toHaveTextContent('Proposed'); expect(selected).toHaveTextContent('Not saved');
    await userEvent.click(within(selected).getByRole('button', { name: 'Remove Optional purchase' }));
    await userEvent.click(within(selected).getByRole('button', { name: 'Edit Card payment' }));
    const input = screen.getByLabelText('Planned amount (₹)');
    await userEvent.clear(input); await userEvent.type(input, '2500.25');
    await userEvent.click(screen.getByRole('button', { name: 'Add to preview' }));
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'previewAdjustments', adjustments: [{ eventId: adjustmentOptions.options[1].eventId, amount: '2500.25' }] });
  });

  it('keeps exact retained and removed amounts visible and requires unconditional whole-proposal consent', async () => {
    const accepted = { ...scenario('accepted'), adjustments: adjustmentOptions.options.map(item => ({ ...item, amountPaise: item.minimumPaise, acceptedRevision: 0 })) };
    const preview = { ...scenario('replacement'), adjustments: [accepted.adjustments[1]], removedAssumptionIds: [accepted.adjustments[0].eventId] };
    const saved = projectWorkspace({ ...planningSnapshot(), accepted, preview });
    const onCommand = vi.fn();
    render(<ProposalReview snapshot={saved} active locked={false} onCommand={onCommand} />);
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    const fullSet = within(proposal).getByRole('list', { name: 'Planning assumptions' });
    expect(fullSet).toHaveTextContent('Card payment'); expect(fullSet).toHaveTextContent('₹2,000.00 Proposed');
    expect(fullSet).not.toHaveTextContent('Optional purchase');
    const removed = within(proposal).getByRole('list', { name: 'Removed assumptions' });
    expect(removed).toHaveTextContent('Optional purchase · 27 Sept 2026 · ₹0.00 Saved → ₹2,000.00 Reported');
    expect(proposal).toHaveTextContent('Replaces all saved assumptions; changes do not stack.');
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await userEvent.click(within(proposal).getByRole('checkbox', { name: /including removals, unconditionally/ }));
    await userEvent.click(within(proposal).getByRole('button', { name: 'Accept planning assumptions' }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'acceptPreview', previewId: 'replacement', confirmed: true, consentScope: 'unconditional' });
  });

  it.each(['sequence', 'revision', 'preview', 'inactive', 'locked', 'refresh', 'editing'] as const)('requires fresh consent after %s changes', async change => {
    const saved = projectWorkspace({ ...planningSnapshot(), preview: scenario() });
    const props = { snapshot: saved, settings, active: true, locked: false, pending: false, onCommand: vi.fn() };
    const view = render(<Comparison {...props} />);
    await waitFor(() => expect(api.options).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    if (change === 'refresh') await userEvent.click(screen.getByRole('button', { name: 'Refresh choices' }));
    else if (change === 'editing') {
      await userEvent.click(screen.getByRole('button', { name: 'Edit selections' }));
      await userEvent.click(screen.getByRole('button', { name: 'Review current preview' }));
    } else if (change === 'inactive' || change === 'locked') {
      view.rerender(<Comparison {...props} active={change !== 'inactive'} locked={change === 'locked'} />);
      view.rerender(<Comparison {...props} />);
    } else {
      const snapshot: Snapshot = { ...saved,
        sequence: saved.sequence + 1,
        revision: change === 'revision' ? saved.revision + 1 : saved.revision,
        preview: change === 'preview' ? scenario('different') : saved.preview,
      };
      view.rerender(<Comparison {...props} snapshot={snapshot} />);
    }
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(props.onCommand).not.toHaveBeenCalled();
  });

  it('keeps a selected occurrence blocked until refreshed dependency changes are reviewed', async () => {
    const saved = projectWorkspace({ ...planningSnapshot(), accepted: scenario() });
    const props = { snapshot: saved, settings, active: true, locked: false, pending: false, onCommand: vi.fn() };
    const view = render(<Comparison {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a change' })).toBeEnabled());
    vi.mocked(api.options).mockResolvedValue({ ...adjustmentOptions, revision: 1, options: adjustmentOptions.options.map(item => ({ ...item, dependencyKey: `${item.dependencyKey}:different` })) });
    view.rerender(<Comparison {...props} snapshot={{ ...saved, revision: 1, sequence: 1 }} />);
    expect(screen.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review refreshed choices' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Review refreshed choices' }));
    await userEvent.click(screen.getByRole('button', { name: 'Preview selected changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('needs review');
    expect(props.onCommand).not.toHaveBeenCalled();
  });
});