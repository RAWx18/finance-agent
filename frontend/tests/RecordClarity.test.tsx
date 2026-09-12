// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { MoneyRecords, RecordRow } from '../src/MoneyRecords';
import { planningSnapshot } from './fixtures';

it.each([
  ['exact', 1200050, '₹12,000.50'], ['estimate', 1200050, '₹12,000.50'], ['unknown', null, 'Unknown'],
] as const)('keeps the reported %s scalar rather than substituting a forecast amount', (status, amountPaise, label) => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.amount = { status, amountPaise };
  saved.plan.events[0].amountPaise = 777700;
  saved.plan.planningFacts.records[0].amount = { status: 'exact', amountPaise: 888800 };
  const original = structuredClone(saved);
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  const amount = screen.getByRole('button', { name: 'Edit Rent amount' });
  expect(amount).toBeVisible(); expect(amount).toHaveTextContent(label);
  expect(amount).not.toHaveTextContent(/₹7,777|₹8,888|₹0.00/);
  expect(screen.queryByText('Reported', { exact: true })).not.toBeInTheDocument();
  if (status === 'estimate') expect(screen.getByText('Estimated', { exact: true })).toBeVisible();
  expect(saved).toEqual(original);
});

it.each(['absent', 'unknown', 'exact', 'estimate'] as const)('keeps a debt minimum primary with %s target and outstanding in details', async status => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.kind = 'debt'; record.debtType = 'card';
  record.amount = { amountPaise: 50025, status: 'exact' };
  record.target = status === 'absent' ? null : { amountPaise: status === 'unknown' ? null : 100075, status };
  record.outstanding = { amountPaise: 2500099, status: 'exact' };
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Edit Rent required payment' })).toHaveTextContent('₹500.25');
  if (status === 'absent') expect(screen.queryByRole('button', { name: 'Edit Rent intended payment' })).not.toBeInTheDocument();
  else {
    expect(screen.getByRole('button', { name: 'Edit Rent intended payment' })).toHaveTextContent(status === 'unknown' ? 'Unknown' : '₹1,000.75');
    expect(screen.getByText('Intended · includes minimum')).toBeVisible();
  }
  expect(screen.getByText('₹25,000.99')).not.toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  const details = screen.getByRole('dialog', { name: 'Details for Rent' });
  expect(within(details).getByRole('button', { name: 'Edit Rent outstanding' })).toHaveTextContent('₹25,000.99');
  expect(details).toHaveTextContent('intended payment includes the minimum, not an extra payment');
  expect(details).toHaveTextContent('Outstanding debt is not reduced by planning assumptions.');
  if (status === 'absent') expect(within(details).getByRole('button', { name: 'Edit Rent intended payment' })).toHaveTextContent('Not supplied');
});

it.each([
  ['amount', 'required payment', false], ['target', 'intended payment', false],
  ['outstanding', 'outstanding', true], ['schedule.date', 'date', false], ['delete', '', true],
] as const)('sends the precise %s correction target without a write', async (field, label, details) => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.kind = 'debt'; record.target = { amountPaise: 1500000, status: 'exact' };
  record.outstanding = { amountPaise: 5000000, status: 'exact' };
  const onEdit = vi.fn(); const onCommand = vi.fn();
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={onEdit} onCommand={onCommand} />);
  if (details) await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  await userEvent.click(screen.getByRole('button', { name: field === 'delete' ? 'Remove Rent' : `Edit Rent ${label}` }));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ recordId: 'rent', field });
  expect(onCommand).not.toHaveBeenCalled();
});

