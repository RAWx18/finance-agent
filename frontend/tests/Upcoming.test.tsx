// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { MoneyUpcoming } from '../src/MoneyUpcoming';
import { MoneyPrint } from '../src/MoneyPrint';
import { choiceSnapshot, planningSnapshot, scenario, snapshot } from './fixtures';

it('shows a dated compact default with one shared forecast explanation instead of repeated visible qualifications', async () => {
  const saved = choiceSnapshot();
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const list = screen.getByRole('list', { name: 'Upcoming events' });
  const rent = within(list).getByRole('listitem', { name: 'Rent' });
  expect(within(rent).getByRole('heading', { name: 'Rent' })).toBeVisible();
  expect(within(rent).getByText('13 Sept')).toHaveAttribute('datetime', '2026-09-13');
  expect(within(rent).getByText('Essential')).toBeVisible();
  expect(within(rent).getByText('−₹12,000.00')).toBeVisible();
  expect(within(rent).getByText('Forecast -₹7,000.00')).toBeVisible();
  expect(within(list).getByText('Optional')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('2 items');
  expect(screen.getByRole('status')).toHaveClass('sr-only');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  for (const copy of screen.getAllByText(/Date: Reported|Projected balance after|Not a current bank balance|Expected money in and planned spending|Same-day payments come before income/)) {
    expect(copy).not.toBeVisible();
  }
  expect(screen.getAllByRole('button', { name: 'About this forecast' })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'About this forecast' }));
  const detail = screen.getByRole('dialog', { name: 'About this forecast' });
  expect(within(detail).getByText('Expected money in and planned spending, not completed payments or a current bank balance.')).toBeVisible();
  expect(within(detail).getByText('Same-day payments come before income in this forecast. Row order is not payment priority.')).toBeVisible();
  expect(within(detail).getByText('As of 11 Sept 2026. Earlier items are not confirmed paid or received.')).toBeVisible();
});

it.each([
  ['requiredOnly', 'Minimum only · target unknown', 'Required / minimum only · intended payment unknown'],
  ['requiredFloor', 'Minimum exceeds target', 'Current required / minimum payment exceeds the chosen target. The minimum is counted; your target is retained.'],
] as const)('keeps %s visible without replacing the reported target or hiding its full qualification', async (amountBasis, badge, explanation) => {
  const saved = choiceSnapshot('cardMinimum');
  const record = saved.facts.records[1];
  record.amount = { amountPaise: 250000, status: 'estimate' };
  record.target = { amountPaise: amountBasis === 'requiredOnly' ? null : 100000, status: amountBasis === 'requiredOnly' ? 'unknown' : 'exact' };
  saved.plan.events = [{ ...saved.plan.events[1], amountBasis, amountPaise: 250000, amountStatus: 'estimate', requiredPaise: 250000, requiredStatus: 'estimate', autoDebit: true }];
  const original = structuredClone(saved);
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const row = screen.getByRole('listitem', { name: 'Card payment' });
  for (const text of ['Card payment', 'Auto-debit', badge, 'Estimated', '−₹2,500.00', 'Forecast ₹10,000.00']) {
    expect(within(row).getByText(text, { selector: text === 'Card payment' ? 'h3' : undefined })).toBeVisible();
  }
  expect(within(row).getByText(explanation)).not.toBeVisible();
  expect(within(row).queryByText('−₹1,000.00')).not.toBeInTheDocument();
  await userEvent.click(within(row).getByRole('button', { name: 'Details for Card payment on 26 Sept 2026' }));
  expect(within(screen.getByRole('dialog', { name: 'Card payment' })).getByText(explanation)).toBeVisible();
  expect(saved).toEqual(original);
});

it.each(['estimate', 'unknown'] as const)('retains %s dates and unknown amounts as uncertainty, never a zero balance', certainty => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule.certainty = certainty;
  saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.plan.events[0] = { ...saved.plan.events[0], amountPaise: null, amountStatus: 'unknown', balancePaise: null };
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  expect(within(row).getByText('Date uncertain')).toBeVisible();
  expect(within(row).getByText('Unknown', { selector: '.money-event-value > strong' })).toBeVisible();
  expect(within(row).getByText('Unknown', { selector: '.money-event-value > span' })).toBeVisible();
  expect(within(row).getByText('Forecast Unknown')).toBeVisible();
  expect(row).not.toHaveTextContent('₹0.00');
});

