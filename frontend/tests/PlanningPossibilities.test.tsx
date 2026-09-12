// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlanningPossibilities } from '../src/PlanningPossibilities';
import { FinancialStatus } from '../src/FinancialStatus';
import { planningSnapshot, scenario } from './fixtures';

/** Builds supplied base and what-if balances for an undated monthly rent fixture. */
function partial() {
  const saved = planningSnapshot();
  saved.plan.closingPaise = 900000;
  saved.plan.firstGap = null;
  saved.workspace!.results!.find(result => result.id === 'closing')!.amountPaise = 900000;
  saved.plan.undatedImpact = { items: [{ recordId: 'rent', label: 'Rent', amountPaise: 3300000, status: 'exact', recurrence: 'monthly', amountBasis: 'reported', requiredPaise: null, targetPaise: null, assumption: 'One monthly payment; unpaid status and timing unconfirmed.' }],
    outflowPaise: 3300000, closingPaise: -2400000, status: 'estimate', unknownRecordIds: [], qualification: 'What-if only. Other payments may increase the need; not an upper bound.' };
  return saved;
}

describe('useful planning possibilities', () => {
  it('quantifies a monthly payment without inventing a date or changing the main balance', () => {
    const saved = partial(); const before = structuredClone(saved);
    render(<FinancialStatus snapshot={saved} />);
    expect(screen.getByLabelText('Projected closing cash')).toHaveTextContent('₹9,000');
    const comparison = screen.getByRole('region', { name: 'Planning possibilities' });
    expect(comparison).toHaveTextContent('₹33,000');
    expect(comparison).toHaveTextContent('-₹24,000');
    expect(comparison).toHaveTextContent('What-if only: one payment');
    expect(comparison).toHaveTextContent('Not a maximum');
    expect(comparison).not.toHaveTextContent(/shortfall on|due 1 Oct|safe to spend/);
    expect(saved).toEqual(before);
  });

  it('retains a known allowance when cash and some other amounts are unknown', () => {
    const saved = partial(); saved.plan.closingPaise = null;
    saved.plan.undatedImpact!.closingPaise = null;
    saved.plan.undatedImpact!.status = 'unknown';
    saved.plan.undatedImpact!.unknownRecordIds = ['card'];
    saved.plan.undatedImpact!.items.push({ recordId: 'card', label: 'Card', amountPaise: null, status: 'unknown', recurrence: 'once', amountBasis: 'reported', requiredPaise: null, targetPaise: null, assumption: 'Amount not supplied.' });
    render(<PlanningPossibilities snapshot={saved} />);
    const comparison = screen.getByRole('region', { name: 'Planning possibilities' });
    expect(comparison).toHaveTextContent('₹33,000');
    expect(comparison).toHaveTextContent('Card · Unknown');
    expect(comparison).toHaveTextContent('the need may be higher');
    expect(comparison).not.toHaveTextContent('₹0');
    expect(comparison).not.toHaveTextContent('remaining —');
  });

  it('does not present minimum-only or positive scenario totals as full affordability', () => {
    const saved = partial();
    saved.plan.undatedImpact!.items[0] = { ...saved.plan.undatedImpact!.items[0], label: 'Card', amountPaise: 50000, amountBasis: 'requiredOnly', requiredPaise: 50000 };
    saved.plan.undatedImpact!.outflowPaise = 50000;
    saved.plan.undatedImpact!.closingPaise = 850000;
    saved.plan.undatedImpact!.unknownRecordIds = ['rent'];
    render(<PlanningPossibilities snapshot={saved} />);
    expect(screen.getByRole('region')).toHaveTextContent('Minimum only; intended total unknown');
    expect(screen.getByRole('region')).toHaveTextContent('₹8,500 remaining — dates still decide whether each payment fits');
    expect(screen.getByRole('region')).toHaveTextContent('need may be higher');
  });

  it('shows accepted comparisons, never an unaccepted preview', () => {
    const saved = partial(); saved.accepted = scenario('accepted'); saved.preview = scenario('preview');
    saved.accepted.plan.undatedImpact = structuredClone(saved.plan.undatedImpact);
    saved.accepted.plan.undatedImpact!.closingPaise = -2000000;
    saved.preview.plan.undatedImpact = structuredClone(saved.plan.undatedImpact);
    saved.preview.plan.undatedImpact!.closingPaise = 9900000;
    render(<PlanningPossibilities snapshot={saved} />);
    expect(screen.getByRole('region')).toHaveTextContent('-₹20,000');
    expect(screen.getByRole('region')).not.toHaveTextContent(/99,000|24,000/);
  });

  it('shows a conditional receipt comparison separately from undated spending', () => {
    const saved = partial();
    saved.plan.events = [{ ...saved.plan.events[0], id: 'salary', recordId: 'salary', label: 'Salary', kind: 'income', included: false, amountPaise: 3000000, date: '2026-09-30', dateAssumption: 'Calculated from month-end pattern' }];
    saved.plan.incomeComparisons = [{ id: 'income:reportedDate', conditions: [{ eventId: 'salary', arrival: 'reportedDate' }], metrics: { ...saved.plan, closingPaise: 3900000 } }];
    render(<PlanningPossibilities snapshot={saved} />);
    expect(screen.getByRole('region')).toHaveTextContent('₹39,000');
    expect(screen.getByRole('region')).toHaveTextContent('Both figures are before the separate payments-without-dates comparison');
    expect(screen.getByRole('region')).toHaveTextContent('Calculated date from your pattern');
    expect(screen.getByRole('region')).toHaveTextContent('not guaranteed');
    expect(screen.getByRole('region')).not.toHaveTextContent('₹6,000');
  });
});