it('sorts essentials before optional items with distinct tags without changing event order or amounts', () => {
  const saved = planningSnapshot();
  saved.facts.records = [
    { ...saved.facts.records[0], id: 'outing', label: 'Outing', kind: 'optional', amount: { amountPaise: 200025, status: 'exact' } },
    { ...saved.facts.records[0], id: 'food', label: 'Food', amount: { amountPaise: 100099, status: 'exact' } },
    { ...saved.facts.records[0], id: 'rent', label: 'Rent' },
  ];
  const original = structuredClone(saved);
  render(<MoneyRecords category="spending" snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  const rows = within(screen.getByRole('list', { name: 'Money items' })).getAllByRole('listitem');
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Food', 'Rent', 'Outing']);
  expect(within(rows[0]).getByText('Essential', { exact: true })).toBeVisible();
  expect(within(rows[2]).getByText('Optional', { exact: true })).toBeVisible();
  expect(within(rows[0]).getByRole('button', { name: 'Edit Food amount' })).toHaveTextContent('₹1,000.99');
  expect(within(rows[2]).getByRole('button', { name: 'Edit Outing amount' })).toHaveTextContent('₹2,000.25');
  expect(screen.queryByText(/payment priority|pay essentials first/i)).not.toBeInTheDocument();
  expect(saved).toEqual(original);
});

it.each([
  ['once', 'Once', '2026-09-20', '20 Sept', null],
  ['daily', 'Daily', '2026-09-14', '14 Sept', 'per day'],
  ['weekly', 'Weekly', '2026-09-20', '20 Sept', 'per week'],
  ['fortnightly', 'Every two weeks', '2026-09-20', '20 Sept', 'every two weeks'],
  ['monthly', 'Monthly', '2026-10-06', '6 Oct', 'per month'],
  ['monthlyBudget', 'Monthly budget', '2026-09-14', '14 Sept', 'per calendar month'],
] as const)('shows the actual next %s occurrence rather than the reported start', async (recurrence, tag, date, display, cadence) => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.schedule = { date: recurrence === 'once' ? date : '2026-09-06', recurrence, certainty: 'exact', basis: 'payment' };
  saved.plan.evaluatedOn = '2026-09-14';
  saved.plan.events = [
    { ...saved.plan.events[0], id: 'elapsed', date: '2026-09-06', originalDueDate: '2026-09-06' },
    { ...saved.plan.events[0], id: 'next', date, originalDueDate: date },
  ];
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Edit Rent date' })).toHaveTextContent(`${recurrence === 'monthlyBudget' ? 'Budget timing' : 'Due'} ${display}`);
  expect(screen.getByText(tag, { exact: true })).toBeVisible();
  if (cadence) expect(screen.getByText(cadence, { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('₹12,000.00');
  await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(`Reported start: ${recurrence === 'once' ? '20 Sept' : '6 Sept'} 2026`);
});

it.each(['weekly', 'monthly'] as const)('presents an undated %s allowance as budget timing, never a bill due date', recurrence => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.controllability = 'controllable';
  record.schedule = { date: null, recurrence, certainty: 'unknown', basis: 'allowance' };
  saved.plan.events[0] = { ...saved.plan.events[0], date: '2026-09-20', originalDueDate: '2026-09-20', amountPaise: 1200000, amountBasis: 'budget', amountStatus: 'estimate', dateAssumption: 'allowanceForecast' };
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Edit Rent date' })).toHaveTextContent('Budget timing 20 Sept');
  expect(screen.getByRole('button', { name: 'Edit Rent date' })).not.toHaveTextContent(/Due|Payment date/);
  expect(screen.getByText('Budget estimate · not a bill')).toBeVisible();
  expect(screen.getByText('Forecast date', { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('₹12,000.00');
});

it.each(['exact', 'estimate'] as const)('labels reliable %s income expected, included, and not confirmed received', status => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.kind = 'income'; record.label = 'Salary'; record.reliability = 'reliable'; record.amount.status = status;
  saved.plan.events[0] = { ...saved.plan.events[0], label: 'Salary', kind: 'income', amountStatus: status, included: true };
  render(<MoneyRecords category="income" snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  const row = screen.getByRole('listitem', { name: 'Salary' });
  expect(within(row).getByRole('button', { name: 'Edit Salary amount' })).toHaveTextContent('₹12,000.00');
  expect(within(row).getByRole('button', { name: 'Edit Salary date' })).toHaveTextContent('Expected 13 Sept');
  expect(within(row).getByText('Reliable', { exact: true })).toBeVisible();
  expect(within(row).getByText('Included in forecast')).toBeVisible();
  expect(screen.getByText('Expected income · not confirmed received')).toBeVisible();
  if (status === 'estimate') expect(within(row).getByText('Estimated', { exact: true })).toBeVisible();
});

it.each([
  ['requiredOnly', 'Minimum only · intended payment unknown'], ['requiredFloor', 'Minimum exceeds intended payment'],
] as const)('keeps %s and auto-debit warnings visible before opening details', (amountBasis, warning) => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.kind = 'debt'; record.autoDebit = true;
  record.amount = { amountPaise: 50000, status: 'estimate' };
  record.target = { amountPaise: amountBasis === 'requiredOnly' ? null : 40000, status: amountBasis === 'requiredOnly' ? 'unknown' : 'exact' };
  saved.plan.events[0] = { ...saved.plan.events[0], amountBasis, amountPaise: 50000, requiredPaise: 50000, amountStatus: 'estimate' };
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByText(warning)).toBeVisible(); expect(screen.getByText('Auto-debit', { exact: true })).toBeVisible();
  expect(screen.getByText('Estimated', { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit Rent required payment' })).toHaveTextContent('₹500.00');
  expect(screen.getByRole('button', { name: 'Edit Rent intended payment' })).toHaveTextContent(amountBasis === 'requiredOnly' ? 'Unknown' : '₹400.00');
});

it('keeps missing dates and conflicts visible without fabricating a payment date or zero', () => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.schedule.date = null; record.schedule.certainty = 'unknown'; record.amount = { amountPaise: null, status: 'unknown' };
  saved.facts = { ...saved.facts, conflicts: [{ id: 'dispute', recordId: record.id, field: 'amount', values: [
    { id: 'a', amountPaise: 1200000, status: 'exact' }, { id: 'b', amountPaise: 1300000, status: 'exact' },
  ] }] };
  saved.plan.events = [];
  saved.plan.budgetBasis.unresolvedAmounts = [{ recordId: record.id, reason: 'missingDate', amount: record.amount, recurrence: 'once' }];
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('Unknown');
  expect(screen.getByRole('button', { name: 'Edit Rent date' })).toHaveTextContent('Payment date unknown');
  expect(screen.getByText('Date needed · not in dated balances')).toBeVisible();
  expect(screen.getByText('Conflicting reports · check details')).toBeVisible();
  expect(screen.getByRole('listitem', { name: 'Rent' })).not.toHaveTextContent('₹0.00');
});

it.each(['estimate', 'overdue'] as const)('keeps %s date qualifications visible on the compact record', state => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.schedule.certainty = state === 'estimate' ? 'estimate' : 'exact';
  saved.plan.events[0].overdue = state === 'overdue';
  saved.plan.events[0].originalDueDate = '2026-09-09';
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Edit Rent date' })).toHaveTextContent(state === 'overdue' ? 'Due 9 Sept' : 'Due 13 Sept');
  expect(screen.getByText(state === 'overdue' ? 'Check earlier payment' : 'Date estimated')).toBeVisible();
});

it('keeps excluded income reasons visible without mislabelling reliable income as uncertain', () => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.kind = 'income'; record.reliability = 'reliable'; saved.plan.events = [];
  saved.workspace!.contributions = [{ id: 'record:rent', recordId: record.id, eventId: null, amountPaise: 1200000, included: false, reason: 'outsideHorizon', references: [] }];
  render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByText('Not counted in forecast')).toBeVisible();
  expect(screen.getByText(/Outside these 30 days/)).toBeVisible();
  expect(screen.queryByText('Receipt uncertain')).not.toBeInTheDocument();
});

it('keeps removal and coverage corrections in details and blocks writes while stale', async () => {
  const saved = planningSnapshot(); const onEdit = vi.fn(); const onCommand = vi.fn();
  const view = render(<MoneyRecords category="spending" snapshot={saved} blocked={false} onEdit={onEdit} onCommand={onCommand} />);
  expect(screen.queryByRole('button', { name: 'Remove Rent' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Review essential coverage' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Review included items' }));
  await userEvent.click(screen.getByRole('button', { name: 'Review essential coverage' }));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ kind: 'essential', field: 'coverage' });
  expect(screen.queryByRole('dialog', { name: 'Review included items' })).not.toBeInTheDocument();
  onEdit.mockClear();
  view.rerender(<MoneyRecords category="spending" snapshot={saved} blocked onEdit={onEdit} onCommand={onCommand} />);
  for (const name of ['Edit Rent amount', 'Edit Rent date', 'Edit Rent', 'Add item']) expect(screen.getByRole('button', { name })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  expect(screen.getByRole('button', { name: 'Remove Rent' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Remove Rent' }));
  expect(onEdit).not.toHaveBeenCalled(); expect(onCommand).not.toHaveBeenCalled();
});