it('keeps excluded uncertain income visibly separate from assured money and exposes its actual exclusion reason', async () => {
  const saved = planningSnapshot();
  saved.facts.records[0] = { ...saved.facts.records[0], kind: 'income', reliability: 'uncertain' };
  saved.plan.events[0] = { ...saved.plan.events[0], kind: 'income', included: false, amountStatus: 'estimate', amountPaise: 99000, balancePaise: -12345 };
  saved.workspace!.contributions = [
    { id: 'proposal:receipt', eventId: saved.plan.events[0].id, recordId: 'rent', amountPaise: 99000, included: false, reason: 'proposedAssumption', references: [] },
    { id: 'receipt', eventId: saved.plan.events[0].id, recordId: 'rent', amountPaise: 99000, included: false, reason: 'conditionalReceipt', references: [] },
  ];
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  for (const text of ['Money in', 'Not counted', 'Estimated', '+₹990.00', 'Forecast -₹123.45']) expect(within(row).getByText(text)).toBeVisible();
  await userEvent.click(within(row).getByRole('button', { name: 'Details for Rent on 13 Sept 2026' }));
  const detail = screen.getByRole('dialog', { name: 'Rent' });
  expect(within(detail).getByText('Not counted in balances · Receipt is not confirmed enough to count on')).toBeVisible();
  expect(detail).not.toHaveTextContent('Proposed assumption');
});

it.each(['monthlyBudget', 'weekly'] as const)('labels a %s budget estimate without calling it a lender payment or confirmed due date', async recurrence => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule = { date: null, certainty: 'unknown', recurrence, basis: 'allowance' };
  saved.plan.events[0] = { ...saved.plan.events[0], amountBasis: 'budget', amountStatus: 'estimate', amountPaise: 40000, overdue: true,
    dateAssumption: 'Forecast starts at the plan date; payment timing is not confirmed.' };
  const original = structuredClone(saved);
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  for (const text of ['Budget estimate', 'Estimated', 'Assumed date', '−₹400.00']) expect(within(row).getByText(text)).toBeVisible();
  expect(within(row).queryByText(/Originally due|Check status/)).not.toBeInTheDocument();
  const explanation = recurrence === 'monthlyBudget'
    ? 'An estimated cash budget spread evenly across each calendar month’s actual days, not a scheduled payment or lender due date. Only days within the plan and start/end dates count.'
    : 'A recurring spending allowance, not a confirmed payment date.';
  expect(within(row).getByText(explanation)).not.toBeVisible();
  await userEvent.click(within(row).getByRole('button', { name: 'Details for Rent on 13 Sept 2026' }));
  const detail = screen.getByRole('dialog', { name: 'Rent' });
  expect(within(detail).getByText(explanation)).toBeVisible();
  expect(within(detail).getByText('Date used for the forecast')).toBeVisible();
  expect(within(detail).getByText(saved.plan.events[0].dateAssumption!)).toBeVisible();
  expect(saved).toEqual(original);
});

