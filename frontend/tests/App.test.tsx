// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, mockAuth } from './appSupport';
import { api, ApiError } from '../src/api';
import { Projection } from '../src/Projection';
import { planningSnapshot, scenario, settings, snapshot, Stream, unconfirmedSnapshot } from './fixtures';

beforeEach(() => {
  mockAuth();
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', message: null });
  vi.spyOn(api, 'current').mockResolvedValue(snapshot());
  vi.spyOn(api, 'start').mockResolvedValue(snapshot());
  vi.spyOn(api, 'delete').mockResolvedValue({ deleted: true });
  vi.spyOn(api, 'save').mockResolvedValue({ ...snapshot(), revision: 1, sequence: 1 });
});

async function editCash(value: string) {
  const user = userEvent.setup();
  const open = await screen.findByRole('button', { name: 'Your figures' });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  const figures = within(await screen.findByRole('region', { name: 'Your figures' }));
  await user.click(figures.getByRole('button', { name: 'Edit figures' }));
  const field = figures.getByRole('group', { name: 'Available cash' });
  await user.selectOptions(within(field).getByLabelText('How certain?'), 'exact');
  await user.type(within(field).getByLabelText('Available cash (₹)'), value);
  return user;
}

describe('consumer projection journey', () => {
  it('keeps unreadable saved figures distinct from connection failures and retries without deleting', async () => {
    vi.mocked(api.current).mockRejectedValueOnce(new ApiError(500, {
      code: 'invalidStoredState', message: 'private saved financial input',
    })).mockResolvedValue(planningSnapshot());
    render(<App />);
    await screen.findByRole('heading', { name: 'Saved figures need attention' });
    expect(screen.queryByRole('heading', { name: 'Connection unavailable' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Saved figures need attention' })).toHaveTextContent('They have not been deleted');
    expect(screen.queryByText(/private saved financial input/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByRole('button', { name: /Review saved picture/ });
    expect(screen.queryByRole('heading', { name: 'Saved figures need attention' })).not.toBeInTheDocument();
    expect(api.current).toHaveBeenCalledTimes(2);
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });
  it('reopens saved unavailable answers even when no money or records have been supplied', async () => {
    vi.mocked(api.current).mockResolvedValue(unconfirmedSnapshot());
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Review saved picture/ }));
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(picture).toHaveTextContent('Unconfirmed details remain open.');
    expect(within(picture).getByText('Projected closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('Unknown');
    expect(picture).not.toHaveTextContent(/₹0\.00|Known commitments look covered/);
    expect(within(picture).getByRole('region', { name: 'Next steps' })).toHaveTextContent('Have we covered all your income and commitments for these 30 days?');
    await userEvent.click(within(picture).getByRole('button', { name: 'Open questions' }));
    expect(screen.getByRole('list', { name: 'Remaining checks' })).toHaveTextContent('What cash was available at the original cash basis?');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('locks the conversation-surface proposal for a retained draft and requires a fresh check after discarding edits', async () => {
    vi.mocked(api.current).mockResolvedValue({ ...planningSnapshot(), preview: scenario() });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Review saved picture/ }));
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0].onopen?.());
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    await userEvent.click(within(proposal).getByRole('checkbox'));
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    expect(proposal).not.toBeVisible();
    await userEvent.click(figures.getByRole('button', { name: 'Edit figures' }));
    const cash = figures.getByLabelText('Available cash (₹)');
    await userEvent.clear(cash); await userEvent.type(cash, '123.45');
    await userEvent.click(figures.getByRole('link', { name: 'Back to conversation' }));
    expect(proposal).toBeVisible();
    expect(within(proposal).getByRole('checkbox')).toBeDisabled();
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Finish review' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Review your draft' }));
    expect(figures.getByLabelText('Available cash (₹)')).toHaveValue('123.45');
    await userEvent.click(figures.getByRole('button', { name: 'Discard draft' }));
    await userEvent.click(figures.getByRole('link', { name: 'Back to conversation' }));
    expect(within(proposal).getByRole('checkbox')).toBeEnabled();
    expect(within(proposal).getByRole('checkbox')).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(screen.queryByText('Unsaved corrections')).not.toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('reviews named income and commitments, applies corrections, and opens all figures without editing', async () => {
    const saved = planningSnapshot();
    saved.facts.records.unshift({ id: 'salary', label: 'Salary', kind: 'income', amount: { status: 'exact', amountPaise: 3000000 }, schedule: { date: '2026-09-25', recurrence: 'monthly' }, reliability: 'reliable', autoDebit: false });
    saved.facts.records.push(
      { id: 'bonus', label: 'Bonus', kind: 'income', amount: { status: 'estimate', amountPaise: 100000 }, schedule: { date: null, recurrence: 'once' }, reliability: 'uncertain', autoDebit: false },
      { id: 'bill', label: 'Utility bill', kind: 'essential', amount: { status: 'unknown', amountPaise: null }, schedule: { date: null, recurrence: 'monthly' }, autoDebit: false },
      { id: 'purchase', label: 'Optional purchase', kind: 'optional', amount: { status: 'exact', amountPaise: 200000 }, schedule: { date: '2026-09-27', recurrence: 'once' }, autoDebit: false },
    );
    vi.mocked(api.current).mockResolvedValue(saved);
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /Review saved picture/ }));
    await userEvent.click(screen.getByRole('button', { name: 'What this is based on' }));
    const figures = screen.getByRole('dialog', { name: 'What this is based on' });
    const list = within(figures).getByRole('list', { name: 'Saved items' });
    expect(list).toBeVisible(); expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(figures).getByRole('article', { name: 'Money available' })).toHaveTextContent('₹5,000.00');
    expect(list).toHaveTextContent('Salary'); expect(list).toHaveTextContent('₹30,000.00'); expect(list).toHaveTextContent('25 Sept 2026');
    expect(list).toHaveTextContent('Rent'); expect(list).toHaveTextContent('₹12,000.00'); expect(list).toHaveTextContent('13 Sept 2026');
    expect(list).toHaveTextContent('Bonus'); expect(list).toHaveTextContent('Estimate'); expect(list).toHaveTextContent('Uncertain income · Excluded from balances');
    expect(list).toHaveTextContent('Utility bill'); expect(within(list).getByRole('article', { name: 'Utility bill' })).toHaveTextContent('Unknown'); expect(list).toHaveTextContent('Date unknown');
    expect(list).not.toHaveTextContent('₹0.00'); expect(list).toHaveTextContent('Optional purchase');
    expect(within(list).getAllByRole('article').map(item => item.getAttribute('aria-label'))).toEqual(['Salary', 'Rent', 'Bonus', 'Utility bill', 'Optional purchase']);
    const corrected = structuredClone(saved); corrected.sequence = 2; corrected.revision = 1;
    corrected.facts.records[0].amount.amountPaise = 3200000; corrected.facts.records[0].schedule.date = '2026-09-24';
    corrected.facts.records[1].label = 'Home rent'; corrected.facts.records[1].amount.amountPaise = 1100000; corrected.facts.records[1].schedule.date = '2026-09-14';
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances.at(-1)!.emit('snapshot', corrected));
    expect(list).toHaveTextContent('₹32,000.00'); expect(list).toHaveTextContent('24 Sept 2026');
    expect(list).toHaveTextContent('Home rent'); expect(list).toHaveTextContent('₹11,000.00'); expect(list).toHaveTextContent('14 Sept 2026');
    expect(list).not.toHaveTextContent('₹30,000.00'); expect(list).not.toHaveTextContent('25 Sept 2026');
    expect(within(list).getAllByRole('article').map(item => item.getAttribute('aria-label'))).toEqual(['Salary', 'Home rent', 'Bonus', 'Utility bill', 'Optional purchase']);
    act(() => Stream.instances.at(-1)!.emit('snapshot', saved));
    expect(list).toHaveTextContent('₹32,000.00'); expect(list).toHaveTextContent('14 Sept 2026');
    const user = userEvent.setup();
    await user.click(within(figures).getByRole('button', { name: 'Close what this is based on' }));
    screen.getByRole('button', { name: 'Your figures' }).focus();
    await user.keyboard('{Enter}');
    expect(figures).not.toBeVisible();
    const overview = screen.getByRole('region', { name: 'Your figures' });
    await waitFor(() => expect(within(overview).getByRole('heading', { name: 'Your figures' })).toHaveFocus());
    expect(within(overview).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    const all = within(overview).getByRole('list', { name: 'Saved items' });
    expect(all).toBeVisible(); expect(within(all).getAllByRole('listitem')).toHaveLength(5);
    expect(all).toHaveTextContent('Optional purchase'); expect(all).toHaveTextContent('₹32,000.00');
    expect(screen.queryByRole('button', { name: 'Save figures' })).not.toBeInTheDocument();
    await user.click(within(overview).getByRole('link', { name: 'Back to conversation' }));
    expect(overview).not.toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    expect(api.save).not.toHaveBeenCalled();
  });
  it('reveals a qualified gap from SSE without opening figures or fabricating unknown outflows', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Start conversation' });
    const saved = snapshot();
    saved.sequence = 1; saved.revision = 1;
    saved.facts.records = [{ id: 'bill', label: 'Bill', kind: 'essential', amount: { status: 'unknown', amountPaise: null }, schedule: { recurrence: 'once', date: null }, autoDebit: false }];
    saved.plan = { ...saved.plan, firstGap: { date: '2026-09-13', amountPaise: 700000 } };
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances.at(-1)!.emit('snapshot', saved));
    await userEvent.click(screen.getByRole('button', { name: /Review saved picture/ }));
    const picture = screen.getByRole('region', { name: 'Your financial picture' });
    expect(picture).toHaveTextContent('₹7,000.00');
    expect(picture).toHaveTextContent('Not all costs are included');
    expect(within(picture).queryByText('Known upcoming outflows')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dated cash flow', hidden: true })).not.toBeVisible();
  });
  it('does not create a session on StrictMode mount and honestly explains voice', async () => {
    vi.mocked(api.current).mockRejectedValue(new ApiError(404, { code: 'notFound', message: 'No session' }));
    render(<StrictMode><App /></StrictMode>);
    const start = await screen.findByRole('button', { name: 'Start conversation' });
    await waitFor(() => expect(start).toBeEnabled());
    expect(api.start).not.toHaveBeenCalled();
    await userEvent.click(start);
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled();
    expect(screen.getByText('Conversations unavailable', { selector: '.voice-status' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check availability' })).toBeEnabled();
    for (const element of screen.queryAllByText(/AZURE|DAILY_API_KEY|Missing setup/)) expect(element).not.toBeVisible();
    expect(api.start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Prefer typing?' }));
    const figures = within(screen.getByRole('region', { name: 'Your figures' }));
    await userEvent.click(figures.getByRole('button', { name: 'Add figures' }));
    await figures.findByRole('button', { name: 'Edit figures' });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(figures.getByText('Available cash', { selector: 'dt' }).parentElement).toHaveTextContent('Unknown');
    expect(figures.getByText('No items saved yet. Empty categories still need your confirmation.')).toBeVisible();
    expect(api.save).not.toHaveBeenCalled();
  });
  it('shows unknown opening and balances, not fabricated zero', async () => {
    render(<App />);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    expect(screen.getByRole('heading', { name: 'What still needs checking', hidden: true })).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Your figures' }));
    const term = await screen.findByText('Available cash', { selector: 'dt' });
    expect(term.parentElement).toHaveTextContent('Unknown');
    expect(term.parentElement).not.toHaveTextContent('₹0.00');
    expect(screen.getByText('Projected closing cash').parentElement).toHaveTextContent('Unknown');
    expect(screen.getByText(/11 Sept 2026 – 10 Oct 2026/)).toBeVisible();
  });
  it('rejects precision errors and supports explicit none rather than empty reviewed categories', async () => {
    render(<App />);
    const user = await editCash('1.234');
    expect(within(screen.getByLabelText('Income', { selector: 'select' })).getByRole('option', { name: 'Reviewed all items' })).toBeDisabled();
    for (const label of ['Income', 'Essentials', 'Debt payments', 'Optional spending']) await user.selectOptions(screen.getByLabelText(label, { selector: 'select' }), 'none');
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(screen.getByRole('alert')).toHaveTextContent('up to two decimal places');
    expect(api.save).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Available cash (₹)'));
    await user.type(screen.getByLabelText('Available cash (₹)'), '0');
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.save).mock.calls[0][0].operation).toMatchObject({ type: 'replaceFacts', facts: { opening: { amount: '0', status: 'exact' }, coverage: { income: 'none', debt: 'none', essential: 'none', optional: 'none' } } });
  });
  it('retains exactly the same UUID and body for a save whose network response was lost', async () => {
    vi.mocked(api.save).mockRejectedValueOnce(new TypeError('Network failed'));
    render(<App />);
    const user = await editCash('100.01');
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    const retry = await screen.findByRole('button', { name: 'Retry same save' });
    expect(screen.getByLabelText('Available cash (₹)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same save' })).not.toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'Your figures' })).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(vi.mocked(api.save).mock.calls[0][0]).toBe(vi.mocked(api.save).mock.calls[1][0]);
  });
  it('keeps a draft across figure views and route navigation, then returns to the saved overview', async () => {
    const saved = snapshot(); saved.revision = 1; saved.sequence = 1;
    saved.facts.opening = { status: 'exact', amountPaise: 12345 };
    vi.mocked(api.save).mockResolvedValue(saved);
    render(<App />);
    const user = await editCash('123.45');
    const page = screen.getByRole('region', { name: 'Your figures' });
    const figures = within(page);
    const input = figures.getByRole('textbox', { name: 'Available cash (₹)' });
    const navigation = figures.getByRole('navigation', { name: 'Figure views' });
    expect(within(navigation).getAllByRole('button').map(button => button.textContent)).toEqual(['Overview', 'Edit figures', 'Spending changes']);
    await user.click(figures.getByRole('button', { name: 'Overview' }));
    expect(input).not.toBeVisible();
    expect(figures.getByText('Available cash', { selector: 'dt' }).parentElement).toHaveTextContent('Unknown');
    await user.click(figures.getByRole('link', { name: 'Back to conversation' }));
    expect(page).not.toBeVisible();
    const reopen = screen.getByRole('button', { name: 'Review your draft' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    await user.click(reopen);
    await user.click(figures.getByRole('button', { name: 'Edit figures' }));
    expect(figures.getByRole('textbox', { name: 'Available cash (₹)' })).toBe(input);
    expect(input).toHaveValue('123.45');
    expect(navigation).toBeVisible();
    await user.click(figures.getByRole('button', { name: 'Save figures' }));
    await waitFor(() => expect(figures.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true'));
    expect(figures.queryByRole('textbox', { name: 'Available cash (₹)' })).not.toBeInTheDocument();
    expect(figures.getByText('Available cash', { selector: 'dt' }).parentElement).toHaveTextContent('₹123.45');
    expect(screen.queryByRole('button', { name: 'Review your draft' })).not.toBeInTheDocument();
    expect(api.save).toHaveBeenCalledOnce();
  });
  it('reconciles staleRevision without replacing the draft silently', async () => {
    const latest = { ...snapshot(), revision: 2, sequence: 2 };
    latest.facts.opening = { status: 'exact', amountPaise: 50000 };
    vi.mocked(api.save).mockRejectedValueOnce(new ApiError(409, { code: 'staleRevision', message: 'Changed', snapshot: latest }));
    render(<App />);
    const user = await editCash('100');
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    await screen.findByRole('heading', { name: 'Saved figures changed elsewhere' });
    expect(screen.getByLabelText('Available cash (₹)')).toHaveValue('100');
    expect(screen.getByRole('button', { name: 'Save figures' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Available cash', { selector: 'dt' }).parentElement).toHaveTextContent('₹500.00');
    await user.click(screen.getByRole('button', { name: 'Edit figures' }));
    await user.click(screen.getByRole('button', { name: 'Keep my draft' }));
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(api.save).mock.calls;
    expect(calls[1][0].expectedRevision).toBe(2);
    expect(calls[1][0].commandId).not.toBe(calls[0][0].commandId);
    expect(calls[1][0].operation).toMatchObject({ type: 'replaceFacts', facts: { opening: { amount: '100' } } });
  });
  it('preserves the editor on reconnect, accepts named full snapshots, and allows use of saved figures', async () => {
    render(<App />);
    const user = await editCash('99');
    act(() => Stream.instances.at(-1)!.onerror?.());
    expect(screen.getByText('Reconnecting · figures may be out of date')).toBeVisible();
    expect(screen.getByLabelText('Available cash (₹)')).toHaveValue('99');
    const latest = { ...snapshot(), revision: 1, sequence: 1 };
    latest.facts.opening = { status: 'exact', amountPaise: 20000 };
    act(() => Stream.instances.at(-1)!.emit('snapshot', latest));
    await user.click(screen.getByRole('button', { name: 'Use saved figures' }));
    expect(screen.getByLabelText('Available cash (₹)')).toHaveValue('200.00');
  });
  it.each(['expired', 'deleted', 'notFound', 'unavailable'])('closes the stream on %s and keeps draft values', async (name) => {
    const view = render(<App />);
    await editCash('12');
    const stream = Stream.instances.at(-1)!;
    act(() => stream.emit(name, { code: name, message: 'Stopped' }));
    expect(stream.closed).toBe(true);
    expect(screen.getByLabelText('Available cash (₹)')).toHaveValue('12');
    expect(screen.getByLabelText('Available cash (₹)')).toBeDisabled();
    view.unmount();
    expect(Stream.instances.every((stream) => stream.closed)).toBe(true);
  });
  it('distinguishes unavailable from empty, and expired restart deletes before creating', async () => {
    vi.mocked(api.current).mockRejectedValueOnce(new ApiError(503, { code: 'unavailable', message: 'Storage error' }));
    render(<App />);
    await screen.findByRole('heading', { name: 'Connection unavailable' });
    expect(screen.queryByRole('button', { name: 'Add figures' })).not.toBeInTheDocument();
    vi.mocked(api.current).mockRejectedValueOnce(new ApiError(410, { code: 'expired', message: 'Expired' }));
    await userEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start again' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Your figures' }));
    await screen.findByRole('button', { name: 'Edit figures' });
    expect(vi.mocked(api.delete).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.start).mock.invocationCallOrder[0]);
  });
  it('shows first and peak gap despite positive closing and an incomplete projection', () => {
    const saved = snapshot();
    saved.plan = { ...saved.plan, closingPaise: 1000000, troughPaise: -1600000, peakGapPaise: 1600000, firstGap: { date: '2026-09-13', amountPaise: 700000 } };
    render(<Projection snapshot={saved} stale={false} />);
    expect(screen.getByText('First cash gap').parentElement).toHaveTextContent('₹7,000.00');
    expect(screen.getByText('Largest cash gap').parentElement).toHaveTextContent('₹16,000.00');
    expect(screen.getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    expect(screen.getByRole('heading', { name: 'What still needs checking' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Next steps' })).toHaveTextContent(saved.plan.decisionAssessment!.actions![0].question);
    expect(screen.getByText('Not all costs are included.')).toBeVisible();
  });
  it('labels a known minimum without pretending the unknown selected target was resolved', () => {
    const saved = snapshot();
    saved.facts.opening = { amountPaise: 10000, status: 'exact' };
    saved.facts.records = [{ id: 'card', label: 'Card', kind: 'debt', debtType: 'card',
      amount: { amountPaise: 50000, status: 'exact' }, target: { amountPaise: null, status: 'unknown' },
      schedule: { date: '2026-09-12', recurrence: 'once' }, autoDebit: false }];
    saved.plan = { ...saved.plan, outflowPaise: 50000, closingPaise: -40000, troughPaise: -40000,
      peakGapPaise: 40000, firstGap: { date: '2026-09-12', amountPaise: 40000 }, events: [{
        id: 'card:2026-09-12', recordId: 'card', label: 'Card', kind: 'debt', date: '2026-09-12',
        originalDueDate: '2026-09-12', amountPaise: 50000, amountBasis: 'requiredOnly',
        included: true, overdue: false, autoDebit: false, balancePaise: -40000,
      }] };
    render(<Projection snapshot={saved} stale={false} />);
    expect(screen.getByText('Required / minimum only · selected target unknown.')).toBeVisible();
    expect(screen.getByText('First cash gap').parentElement).toHaveTextContent('₹400.00');
    expect(screen.getByRole('list', { name: 'Saved items' })).toHaveTextContent('Selected target: Unknown');
    expect(screen.getByText('Known outflows').parentElement).toHaveTextContent('₹500.00');
  });
});