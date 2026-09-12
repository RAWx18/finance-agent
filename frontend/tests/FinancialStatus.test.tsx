// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { FinancialStatus } from '../src/FinancialStatus';
import { planningSnapshot } from './fixtures';

function undated() {
  const saved = planningSnapshot();
  saved.facts.opening = { amountPaise: 100000000, status: 'exact' };
  saved.facts.records = [
    { ...saved.facts.records[0], amount: { amountPaise: 3000000, status: 'exact' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once' } },
    { ...saved.facts.records[0], id: 'outings', label: 'Weekend outings', kind: 'optional', amount: { amountPaise: 200000, status: 'estimate' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once' } },
  ];
  saved.plan.events = []; saved.plan.firstGap = null; saved.plan.closingPaise = 100000000; saved.plan.troughPaise = 100000000;
  saved.plan.budgetBasis = { datedProjectionComplete: false, unresolvedAmounts: saved.facts.records.map(record => ({ recordId: record.id, reason: 'missingDate', amount: record.amount, recurrence: record.schedule.recurrence })) };
  const closing = saved.workspace!.results!.find(result => result.id === 'closing')!;
  closing.amountPaise = 100000000; closing.state = 'unresolved';
  closing.qualifications = ['Excludes Rent because date unknown.'];
  saved.plan.decisionAssessment!.outcome!.summary = 'The dated items leave INR 1000000.00; full-period affordability cannot yet be established.';
  return saved;
}

it('shows the dated-only example without engine paragraphs or the assistant question, even in details', async () => {
  const saved = undated();
  render(<FinancialStatus snapshot={saved} />);
  const status = screen.getByRole('region', { name: 'Financial status' });
  expect(within(status).getByLabelText('Projected closing cash')).toHaveTextContent('₹10,00,000');
  expect(status).toHaveTextContent('Needs dates: Rent ₹30,000 · Weekend outings ₹2,000 est.');
  expect(status).toHaveTextContent('Starting cash only · No dated forecast yet');
  expect(status).toHaveTextContent('Plan is incomplete · Not a spending allowance');
  await userEvent.click(within(status).getByText('Needs attention', { selector: 'summary' }));
  expect(status).not.toHaveTextContent(/The dated items leave|INR 1000000|full-period affordability|Excludes Rent|Incomplete forecast|Next step/);
  expect(status).not.toHaveTextContent(saved.plan.decisionAssessment!.outcome!.nextStep);
});

it('takes a corrected closing balance and remaining missing dates from the next snapshot', () => {
  const saved = undated();
  const { rerender } = render(<FinancialStatus snapshot={saved} />);
  const next = structuredClone(saved); next.revision++;
  next.facts.records[0].schedule = { recurrence: 'once', date: '2026-09-15', certainty: 'exact' };
  next.plan.events = [{ ...planningSnapshot().plan.events[0], date: '2026-09-15', amountPaise: 3000000 }];
  next.plan.budgetBasis.unresolvedAmounts = next.plan.budgetBasis.unresolvedAmounts.filter(item => item.recordId !== 'rent');
  next.plan.closingPaise = 97000000;
  next.workspace!.results!.find(result => result.id === 'closing')!.amountPaise = 97000000;
  rerender(<FinancialStatus snapshot={next} />);
  expect(screen.getByLabelText('Projected closing cash')).toHaveTextContent('₹9,70,000');
  expect(screen.getByText('Needs dates').parentElement).toHaveTextContent('Needs dates: Weekend outings ₹2,000 est.');
  expect(screen.getByText('Needs dates').parentElement).not.toHaveTextContent('Rent');
});

it('does not mistake unknown opening or incomplete coverage for zero or a complete plan', () => {
  const saved = undated(); saved.plan.budgetBasis.unresolvedAmounts = [];
  const closing = saved.workspace!.results!.find(result => result.id === 'closing')!;
  closing.amountPaise = null; closing.state = 'missing';
  render(<FinancialStatus snapshot={saved} />);
  expect(screen.getByLabelText('Projected closing cash')).toHaveTextContent('Unknown');
  expect(screen.getByLabelText('Projected closing cash')).not.toHaveTextContent('₹0');
  expect(screen.getByText('Cash amount needed to project an end balance.')).toBeVisible();
  expect(screen.getByText('Plan is incomplete · Not a spending allowance')).toBeVisible();
  expect(screen.queryByText('Needs dates')).not.toBeInTheDocument();
});

it('retains paise, estimates and conflicts without printing raw calculation qualifications', () => {
  const saved = undated();
  const closing = saved.workspace!.results!.find(result => result.id === 'closing')!;
  closing.amountPaise = 123456; closing.state = 'estimated';
  saved.facts.conflicts!.push({ id: 'opening', recordId: null, field: 'opening', values: [{ id: 'a', amountPaise: 100000000, status: 'exact' }, { id: 'b', amountPaise: 90000000, status: 'exact' }] });
  render(<FinancialStatus snapshot={saved} />);
  expect(screen.getByLabelText('Projected closing cash')).toHaveTextContent('₹1,234.56');
  expect(screen.getByText('Includes estimates')).toBeVisible();
  expect(screen.getByText('Conflicting figures · Needs checking')).toBeVisible();
});

it('bounds the missing-date summary but keeps every record and recurring basis in details', async () => {
  const saved = undated();
  saved.facts.records.push({ ...saved.facts.records[1], id: 'food', label: 'Food budget', schedule: { date: null, certainty: 'unknown', recurrence: 'monthlyBudget' } });
  saved.plan.budgetBasis.unresolvedAmounts.push({ recordId: 'food', reason: 'missingDate', amount: saved.facts.records[2].amount, recurrence: 'monthlyBudget' });
  saved.plan.budgetBasis.unresolvedAmounts.push(saved.plan.budgetBasis.unresolvedAmounts[0]);
  render(<FinancialStatus snapshot={saved} />);
  expect(screen.getByText('Needs dates').parentElement).toHaveTextContent('+1 more');
  const food = screen.getByText(/Food budget ₹2,000 est./);
  expect(food).not.toBeVisible();
  await userEvent.click(screen.getByText('Needs attention', { selector: 'summary' }));
  expect(food).toBeVisible(); expect(food).toHaveTextContent(/Monthly/i);
});

it('distinguishes missing debt amounts and intended payments from missing dates', async () => {
  const saved = undated(); saved.plan.budgetBasis.unresolvedAmounts = [
    { recordId: 'rent', reason: 'missingAmount', amount: { amountPaise: null, status: 'unknown' }, recurrence: 'once' },
    { recordId: 'rent', reason: 'unknownTarget', amount: { amountPaise: 3000000, status: 'exact' }, recurrence: 'once' },
  ];
  render(<FinancialStatus snapshot={saved} />);
  expect(screen.queryByText('Needs dates')).not.toBeInTheDocument();
  expect(screen.getByText('Payment amounts still need checking.')).toBeVisible();
  await userEvent.click(screen.getByText('Needs attention', { selector: 'summary' }));
  expect(screen.getByText('Amount needed:').parentElement).toHaveTextContent('Rent Unknown');
  expect(screen.getByText('Intended payment unknown:').parentElement).toHaveTextContent('Rent ₹30,000');
});

it('does not invent a single amount for a variable series or count uncertain income', async () => {
  const saved = undated();
  saved.facts.records[0].schedule.amounts = [{ amount: '30000', status: 'exact' }, { amount: '35000', status: 'estimate' }];
  saved.facts.records[1].kind = 'income'; saved.facts.records[1].label = 'Bonus';
  saved.plan.budgetBasis.unresolvedAmounts = saved.plan.budgetBasis.unresolvedAmounts.slice(0, 1);
  saved.workspace!.contributions = [{ id: 'bonus', recordId: 'outings', eventId: null, amountPaise: 200000, date: '2026-09-20', included: false, reason: 'conditionalReceipt', references: [] }];
  saved.workspace!.results!.find(result => result.id === 'closing')!.excludedIds = ['bonus'];
  render(<FinancialStatus snapshot={saved} />);
  expect(screen.getByText('Needs dates').parentElement).toHaveTextContent('Rent Varies by occurrence');
  await userEvent.click(screen.getByText('Needs attention', { selector: 'summary' }));
  expect(screen.getByText(/Bonus · ₹2,000 est./)).toHaveTextContent('20 Sept · Receipt is not confirmed enough to count on');
});