// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import type { Command, MoneyInput, Snapshot } from '../src/api';
import { MoneyEdit } from '../src/MoneyEdit';
import type { EditTarget } from '../src/MoneyEdit';
import { MoneyRecords } from '../src/MoneyRecords';
import { MoneyUpcoming } from '../src/MoneyUpcoming';
import { MoneyPrint } from '../src/MoneyPrint';
import { FinancialContext } from '../src/FinancialContext';
import { ConflictReview, ResultDetails } from '../src/WorkspaceDetails';
import { draftFacts, moneyError, moneyInput, scheduleLabel } from '../src/money';
import { scheduleAmounts, scheduleDraft, schedulePatch } from '../src/ScheduleFields';
import { initialState } from '../src/session';
import { planningSnapshot, scenario, settings } from './fixtures';
import { projectWorkspace } from './workspace';

/** Creates an exact USD source fixture with a dated conversion rate and zero fee. */
function source(): MoneyInput {
  return { amount: '125.50', status: 'exact', conversion: { currency: 'USD', rate: '83.12345678', rateStatus: 'exact', rateDate: '2026-09-10', fee: '0', feeStatus: 'exact', direction: 'receipt' } };
}

/** Builds a freelance-income fixture retaining original USD terms beside supplied INR values. */
function income(): Snapshot {
  const saved = planningSnapshot();
  saved.facts.records[0] = { ...saved.facts.records[0], kind: 'income', label: 'Freelance income', reliability: 'reliable', controllability: null,
    amount: { amountPaise: 1043200, status: 'exact', source: source() } };
  saved.plan.events = [{ ...saved.plan.events[0], label: 'Freelance income', kind: 'income', amountPaise: 1043200, amountStatus: 'exact',
    requiredPaise: null, requiredStatus: 'unknown', source: source(), scheduleIndex: 0 }];
  saved.plan.planningFacts = structuredClone(saved.facts);
  return projectWorkspace(saved);
}

/** Renders a record editor with live-session props and exposes its command spy. */
function editor(saved = income(), field: EditTarget['field'] = 'amount') {
  const onCommand = vi.fn();
  const props = { target: { recordId: saved.facts.records[0].id, field }, snapshot: saved,
    state: { ...initialState, phase: 'ready' as const, connection: 'live' as const, snapshot: saved, settings },
    active: true, onCommand, onClose: vi.fn(), onRetry: vi.fn() };
  return { ...render(<MoneyEdit {...props} />), props, onCommand };
}

it('opens income in original units and preserves every conversion assumption in an amount correction', async () => {
  const saved = income(); const original = structuredClone(saved);
  const { onCommand } = editor(saved);
  expect(screen.getByLabelText('Currency')).toHaveValue('foreign');
  expect(screen.getByLabelText('Currency code')).toHaveValue('USD');
  expect(screen.getByLabelText('Original amount (USD)')).toHaveValue('125.50');
  expect(screen.getByText(/Last saved:/)).toHaveTextContent('Calculated INR: ₹10,432.00');
  fireEvent.change(screen.getByLabelText('Original amount (USD)'), { target: { value: '130.75' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0, records: [
    { id: 'rent', delete: false, distinct: false, amount: { ...source(), amount: '130.75' } },
  ] } });
  expect(saved).toEqual(original);
});

it('leaves foreign source untouched in an unrelated ordinary name correction', async () => {
  const { onCommand } = editor(income(), 'label');
  fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Overseas work' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: 'rent', delete: false, distinct: false, label: 'Overseas work' }] } });
});

it('keeps missing rate and fee unknown while allowing the original amount to be corrected', async () => {
  const saved = income();
  saved.facts.records[0].amount = { amountPaise: null, status: 'unknown', source: { ...source(), conversion: { ...source().conversion!, rate: null, rateStatus: 'unknown', fee: null, feeStatus: 'unknown' } } };
  const { onCommand } = editor(saved);
  expect(screen.getByLabelText('Original amount (USD)')).toHaveValue('125.50');
  expect(screen.getByLabelText('Rate (INR per 1 USD)')).toBeDisabled();
  expect(screen.getByLabelText('INR deduction (₹)')).toBeDisabled();
  expect(screen.getByText(/Last saved:/)).toHaveTextContent('Calculated INR: Unknown');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0].amount).toEqual(saved.facts.records[0].amount.source);
});

