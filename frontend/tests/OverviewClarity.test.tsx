// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../src/api';
import { MoneyOverview } from '../src/MoneyOverview';
import { PlanSummary } from '../src/PlanSummary';
import { planningSnapshot, scenario, snapshot } from './fixtures';

/** Renders the overview with observable correction and command callbacks. */
function overview(saved: Snapshot, blocked = false) {
  const controls = { blocked, onEdit: vi.fn(), onChecks: vi.fn(), onCommand: vi.fn() };
  render(<MemoryRouter><div className="money-page"><MoneyOverview snapshot={saved} {...controls} /></div></MemoryRouter>);
  return controls;
}

it('shows included expected income and excluded uncertain income together even with a next receipt', () => {
  const saved = planningSnapshot();
  saved.facts.records.push({ ...saved.facts.records[0], id: 'salary', kind: 'income', label: 'Salary', reliability: 'reliable' });
  saved.plan.reliableIncomePaise = 1234567;
  saved.plan.uncertainIncomePaise = 234567;
  saved.plan.events.push({ ...saved.plan.events[0], id: 'salary', recordId: 'salary', kind: 'income', label: 'Salary', date: '2026-09-20', amountPaise: 1234567 });
  overview(saved);
  const metrics = screen.getByRole('region', { name: 'Money in this plan' });
  const income = within(metrics).getByText('Expected income included').parentElement!;
  expect(income).toHaveTextContent('₹12,345.67');
  expect(income).toHaveTextContent('Next 20 Sept');
  expect(income).toHaveTextContent('₹2,345.67 uncertain · not included');
  expect(within(metrics).getAllByRole('term')).toHaveLength(4);
});

it.each([420025, null])('uses current opening %s in the metric and calculation, with capture only in exchange details', async amountPaise => {
  const saved = planningSnapshot();
  saved.facts.opening = { amountPaise: 400000, status: 'estimate', source: { amount: '50', status: 'exact', conversion: { currency: 'USD', rate: '80', rateStatus: 'estimate', fee: null, feeStatus: 'unknown', provider: 'frankfurter', direction: 'receipt' } } };
  saved.plan.planningFacts.opening = { ...structuredClone(saved.facts.opening), amountPaise, status: amountPaise === null ? 'unknown' : 'estimate' };
  saved.plan.planningFacts.opening.source!.conversion!.rate = amountPaise === null ? null : '84.005';
  saved.plan.planningFacts.opening.source!.conversion!.rateStatus = amountPaise === null ? 'unknown' : 'estimate';
  overview(saved);
  const metrics = screen.getByRole('region', { name: 'Money in this plan' });
  expect(within(metrics).getByText('Conversion fee unknown · not included')).toBeVisible();
  expect(within(metrics).getByText(/Captured INR:/)).not.toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'View calculation' }));
  const calculation = screen.getByRole('dialog', { name: 'Plan details' });
  expect(within(calculation).getByText('Opening cash · 11 Sept').parentElement).toHaveTextContent(amountPaise === null ? 'Unknown' : '₹4,200.25');
  expect(within(calculation).getByText(/Opening conversion fee unknown/)).toBeVisible();
  for (const capture of within(calculation).getAllByText(/Captured INR:/)) expect(capture).not.toBeVisible();
  await userEvent.click(within(calculation).getByRole('button', { name: 'Close plan details' }));
  await userEvent.click(screen.getByRole('button', { name: 'Opening exchange details' }));
  const exchange = screen.getByRole('dialog', { name: 'Opening cash conversion' });
  expect(within(exchange).getByText(/Captured INR:/)).toHaveTextContent('₹4,000.00');
  expect(exchange).toHaveTextContent('fees are not assumed to be zero');
});