it('opens the complete occurrence details and returns focus using only keyboard activation', async () => {
  const user = userEvent.setup();
  const saved = choiceSnapshot('cardMinimum');
  saved.facts.records[1].schedule.amounts = [{ amount: '40', status: 'exact' }, { amount: '50', status: 'estimate' }];
  saved.plan.events = [{ ...saved.plan.events[1], scheduleIndex: 1, autoDebit: true, requiredStatus: 'estimate', source: { amount: '50', status: 'estimate',
    conversion: { currency: 'USD', rate: '80', rateStatus: 'estimate', rateDate: '2026-09-10', fee: '0', feeStatus: 'exact', direction: 'payment' } } }];
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const button = screen.getByRole('button', { name: 'Details for Card payment on 26 Sept 2026' });
  expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  button.focus(); await user.keyboard('{Enter}');
  const detail = screen.getByRole('dialog', { name: 'Card payment' });
  expect(within(detail).getByRole('heading', { name: 'Card payment' })).toHaveFocus();
  for (const text of ['26 Sept 2026 · Card payment', 'Date: Reported', 'Occurrence 2 of 2', 'Intended payment · includes minimum',
    'Required / minimum for this occurrence: ₹2,000.00 · Estimated', 'Automatic debit reported']) expect(within(detail).getByText(text)).toBeVisible();
  expect(within(detail).getByText(/USD 50/)).toBeVisible();
  expect(within(detail).getByText(/Calculated INR shown alongside/)).toBeVisible();
  expect(within(detail).getByText(/Not a current bank balance/)).toBeVisible();
  within(detail).getByRole('button', { name: 'Close card payment' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(button).toHaveFocus();
  await user.keyboard(' ');
  expect(screen.getByRole('dialog', { name: 'Card payment' })).toBeVisible();
});

it('shows accepted amounts and saved-assumption badges, never the base or preview occurrence', async () => {
  const saved = choiceSnapshot('cardMinimum');
  saved.accepted = { ...scenario('accepted'), plan: structuredClone(saved.plan), adjustments: [{ ...scenario().adjustments[0],
    eventId: saved.plan.events[1].id, recordId: 'card', label: 'Card payment', kind: 'card', date: '2026-09-26', originalPaise: 400000, amountPaise: 250000, minimumPaise: 200000 }] };
  saved.accepted.plan.events = [{ ...saved.plan.events[1], amountBasis: 'assumed', amountPaise: 250000, balancePaise: -32100 }];
  saved.preview = { ...scenario('preview'), plan: structuredClone(saved.plan) };
  saved.preview.plan.events = [{ ...saved.plan.events[1], label: 'Preview card', amountPaise: 0, balancePaise: 9999900 }];
  const original = structuredClone(saved);
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const row = screen.getByRole('listitem', { name: 'Card payment' });
  for (const text of ['Saved assumption', 'Includes minimum', '−₹2,500.00', 'Forecast -₹321.00']) expect(within(row).getByText(text, { exact: true })).toBeVisible();
  expect(screen.queryByRole('listitem', { name: 'Rent' })).not.toBeInTheDocument();
  expect(screen.queryByRole('listitem', { name: 'Preview card' })).not.toBeInTheDocument();
  expect(row).not.toHaveTextContent('₹99,999.00');
  expect(within(row).queryByText('−₹4,000.00')).not.toBeInTheDocument();
  await userEvent.click(within(row).getByRole('button', { name: 'Details for Card payment on 26 Sept 2026' }));
  expect(within(screen.getByRole('dialog', { name: 'Card payment' })).getByText('Saved assumption · not paid · includes minimum')).toBeVisible();
  expect(saved).toEqual(original);
});

it('keeps backend same-day order and forecast balances without rewriting an assumed source date', async () => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule = { date: null, certainty: 'unknown', recurrence: 'weekly', basis: 'allowance' };
  saved.plan.events = [
    { ...saved.plan.events[0], id: 'z', label: 'First payment', date: '2026-09-15', balancePaise: -45600 },
    { ...saved.plan.events[0], id: 'a', label: 'Second payment', date: '2026-09-15', balancePaise: -78900 },
    { ...saved.plan.events[0], id: 'income', label: 'Income', kind: 'income', date: '2026-09-15', balancePaise: 12300 },
  ];
  saved.plan.events[0].dateAssumption = 'Weekly allowance forecast from the plan start; no payment date was reported.';
  const original = structuredClone(saved);
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const rows = within(screen.getByRole('list', { name: 'Upcoming events' })).getAllByRole('listitem');
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['First payment', 'Second payment', 'Income']);
  for (const [index, balance] of ['Forecast -₹456.00', 'Forecast -₹789.00', 'Forecast ₹123.00'].entries()) expect(within(rows[index]).getByText(balance)).toBeVisible();
  expect(within(rows[0]).getByText('15 Sept')).toHaveAttribute('datetime', '2026-09-15');
  expect(within(rows[0]).getByText('Assumed date')).toBeVisible();
  await userEvent.click(within(rows[0]).getByRole('button', { name: 'Details for First payment on 15 Sept 2026' }));
  expect(within(screen.getByRole('dialog', { name: 'First payment' })).getByText(saved.plan.events[0].dateAssumption!)).toBeVisible();
  expect(saved).toEqual(original);
  expect(saved.facts.records[0].schedule.date).toBeNull();
});