it('starts foreign conversion with unknown terms and requires an explicit zero deduction', async () => {
  const saved = income(); saved.facts.records[0].amount = { amountPaise: 12550, status: 'exact' };
  const { onCommand } = editor(saved);
  expect(screen.getByLabelText('Currency')).toHaveValue('INR');
  await userEvent.selectOptions(screen.getByLabelText('Currency'), 'foreign');
  fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'eur' } });
  expect(screen.getByLabelText('Currency code')).toHaveValue('EUR');
  expect(screen.getByLabelText('Deduction certainty')).toHaveValue('unknown');
  await userEvent.selectOptions(screen.getByLabelText('Rate certainty'), 'estimate');
  fireEvent.change(screen.getByLabelText('Rate (INR per 1 EUR)'), { target: { value: '90.12345678' } });
  await userEvent.selectOptions(screen.getByLabelText('Deduction certainty'), 'exact');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('including 0 for no deduction');
  fireEvent.change(screen.getByLabelText('INR deduction (₹)'), { target: { value: '0' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0].amount).toEqual({ amount: '125.50', status: 'exact', conversion: { currency: 'EUR', rate: '90.12345678', rateStatus: 'estimate', rateDate: null, fee: '0', feeStatus: 'exact', direction: 'receipt', provider: null, fetchedAt: null } });
});