it.each([
  ['weekly', 'Weekly budget'], ['fortnightly', 'Fortnightly budget'], ['daily', 'Daily budget'], ['monthlyBudget', 'Daily share · Monthly budget'],
] as const)('labels %s budgets using their current occurrence, not their schedule origin', (recurrence, label) => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule = { date: '2026-09-01', recurrence, certainty: 'exact', basis: 'allowance' };
  saved.plan.events = [{ ...saved.plan.events[0], amountBasis: 'budget', date: '2026-09-18', originalDueDate: '2026-09-01', amountPaise: 12345 }];
  overview(saved);
  const row = within(screen.getByRole('region', { name: 'Next money and payments' })).getByRole('listitem');
  expect(row).toHaveTextContent(`18 Sept · ${label}`);
  expect(row).toHaveTextContent('−₹123.45');
  expect(row).not.toHaveTextContent('1 Sept');
});

it('retains the original deadline only for overdue items', () => {
  const saved = planningSnapshot();
  saved.plan.events[0] = { ...saved.plan.events[0], overdue: true, date: '2026-09-11', originalDueDate: '2026-09-01' };
  overview(saved);
  const row = within(screen.getByRole('region', { name: 'Next money and payments' })).getByRole('listitem');
  expect(row).toHaveTextContent('11 Sept');
  expect(row).toHaveTextContent('Overdue · originally due 1 Sept');
});

it('places a real early gap ahead of positive closing, with compact guidance and full next step behind details', async () => {
  const saved = planningSnapshot();
  const long = `Check the exact payment arrangement ${'with the provider before proceeding. '.repeat(12)}`.trim();
  saved.workspace!.actions![0].question = long;
  saved.plan.decisionAssessment!.outcome!.nextStep = long;
  saved.plan.decisionAssessment!.outcome!.secondary = 'Without the assumed receipt, the closing forecast is ₹2,000.';
  overview(saved);
  const attention = screen.getByRole('region', { name: 'What needs attention' });
  const metrics = screen.getByRole('region', { name: 'Money in this plan' });
  expect(attention.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(attention).getByLabelText('First shortfall')).toBeVisible();
  expect(within(attention).getByRole('heading')).toHaveTextContent('The rent deadline has a shortfall.');
  expect(within(attention).getByText('Later income does not cover the earlier deadline.')).toBeVisible();
  expect(within(attention).getByText(/Without the assumed receipt/)).not.toBeVisible();
  expect(metrics).toHaveTextContent('Closing forecast₹10,000');
  for (const text of within(attention).getAllByText(long)) expect(text).not.toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Plan conditions' }));
  expect(within(screen.getByRole('dialog', { name: 'What this plan depends on' })).getByText(long)).toBeVisible();
  expect(within(screen.getByRole('dialog', { name: 'What this plan depends on' })).getByText(/Without the assumed receipt/)).toBeVisible();
});

it('keeps minimum, automatic debit, excluded amount and uncertain date qualifications independent', () => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule.certainty = 'unknown';
  saved.plan.events[0] = { ...saved.plan.events[0], amountBasis: 'requiredOnly', autoDebit: true, included: false, amountPaise: null, amountStatus: 'unknown' };
  overview(saved);
  const row = within(screen.getByRole('region', { name: 'Next money and payments' })).getByRole('listitem');
  expect(row).toHaveTextContent('Minimum only · target unknown');
  expect(row).toHaveTextContent('Auto-debit');
  expect(row).toHaveTextContent('Not included · unconfirmed');
  expect(row).toHaveTextContent('Date uncertain');
  expect(row).toHaveTextContent('Unknown');
});

it('keeps an estimated allowance amount visible beside its assumed forecast date', () => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule.recurrence = 'weekly';
  saved.plan.events[0] = { ...saved.plan.events[0], amountBasis: 'budget', dateAssumption: 'Forecast from the plan start', amountStatus: 'estimate' };
  overview(saved);
  const row = within(screen.getByRole('region', { name: 'Next money and payments' })).getByRole('listitem');
  expect(row).toHaveTextContent('Weekly budget');
  expect(row).toHaveTextContent('Assumed date');
  expect(row).toHaveTextContent('Estimated amount');
  expect(row).not.toHaveTextContent('Daily');
});