it.each([1, 2])('names %s missing dates and keeps unknown values out of dated balances', async count => {
  const saved = snapshot();
  saved.facts.records = Array.from({ length: count }, (_, index) => ({ ...planningSnapshot().facts.records[0], id: `undated-${index}`, label: `Undated ${index + 1}`,
    amount: { amountPaise: null, status: 'unknown' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once', basis: 'payment' } }));
  saved.plan.budgetBasis.unresolvedAmounts = saved.facts.records.map(record => ({ recordId: record.id, reason: 'missingDate', amount: record.amount, recurrence: 'once' }));
  const label = count === 1 ? '1 item needs a date' : '2 items need a date';
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  expect(screen.getByRole('button', { name: label })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'No dated items yet' })).toBeVisible();
  expect(screen.getByText('Add the missing dates to see those items here.')).toBeVisible();
  expect(screen.queryByRole('list', { name: 'Upcoming events' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: label }));
  const detail = screen.getByRole('dialog', { name: label });
  expect(within(detail).getByText('Not included in the dated forecast.')).toBeVisible();
  const rows = within(within(detail).getByRole('list', { name: 'Items without dates' })).getAllByRole('listitem');
  expect(rows).toHaveLength(count);
  for (const row of rows) {
    expect(row).toHaveTextContent('Unknown · Unknown · Date unknown, not in dated balances.');
    expect(row).not.toHaveTextContent('₹0.00');
    expect(within(row).getByRole('link', { name: 'View item category' })).toHaveAttribute('href', '/money/spending');
  }
});

it('offers only Upcoming when no earlier events exist, with the consumer filter labels and stable values', () => {
  render(<MemoryRouter><MoneyUpcoming snapshot={planningSnapshot()} /></MemoryRouter>);
  const period = screen.getByRole('combobox', { name: 'Time period' });
  expect(period).toHaveValue('upcoming');
  expect(within(period).getAllByRole('option').map(option => option.textContent)).toEqual(['Upcoming']);
  expect(screen.queryByRole('option', { name: /Earlier \(0\)|All dates/ })).not.toBeInTheDocument();
  const filter = screen.getByRole('combobox', { name: 'Filter upcoming items' });
  expect(within(filter).getByRole('option', { name: 'All items' })).toHaveValue('all');
  expect(within(filter).getByRole('option', { name: 'Money in' })).toHaveValue('income');
  expect(within(filter).getByRole('option', { name: 'Money out' })).toHaveValue('due');
});

it('searches and filters paged items, resets paging and distinguishes no matches from an empty plan', async () => {
  const user = userEvent.setup();
  const saved = planningSnapshot();
  saved.plan.events = Array.from({ length: 11 }, (_, index) => ({ ...saved.plan.events[0], id: `event-${index}`, label: `Item ${index + 1}`,
    kind: index === 10 ? 'income' : 'essential' }));
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  const list = screen.getByRole('list', { name: 'Upcoming events' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(8);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  screen.getByRole('button', { name: 'Next' }).focus(); await user.keyboard('{Enter}');
  expect(within(list).getAllByRole('listitem').map(row => row.getAttribute('aria-label'))).toEqual(['Item 9', 'Item 10', 'Item 11']);
  expect(list).toHaveAttribute('start', '9');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.type(screen.getByRole('searchbox', { name: 'Search upcoming items' }), '  ITEM 11  ');
  expect(screen.getByRole('status')).toHaveTextContent('1 item found');
  expect(screen.getByRole('status')).not.toHaveClass('sr-only');
  expect(screen.getByRole('status')).toBeVisible();
  expect(screen.getByRole('list', { name: 'Upcoming events' })).toHaveAttribute('start', '1');
  expect(screen.getByRole('listitem', { name: 'Item 11' })).toBeVisible();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Filter upcoming items' }), 'due');
  expect(screen.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  expect(screen.getByText('Try another name or filter.')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('0 items found');
  expect(screen.queryByRole('list', { name: 'Upcoming events' })).not.toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox'));
  expect(screen.getByText('10 items found')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Filter upcoming items' }), 'income');
  expect(screen.getByRole('listitem', { name: 'Item 11' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('1 item found');
});

it.each([false, true])('keeps the no-dated-items versus nothing-upcoming distinction when earlier items exist: %s', async earlier => {
  const saved = earlier ? planningSnapshot() : snapshot();
  saved.plan.evaluatedOn = '2026-09-14';
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: earlier ? 'Nothing upcoming' : 'No dated items yet' })).toBeVisible();
  expect(screen.getByText('Only items with dates appear here. This does not mean every cost is covered.')).toBeVisible();
  if (earlier) {
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Time period' }), 'earlier');
    expect(screen.getByText('Status unconfirmed')).toBeVisible();
    expect(screen.getByRole('option', { name: 'Earlier (1)' })).toHaveValue('earlier');
    expect(screen.getByRole('option', { name: 'All dates' })).toHaveValue('all');
  }
});

it('prints every accepted occurrence with expanded qualifications despite compact pagination and a preview', () => {
  const saved = choiceSnapshot('cardMinimum');
  saved.facts.records[1].target = { amountPaise: 100000, status: 'exact' };
  saved.facts.records[1].schedule.amounts = [{ amount: '25', status: 'estimate' }];
  saved.facts.records.push({ ...saved.facts.records[0], id: 'budget', label: 'Food budget', schedule: { date: null, certainty: 'unknown', recurrence: 'monthlyBudget', basis: 'allowance' } });
  saved.accepted = { ...scenario('accepted'), plan: structuredClone(saved.plan), adjustments: [] };
  saved.accepted.plan.evaluatedOn = '2026-09-15';
  saved.accepted.plan.events = Array.from({ length: 10 }, (_, index) => ({ ...saved.plan.events[1], id: `card-${index}`, label: `Card occurrence ${index + 1}`,
    amountBasis: 'requiredFloor', amountPaise: 200000, balancePaise: -32100 }));
  saved.accepted.plan.events[0] = { ...saved.accepted.plan.events[0], date: '2026-09-13', originalDueDate: '2026-09-10', overdue: true, autoDebit: true };
  saved.accepted.plan.events[1] = { ...saved.accepted.plan.events[1], amountBasis: 'requiredOnly' };
  saved.accepted.plan.events[2] = { ...saved.accepted.plan.events[2], included: false, amountPaise: null, amountStatus: 'unknown' };
  saved.accepted.plan.events[3] = { ...saved.accepted.plan.events[3], recordId: 'budget', label: 'Food budget', kind: 'essential', amountBasis: 'budget', amountStatus: 'estimate', dateAssumption: 'A forecast date, not a reported payment date.' };
  saved.accepted.plan.events[4] = { ...saved.accepted.plan.events[4], amountBasis: 'assumed' };
  saved.accepted.plan.events[5].source = { amount: '25', status: 'estimate', conversion: { currency: 'USD', rate: '80', rateStatus: 'estimate', rateDate: '2026-09-10', fee: null, feeStatus: 'unknown', direction: 'payment' } };
  saved.accepted.adjustments = [{ ...scenario().adjustments[0], eventId: 'card-4', recordId: 'card', label: 'Card occurrence 5', kind: 'card', minimumPaise: 200000, amountPaise: 200000 }];
  saved.preview = { ...scenario('preview'), plan: structuredClone(saved.plan) };
  saved.preview.plan.events = [{ ...saved.plan.events[1], label: 'Unsaved preview', amountPaise: 0, balancePaise: 9999900 }];
  const original = structuredClone(saved);
  const view = render(<MemoryRouter><MoneyUpcoming snapshot={saved} /><MoneyPrint snapshot={saved} /></MemoryRouter>);
  expect(within(screen.getByRole('list', { name: 'Upcoming events' })).getAllByRole('listitem')).toHaveLength(8);
  const print = view.container.querySelector<HTMLElement>('.money-print')!;
  expect(print).toHaveAttribute('hidden');
  expect(print.querySelectorAll('.money-event')).toHaveLength(10);
  expect(print.querySelectorAll('.money-event-detail')).toHaveLength(10);
  expect(print.querySelector('dialog')).toBeNull();
  expect(within(print).queryByRole('button', { hidden: true, name: /Details for/ })).not.toBeInTheDocument();
  for (const text of ['Card occurrence 10', 'Originally due 10 Sept 2026', 'Earlier requirement · status not confirmed',
    'Earlier projected balance · Calculated-₹321.00', 'Automatic debit reported', 'The minimum is counted; your target is retained.',
    'Required / minimum only · intended payment unknown', 'Not counted in balances', 'Unknown', 'A forecast date, not a reported payment date.',
    'An estimated cash budget spread evenly across each calendar month’s actual days, not a scheduled payment or lender due date.',
    'Occurrence 1 of 1', 'USD 25 · Estimated original amount', 'INR fee: Unknown · Unknown · added to payment',
    'Calculated INR shown alongside.', 'Saved assumption · not paid · includes minimum',
    'Not a current bank balance', 'Intended, including minimum: ₹1,000.00', 'Missing amounts and dates are not zero.']) expect(print).toHaveTextContent(text);
  expect(print).not.toHaveTextContent('Unsaved preview');
  expect(print).not.toHaveTextContent('₹99,999.00');
  expect(saved).toEqual(original);
});