it('keeps nested-only edits dirty and protects a stale draft and pending-save retry', async () => {
  const { props, rerender } = editor();
  await userEvent.selectOptions(screen.getByLabelText('Rate certainty'), 'estimate');
  expect(screen.getByLabelText('Detail')).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Close correct freelance income' }));
  expect(screen.getByRole('button', { name: 'Discard correction' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  rerender(<MoneyEdit {...props} snapshot={{ ...props.snapshot, revision: 1 }} />);
  expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  expect(screen.getByLabelText('Rate certainty')).toHaveValue('estimate');
  const pending = { commandId: 'command', expectedRevision: 0, operation: { type: 'updateFacts' as const, changes: { expectedRevision: 0 } } };
  rerender(<MoneyEdit {...props} state={{ ...props.state, pending }} />);
  await userEvent.click(screen.getByRole('button', { name: 'Retry same save' }));
  expect(props.onRetry).toHaveBeenCalledOnce(); expect(props.onCommand).not.toHaveBeenCalled();
});

it('preserves scalar FX source terms through the inline live amount field', async () => {
  const saved = income(); const onCommand = vi.fn().mockResolvedValue(undefined);
  const original = structuredClone(saved);
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={onCommand} proposalActive={false} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit Freelance income amount' }));
  expect(screen.getByRole('textbox', { name: 'Freelance income amount (USD)' })).toHaveValue('125.50');
  fireEvent.change(screen.getByRole('textbox', { name: 'Freelance income amount (USD)' }), { target: { value: '140' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save Freelance income amount' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: saved.revision,
    records: [{ id: 'rent', delete: false, distinct: false, amount: { ...source(), amount: '140' } }],
  } });
  expect(screen.getByLabelText('Freelance income calculated net INR')).toHaveTextContent('₹10,432');
  expect(saved).toEqual(original);
});

it('selects a foreign conflict with unknown INR using its concrete original amount and source terms', async () => {
  const saved = income(); const onCommand = vi.fn().mockResolvedValue(saved);
  const conflict = { id: 'foreign-conflict', recordId: 'rent', field: 'amount' as const, values: [
    { id: 'a', status: 'exact' as const, amountPaise: null, source: { ...source(), conversion: { ...source().conversion!, rate: null, rateStatus: 'unknown' as const } } },
    { id: 'b', status: 'estimate' as const, amountPaise: 1660000, source: { ...source(), amount: '200', status: 'estimate' as const } },
  ] };
  render(<ConflictReview {...{ conflict, snapshot: saved, onCommand }} blocked={false} />);
  await userEvent.click(screen.getByRole('button', { name: 'Resolve Freelance income · Amount' }));
  await userEvent.click(screen.getByRole('radio', { name: /Report 1: USD 125.50/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirm selected report' }));
  expect(onCommand.mock.calls[0][0].changes.resolutions[0].value).toEqual({ ...conflict.values[0].source, id: 'a' });
});

it('keeps currency and rate configuration for a third conflict value rather than relabeling it INR', async () => {
  const saved = income(); const onCommand = vi.fn().mockResolvedValue(saved);
  const conflict = { id: 'conflict', recordId: 'rent', field: 'amount' as const, values: [
    { id: 'a', status: 'exact' as const, amountPaise: 1043200, source: source() },
    { id: 'b', status: 'estimate' as const, amountPaise: 2000000, source: { ...source(), amount: '250' } },
  ] };
  render(<ConflictReview {...{ conflict, snapshot: saved, onCommand }} blocked={false} />);
  await userEvent.click(screen.getByRole('button', { name: 'Resolve Freelance income · Amount' }));
  await userEvent.click(screen.getByRole('radio', { name: /Neither report/ }));
  expect(screen.getByLabelText('Currency code')).toHaveValue('USD');
  fireEvent.change(screen.getByLabelText('Original amount (USD)'), { target: { value: '150' } });
  await userEvent.click(screen.getByRole('button', { name: 'Confirm entered value' }));
  expect(onCommand.mock.calls[0][0].changes.resolutions[0].value).toEqual({ ...source(), amount: '150', id: expect.any(String) });
});

it('edits daily cadence, inclusive end and finite count without replacing the start date', async () => {
  const { onCommand } = editor(planningSnapshot(), 'recurrence');
  await userEvent.selectOptions(screen.getByLabelText('Repeats'), 'daily');
  fireEvent.change(screen.getByLabelText('End date (inclusive, optional)'), { target: { value: '2026-09-30' } });
  fireEvent.change(screen.getByLabelText('Number of occurrences (optional)'), { target: { value: '8' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: 'rent', delete: false, distinct: false, schedule: { recurrence: 'daily', endDate: '2026-09-30', count: 8 } }] } });
});

it('makes monthly budget distribution and calendar-month count explicit without changing the scalar amount', async () => {
  const { onCommand } = editor(planningSnapshot(), 'recurrence');
  await userEvent.selectOptions(screen.getByLabelText('Repeats'), 'monthlyBudget');
  expect(screen.getByText(/An estimated cash budget/)).toHaveTextContent('not a scheduled payment or lender due date');
  fireEvent.change(screen.getByLabelText('Number of calendar months (optional)'), { target: { value: '2' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0]).toEqual({ id: 'rent', delete: false, distinct: false, schedule: { recurrence: 'monthlyBudget', count: 2 } });
});

it.each(['income', 'debt'] as const)('never offers monthly budget for %s', kind => {
  const saved = income(); saved.facts.records[0].kind = kind;
  editor(saved, 'recurrence');
  expect(screen.queryByRole('option', { name: /Monthly budget/ })).not.toBeInTheDocument();
});

it('keeps INR correction unchanged while offering currency controls', async () => {
  const { onCommand } = editor(planningSnapshot());
  expect(screen.getByLabelText('Currency')).toHaveValue('INR');
  fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '12000.10' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0]).toEqual({ id: 'rent', delete: false, distinct: false, amount: { amount: '12000.10', status: 'exact' } });
});

it('submits an ordered variable sequence and unknown scalar in one patch without enumerating dates', async () => {
  const saved = income(); saved.facts.records[0].schedule.recurrence = 'weekly';
  const { onCommand } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Amount pattern'), 'variable');
  await userEvent.click(screen.getByRole('button', { name: 'Add occurrence amount' }));
  const second = screen.getByRole('group', { name: 'Occurrence 2' });
  await userEvent.selectOptions(within(second).getByLabelText('Amount certainty'), 'estimate');
  fireEvent.change(within(second).getByLabelText('Amount (₹)'), { target: { value: '300' } });
  expect(screen.getByLabelText('Number of occurrences (optional)')).toHaveValue(2);
  expect(screen.getByLabelText('Number of occurrences (optional)')).toBeDisabled();
  expect(screen.getAllByRole('textbox', { name: /^(Original amount|Amount \(₹\))/ })).toHaveLength(2);
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0]).toEqual({ id: 'rent', delete: false, distinct: false,
    amount: { amount: null, status: 'unknown', conversion: null }, schedule: { count: 2, amounts: [source(), { amount: '300', status: 'estimate', conversion: null }] } });
});

it('requires an explicit action to clear a debt target before varying required payments', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].kind = 'debt'; saved.facts.records[0].target = { amountPaise: 1300000, status: 'exact' };
  const { onCommand } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Amount pattern'), 'variable');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Explicitly clear');
  await userEvent.click(screen.getByRole('checkbox', { name: /Clear the single intended payment/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0]).toMatchObject({ target: null, amount: { amount: null, status: 'unknown' }, schedule: { amounts: [{ amount: '12000.00', status: 'exact' }] } });
});