it('keeps checks, cash-buffer editing and the download together in one footer', async () => {
  const saved = planningSnapshot();
  const controls = overview(saved);
  const footer = screen.getByRole('contentinfo');
  expect(within(footer).getByRole('link', { name: 'Download saved plan' })).toHaveAttribute('href', '/api/session/export');
  await userEvent.click(within(footer).getByRole('button', { name: /cash buffer/i }));
  expect(controls.onEdit).toHaveBeenCalledWith({ field: 'reserve' });
  await userEvent.click(within(footer).getByRole('button', { name: /details? to review|needs? a date/ }));
  expect(controls.onChecks).toHaveBeenCalledOnce();
});

it('keeps full action questions and summary in default PlanSummary uses', () => {
  const saved = planningSnapshot();
  saved.workspace!.actions![0].question = 'Review the provider terms in full before making any change.';
  render(<PlanSummary snapshot={saved} />);
  expect(screen.getByRole('heading')).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.summary);
  expect(screen.getByText(/Review the provider terms in full/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Plan conditions' })).not.toBeInTheDocument();
});

it('uses accepted totals instead of a preview and does not describe saved assumptions as payments', () => {
  const saved = planningSnapshot();
  saved.accepted = scenario('accepted'); saved.preview = scenario('preview');
  saved.accepted.plan.planningFacts.opening.amountPaise = 678900;
  saved.accepted.plan.closingPaise = 123456;
  saved.preview.plan.closingPaise = 99999999;
  const before = structuredClone(saved);
  overview(saved);
  const metrics = screen.getByRole('region', { name: 'Money in this plan' });
  expect(metrics).toHaveTextContent('Opening cash₹6,789');
  expect(metrics).toHaveTextContent('Closing forecast₹1,234.56');
  expect(metrics).not.toHaveTextContent('999,999.99');
  expect(screen.getByText('Saved assumptions included · No payments made')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Preview not applied' })).toBeVisible();
  expect(saved).toEqual(before);
});

it('keeps unknown income, spending and cash distinct from zero and retains empty-state correction', async () => {
  const saved = snapshot();
  saved.facts.records = ['income', 'essential'].map((kind, index) => ({ ...planningSnapshot().facts.records[0], id: `unknown:${index}`, kind: kind as 'income' | 'essential', amount: { amountPaise: null, status: 'unknown' } }));
  saved.plan.budgetBasis.unresolvedAmounts = saved.facts.records.map(record => ({ recordId: record.id, reason: 'missingAmount', amount: record.amount, recurrence: 'once' }));
  const controls = overview(saved);
  const metrics = screen.getByRole('region', { name: 'Money in this plan' });
  expect(metrics).toHaveTextContent('Opening cashUnknown');
  expect(metrics).toHaveTextContent('Expected income includedUnknown');
  expect(metrics).toHaveTextContent('Money going outUnknown');
  expect(metrics).toHaveTextContent('Closing forecastUnknown');
  expect(metrics).not.toHaveTextContent('₹0');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Add starting cash' }));
  expect(controls.onEdit).toHaveBeenCalledWith({ field: 'opening' });
  expect(screen.getByRole('link', { name: 'Add a bill or expense' })).toBeVisible();
});

it('retains long item names in the compact list without truncation and keeps blocked edits unavailable', () => {
  const saved = planningSnapshot();
  saved.plan.events[0].label = 'Household obligation '.repeat(16);
  overview(saved, true);
  expect(screen.getByRole('listitem', { name: saved.plan.events[0].label.trim() })).toHaveTextContent(saved.plan.events[0].label.trim());
  expect(screen.getByRole('button', { name: 'Correct starting cash' })).toBeDisabled();
  expect(screen.queryByRole('link', { name: 'Download saved plan' })).not.toBeInTheDocument();
});