it('switches back to one amount by explicitly clearing the list and preserving the finite count', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'weekly', count: 2, amounts: [{ amount: '10', status: 'exact' }, { amount: '20', status: 'estimate' }] };
  const { onCommand } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Amount pattern'), 'same');
  await userEvent.selectOptions(screen.getByLabelText('Amount certainty'), 'exact');
  fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '15' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0]).toEqual({ id: 'rent', delete: false, distinct: false, amount: { amount: '15', status: 'exact' }, schedule: { count: 2, amounts: [] } });
});

it('bounds accessible amount rows and removes an occurrence without losing other source input', async () => {
  const saved = income(); saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'daily', count: 6, amounts: Array.from({ length: 6 }, source) };
  const { onCommand } = editor(saved);
  expect(within(screen.getByRole('list', { name: 'Ordered occurrence amounts' })).getAllByRole('listitem')).toHaveLength(5);
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('button', { name: 'Remove occurrence 6' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0].schedule).toEqual({ count: 5, amounts: Array.from({ length: 5 }, source) });
});

it('shows occurrence-specific source/status and saved balances, never preview values, in upcoming and print', () => {
  const saved = income(); saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'weekly', count: 2, amounts: [source(), { amount: '200', status: 'estimate' }] };
  saved.preview = scenario(); saved.preview.plan.events[0].amountPaise = 9999900;
  saved.plan.events[0].amountStatus = 'estimate'; saved.plan.events[0].source = { ...source(), status: 'estimate' };
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /><MoneyPrint snapshot={saved} /></MemoryRouter>);
  const row = within(screen.getByRole('region', { name: 'Upcoming money and payments' })).getByRole('listitem', { name: 'Freelance income' });
  expect(row).toHaveTextContent('Occurrence 1 of 2'); expect(row).toHaveTextContent('USD 125.50');
  expect(row).toHaveTextContent('Estimated'); expect(row).toHaveTextContent('+₹10,432.00');
  expect(row).not.toHaveTextContent('₹99,999.00');
  const print = screen.getByLabelText('Saved plan for printing');
  expect(print).toHaveTextContent('Varies by occurrence'); expect(print).toHaveTextContent('83.12345678');
  expect(print).not.toHaveTextContent('₹99,999.00');
});

it('labels budget facts per month and timeline occurrences as estimates, not lender payments', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].label = 'Food budget';
  saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'monthlyBudget', count: 2, endDate: '2026-10-15' };
  saved.plan.events[0] = { ...saved.plan.events[0], label: 'Food budget', amountPaise: 40000, amountBasis: 'budget', amountStatus: 'estimate', requiredPaise: null, requiredStatus: 'unknown', source: null, scheduleIndex: null };
  projectWorkspace(saved);
  render(<MemoryRouter><MoneyRecords category="spending" snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} /><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const facts = within(screen.getByRole('list', { name: 'Money items' })).getByRole('listitem', { name: 'Food budget' });
  expect(within(facts).getByText('per calendar month')).toBeVisible();
  expect(within(facts).getByText(/2 calendar months/)).not.toBeVisible();
  expect(within(facts).getByRole('button', { name: 'Edit Food budget amount' })).toHaveTextContent('₹12,000.00');
  expect(within(facts).getByText('Budget estimate · not a bill')).toBeVisible();
  const event = within(screen.getByRole('list', { name: 'Upcoming events' })).getByRole('listitem', { name: 'Food budget' });
  expect(within(event).getByText('Budget estimate')).toBeVisible(); expect(event).toHaveTextContent('−₹400.00');
  expect(event).not.toHaveTextContent('Originally due'); expect(event).not.toHaveTextContent('Required / minimum');
  await userEvent.click(within(facts).getByRole('button', { name: 'Details for Food budget' }));
  const details = screen.getByRole('dialog', { name: 'Details for Food budget' });
  expect(details).toHaveTextContent('2 calendar months'); expect(details).toHaveTextContent('15 Oct 2026 (inclusive)');
  expect(details).toHaveTextContent('not a confirmed payment due date');
});

it('shows the selected live occurrence source instead of reporting an unknown scalar total', () => {
  const saved = income(); saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'daily', count: 1, amounts: [source()] };
  saved.plan.occurrenceAmounts = { rent: [{ amountPaise: 1043200, status: 'exact', source: source() }] };
  projectWorkspace(saved);
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />);
  const record = screen.getByRole('listitem', { name: 'Freelance income' });
  expect(record).toHaveTextContent('Occurrence 1 of 1'); expect(record).not.toHaveTextContent('Amount is unknown');
  expect(record).toHaveTextContent('USD 125.50');
  expect(within(record).getByLabelText('Freelance income calculated net INR')).toHaveTextContent(/^Net INR ₹10,432Calculated$/);
});

it('explains backend conversion and monthly-budget assumptions without exposing reason keys', async () => {
  const saved = income();
  const result = saved.workspace!.results![0];
  result.assumptions = ['monthlyBudgetEvenDailyForecastActualMonthLength', 'currencyConversionReportedRateAndFeeOnly'];
  saved.workspace!.contributions![0].reason = 'currencyConversion';
  render(<ResultDetails snapshot={saved} result={result} />);
  await userEvent.click(screen.getByRole('button', { name: 'Why this result?' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('actual days'); expect(dialog).toHaveTextContent('not actual bank rates or net quotes');
  expect(dialog).not.toHaveTextContent('currencyConversion'); expect(dialog).not.toHaveTextContent('Conditional receipt 1');
});

it('deep-clones source conversions and schedules and retains unknowns in full drafts', () => {
  const saved = income(); saved.facts.records[0].schedule.amounts = [source()];
  const original = structuredClone(saved);
  const draft = draftFacts(saved);
  expect(draft.records[0].amount).toEqual(source());
  draft.records[0].amount.conversion!.rate = '1'; draft.records[0].schedule.amounts![0].conversion!.fee = '10';
  expect(saved).toEqual(original);
  expect(moneyInput(saved.facts.records[0].amount)).toEqual(source());
});

it.each(['0', '-1', '1.123456789', '1e2'])('rejects invalid supplied exchange rate %s without calculating INR', rate => {
  expect(moneyError({ ...source(), conversion: { ...source().conversion!, rate } }, settings.maxMoneyPaise)).toContain('greater than zero');
});

it('represents cleared finite bounds explicitly and labels calendar cadence without financial arithmetic', () => {
  const schedule = { date: '2026-09-13', certainty: 'exact' as const, recurrence: 'daily' as const, basis: 'payment' as const, endDate: '2026-09-20', count: 4 };
  expect(schedulePatch({ ...scheduleDraft(schedule), endDate: '', count: '' }, schedule)).toEqual({ endDate: null, count: null });
  expect(scheduleLabel(schedule)).toContain('4 occurrences');
});

it.each(['0', '1001', '1.5'])('rejects an invalid finite count %s without sending a patch', async count => {
  const { onCommand } = editor(planningSnapshot(), 'recurrence');
  await userEvent.selectOptions(screen.getByLabelText('Repeats'), 'daily');
  fireEvent.change(screen.getByLabelText('Number of occurrences (optional)'), { target: { value: count } });
  fireEvent.submit(screen.getByLabelText('Repeats').closest('form')!);
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('whole count from 1 to 1000');
});

it('does not silently clear auto debit or a variable sequence to enable a monthly budget', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].autoDebit = true;
  const { onCommand } = editor(saved, 'recurrence');
  expect(screen.getByRole('option', { name: /Monthly budget/ })).toBeDisabled();
  await userEvent.selectOptions(screen.getByLabelText('Repeats'), 'monthlyBudget');
  expect(screen.getByLabelText('Repeats')).toHaveValue('once');
  expect(onCommand).not.toHaveBeenCalled();
});

it('keeps budget amounts scalar and does not offer automatic debit', () => {
  const saved = planningSnapshot(); saved.facts.records[0].schedule.recurrence = 'monthlyBudget';
  editor(saved);
  expect(screen.getByRole('option', { name: 'Varies by occurrence' })).toBeDisabled();
  expect(screen.queryByRole('option', { name: 'Automatic debit' })).not.toBeInTheDocument();
  expect(screen.getByText(/Amount per calendar month/)).toBeVisible();
});

it('requires fresh conversion assumptions when the user changes the foreign currency', async () => {
  const { onCommand } = editor();
  fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'EUR' } });
  expect(screen.getByLabelText('Rate certainty')).toHaveValue('unknown');
  expect(screen.getByLabelText('Deduction certainty')).toHaveValue('unknown');
  expect(screen.getByLabelText('Rate as of (optional)')).toHaveValue('');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0].amount).toEqual({ amount: '125.50', status: 'exact', conversion: {
    currency: 'EUR', rate: null, rateStatus: 'unknown', rateDate: null, fee: null, feeStatus: 'unknown', direction: 'receipt',
  } });
});

it('serializes every INR occurrence explicitly so removing a foreign row cannot transfer its currency', () => {
  expect(scheduleAmounts([{ amount: '300', status: 'exact' }, source()])).toEqual([{ amount: '300', status: 'exact', conversion: null }, source()]);
});

it.each([null, undefined, 2])('preserves the effective finite count when clearing a sequence with persisted count %s', count => {
  const schedule = { date: '2026-09-13', certainty: 'exact' as const, recurrence: 'weekly' as const, basis: 'payment' as const, count, amounts: [source(), source()] };
  const draft = scheduleDraft(schedule);
  expect(draft.count).toBe('2');
  expect(schedulePatch(draft, schedule)).toEqual({});
  expect(schedulePatch({ ...draft, amounts: [] }, schedule)).toEqual({ count: 2, amounts: [] });
  expect(schedulePatch({ ...draft, amounts: [], count: '3' }, schedule)).toEqual({ count: 3, amounts: [] });
  expect(schedulePatch({ ...draft, amounts: [], count: '' }, schedule)).toEqual({ count: null, amounts: [] });
});

it.each(['exact', 'estimate', 'unknown'] as const)('saves only the selected inline FX occurrence when net INR is %s, preserving finite schedule terms', async status => {
  const saved = income(); const value = source();
  if (status === 'estimate') { value.status = 'estimate'; value.conversion!.rateStatus = 'estimate'; value.conversion!.feeStatus = 'estimate'; }
  if (status === 'unknown') { value.conversion!.rate = null; value.conversion!.rateStatus = 'unknown'; value.conversion!.fee = null; value.conversion!.feeStatus = 'unknown'; }
  saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.facts.records[0].schedule = { date: '2026-09-06', certainty: 'exact', recurrence: 'weekly', basis: 'payment', count: null, endDate: '2026-09-30',
    amounts: [{ amount: '300', status: 'exact', conversion: null }, value, { amount: null, status: 'unknown', conversion: null }] };
  saved.plan.events[0] = { ...saved.plan.events[0], scheduleIndex: 1, source: value, amountStatus: status, amountPaise: status === 'unknown' ? null : 1043200 };
  saved.plan.occurrenceAmounts = { rent: [{ amountPaise: 30000, status: 'exact' }, { amountPaise: status === 'unknown' ? null : 1043200, status, source: value }, { amountPaise: null, status: 'unknown' }] };
  projectWorkspace(saved);
  const original = structuredClone(saved);
  const receipt = structuredClone(saved); receipt.revision++; receipt.sequence++;
  receipt.facts.records[0].schedule.amounts![1] = { ...value, amount: '140.25' };
  const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(JSON.stringify(receipt)));
  vi.stubGlobal('fetch', fetch);
  /** Routes the inline edit through API serialization against the mocked receipt. */
  const onCommand = (operation: Command['operation']) => api.save({ commandId: 'occurrence-edit', expectedRevision: saved.revision, operation });
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={onCommand} proposalActive={false} />);
  expect(screen.getByRole('listitem', { name: 'Freelance income' })).toHaveTextContent('Occurrence 2 of 3');
  await userEvent.click(screen.getByRole('button', { name: 'Edit Freelance income occurrence 2 amount' }));
  const input = screen.getByRole('textbox', { name: 'Freelance income occurrence 2 amount (USD)' });
  expect(input).toHaveValue('125.50'); expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: '140.25' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save Freelance income occurrence 2 amount' }));
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/session/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ commandId: 'occurrence-edit', expectedRevision: saved.revision, operation: { type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: saved.revision,
      records: [{ id: 'rent', delete: false, distinct: false, schedule: { amounts: [saved.facts.records[0].schedule.amounts![0], { ...value, amount: '140.25' }, saved.facts.records[0].schedule.amounts![2]] } }],
    } } }) });
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit Freelance income occurrence 2 amount' })).toHaveFocus();
  expect(screen.getByLabelText('Freelance income calculated net INR')).toHaveTextContent(status === 'unknown' ? 'Unknown' : '₹10,432');
  expect(saved).toEqual(original);
});

describe('MoneyEdit API patches', () => {
  /** Opens a correction editor against a mocked HTTP response and returns the request spy. */
  function open(saved: Snapshot, field: EditTarget['field'] = 'amount') {
    const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(JSON.stringify(saved)));
    vi.stubGlobal('fetch', fetch);
    /** Serializes editor operations with the fixture's command identity and revision. */
    const onCommand = (operation: Command['operation']) => api.save({ commandId: 'correction', expectedRevision: saved.revision, operation });
    render(<MoneyEdit target={{ recordId: saved.facts.records[0].id, field }} snapshot={saved}
      state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }} active onCommand={onCommand} onClose={vi.fn()} onRetry={vi.fn()} />);
    return fetch;
  }

  it.each(['exact', 'estimate', 'unknown'] as const)('moves scalar FX into the sequence without losing source terms when INR is %s', async status => {
    const saved = income(); const value = source();
    if (status === 'estimate') { value.status = 'estimate'; value.conversion!.rateStatus = 'estimate'; value.conversion!.feeStatus = 'estimate'; }
    if (status === 'unknown') { value.conversion!.rate = null; value.conversion!.rateStatus = 'unknown'; value.conversion!.fee = null; value.conversion!.feeStatus = 'unknown'; }
    saved.facts.records[0].amount = { amountPaise: status === 'unknown' ? null : 1043200, status, source: value };
    saved.facts.records[0].schedule.recurrence = 'weekly';
    const original = structuredClone(saved); const fetch = open(saved);
    await userEvent.selectOptions(screen.getByLabelText('Amount pattern'), 'variable');
    expect(screen.getByLabelText('Original amount (USD)')).toHaveValue('125.50');
    await userEvent.click(screen.getByRole('button', { name: 'Add occurrence amount' }));
    const second = within(screen.getByRole('group', { name: 'Occurrence 2' }));
    expect(second.getByLabelText('Currency')).toHaveValue('INR');
    expect(second.getByLabelText('Amount (₹)')).toHaveValue('');
    expect(second.getByLabelText('Amount (₹)')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/session/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ commandId: 'correction', expectedRevision: 0, operation: { type: 'updateFacts', changes: { expectedRevision: 0, records: [
        { id: 'rent', delete: false, distinct: false, amount: { amount: null, status: 'unknown', conversion: null },
          schedule: { count: 2, amounts: [value, { amount: null, status: 'unknown', conversion: null }] } },
      ] } } }) });
    expect(saved).toEqual(original);
  });

  it.each(['estimate', 'unknown'] as const)('keeps a count-null variable schedule finite when changing to a %s scalar', async status => {
    const saved = income(); saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
    saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'weekly', count: null, endDate: '2026-09-30',
      amounts: [source(), { amount: null, status: 'unknown', conversion: null }] };
    const original = structuredClone(saved); const fetch = open(saved);
    expect(screen.getByLabelText('Number of occurrences (optional)')).toHaveValue(2);
    await userEvent.selectOptions(screen.getByLabelText('Amount pattern'), 'same');
    expect(screen.getByLabelText('Currency')).toHaveValue('INR');
    expect(screen.getByLabelText('Amount (₹)')).toHaveValue('');
    if (status === 'estimate') {
      await userEvent.selectOptions(screen.getByLabelText('Amount certainty'), 'estimate');
      fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '15' } });
    }
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0][1].body)).operation.changes.records).toEqual([
      { id: 'rent', delete: false, distinct: false, amount: { amount: status === 'unknown' ? null : '15', status }, schedule: { count: 2, amounts: [] } },
    ]);
    expect(saved).toEqual(original);
  });

  it('leaves the existing INR scalar patch unchanged', async () => {
    const saved = planningSnapshot(); const fetch = open(saved);
    expect(screen.getByLabelText('Currency')).toHaveValue('INR');
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '12000.10' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0][1].body)).operation.changes.records).toEqual([
      { id: 'rent', delete: false, distinct: false, amount: { amount: '12000.10', status: 'exact' } },
    ]);
  });

  it.each(['1', '1000', ''])('edits or deliberately clears finite bounds with count "%s" without touching scalar FX', async count => {
    const saved = income(); saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'weekly', count: 2, endDate: '2026-09-30' };
    const original = structuredClone(saved); const fetch = open(saved, 'recurrence');
    fireEvent.change(screen.getByLabelText('Number of occurrences (optional)'), { target: { value: count } });
    fireEvent.change(screen.getByLabelText('End date (inclusive, optional)'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0][1].body)).operation.changes.records).toEqual([
      { id: 'rent', delete: false, distinct: false, schedule: { endDate: null, count: count ? Number(count) : null } },
    ]);
    expect(saved).toEqual(original);
  });

  it.each(['0', '-1', '1001', '1.5'])('blocks invalid finite count %s before the API request', count => {
    const saved = income(); saved.facts.records[0].schedule.recurrence = 'weekly';
    const fetch = open(saved, 'recurrence');
    fireEvent.change(screen.getByLabelText('Number of occurrences (optional)'), { target: { value: count } });
    fireEvent.submit(screen.getByLabelText('Repeats').closest('form')!);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('whole count from 1 to 1000');
  });
});