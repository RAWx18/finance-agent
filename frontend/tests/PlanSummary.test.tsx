// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/api';
import { PlanSummary, ResultQualification } from '../src/PlanSummary';
import { planningSnapshot, scenario, snapshot } from './fixtures';
import { projectWorkspace } from './workspace';

// Qualifications match the backend financial-flow regression; they are supplied, not inferred by the view.
function partialSnapshot(): Snapshot {
  const saved = planningSnapshot();
  saved.facts.opening = { amountPaise: 1000000, status: 'exact' };
  saved.facts.coverage = { income: 'none', essential: 'reviewed', optional: 'none', debt: 'none' };
  saved.facts.records = [
    { ...saved.facts.records[0], id: 'food', label: 'Food', amount: { amountPaise: 100000, status: 'exact' }, schedule: { date: '2026-09-12', recurrence: 'once', certainty: 'exact' } },
    { ...saved.facts.records[0], label: 'Rent and utilities', amount: { amountPaise: 3300000, status: 'exact' }, schedule: { date: null, recurrence: 'once', certainty: 'unknown' } },
  ];
  saved.plan = { ...saved.plan, projectionPartial: true, reliableIncomePaise: 0, uncertainIncomePaise: 0,
    outflowPaise: 100000, closingPaise: 900000, troughPaise: 900000, firstGap: null, peakGapPaise: 0, peakGapDate: null,
    reserveShortfallPaise: 0, timingRisks: [],
    events: [{ ...saved.plan.events[0], id: 'food:2026-09-12', recordId: 'food', label: 'Food', date: '2026-09-12', originalDueDate: '2026-09-12', amountPaise: 100000, balancePaise: 900000 }],
    budgetBasis: { datedProjectionComplete: false, unresolvedAmounts: [{ recordId: 'rent', reason: 'missingDate', amount: saved.facts.records[1].amount, recurrence: 'once' }] },
  };
  saved.plan.decisionAssessment = { ...saved.plan.decisionAssessment,
    uncertainties: [{ id: 'rent:schedule.date', kind: 'missing', recordIds: ['rent'], field: 'schedule.date', priority: 0,
      question: 'When are Rent and utilities due?', reason: 'The undated commitment can change the funding decision.', changes: ['when', 'affordability'], blocks: ['immediateDecision', 'fullPlan'] }],
    constraints: [], consequences: [], choices: [],
    actions: [{ id: 'clarify:rent:schedule.date', kind: 'clarify', recordIds: ['rent'], question: 'When are Rent and utilities due?', beforeDate: null, consequenceIds: [], ifDeclinedConsequenceIds: [] }],
    nextQuestionId: 'rent:schedule.date', nextActionId: 'clarify:rent:schedule.date',
    outcome: { ...saved.plan.decisionAssessment!.outcome!, branch: 'uncertain', readiness: 'qualified',
      summary: 'The dated items leave INR 9000.00 at the end of this period. Unresolved Rent and utilities (date); full-period affordability cannot yet be established.',
      covered: 'Food is included in the dated forecast.', notCovered: 'Rent and utilities are not dated.',
      nextStep: 'When are Rent and utilities due?', nextActionId: 'clarify:rent:schedule.date', riskIds: [], choiceIds: [], uncertain: ['rent:schedule.date'],
      conditions: 'Unresolved dates prevent any available-to-spend conclusion.', revisit: 'Recalculate when the rent date is confirmed.',
    },
  };
  projectWorkspace(saved);
  saved.workspace!.contributions!.push({ id: 'record:rent', recordId: 'rent', eventId: null, amountPaise: 3300000, date: null, included: false, reason: 'unknownDate', references: ['facts.records.rent.schedule.date'] });
  for (const result of saved.workspace!.results!) result.qualifications = [];
  Object.assign(saved.workspace!.results!.find(result => result.id === 'closing')!, {
    contributionIds: ['opening', 'event:food:2026-09-12'], excludedIds: ['record:rent'], excludedReasons: { 'record:rent': 'unknownDate' },
    qualifications: ['Excludes Rent and utilities (INR 33000.00): date unknown.'],
  });
  Object.assign(saved.workspace!.results!.find(result => result.id === 'opening')!, { state: 'known', recordIds: [], issueIds: [], excludedIds: [], contributionIds: ['opening'] });
  Object.assign(saved.workspace!.results!.find(result => result.id === 'reliableIncome')!, { state: 'known', recordIds: [], issueIds: [], excludedIds: [], contributionIds: [] });
  return saved;
}

function fundedSnapshot(): Snapshot {
  const saved = partialSnapshot();
  saved.facts.records = [{ ...saved.facts.records[0], label: 'Cinema', kind: 'optional', controllability: 'controllable' }];
  saved.facts.coverage = { income: 'none', essential: 'none', optional: 'reviewed', debt: 'none' };
  saved.plan.events[0] = { ...saved.plan.events[0], label: 'Cinema', kind: 'optional' };
  saved.plan.projectionPartial = false; saved.plan.budgetBasis = { datedProjectionComplete: true, unresolvedAmounts: [] };
  saved.plan.decisionAssessment = { ...saved.plan.decisionAssessment, uncertainties: [], actions: [], nextQuestionId: null, nextActionId: null,
    outcome: { ...saved.plan.decisionAssessment!.outcome!, branch: 'fits', readiness: 'ready', uncertain: [], nextActionId: null,
      summary: 'For reported commitments, dated payments fit with a minimum cash cushion of INR 9000.00; this is conditional on reported amounts and timing.',
      covered: 'The reported Cinema expense is included.', notCovered: 'No unreported spending is included.', nextStep: 'Revisit if the figures change.',
      conditions: 'Reported amounts and timing must hold; no payment has been made.', revisit: 'Recalculate after any correction.',
    },
  };
  projectWorkspace(saved);
  for (const result of saved.workspace!.results!) { result.state = 'known'; result.qualifications = []; }
  return saved;
}

describe('canonical plan summary', () => {
  it('pairs the first buffer shortfall with its own date, not the later maximum', () => {
    const saved = fundedSnapshot();
    saved.facts.reservePaise = 50000;
    saved.plan.reserveShortfallPaise = 40000;
    saved.plan.decisionAssessment!.consequences = [{ id: 'reserve', kind: 'reserveBreach', date: '2026-09-12', amountPaise: 10000, eventIds: [] }];
    render(<PlanSummary snapshot={saved} />);
    const summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(summary).toHaveTextContent('₹100 below your ₹500 buffer · 12 Sept');
    expect(summary).toHaveTextContent('Largest buffer shortfall: ₹400');
    expect(summary).not.toHaveTextContent('₹400 below your ₹500 buffer · 12 Sept');
  });
  it('keeps the partial 9000 result beside the named 33000 rent exclusion and supported next step', async () => {
    const saved = partialSnapshot();
    const original = structuredClone(saved);
    render(<PlanSummary snapshot={saved} />);
    const summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(within(summary).getByRole('heading')).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.summary);
    expect(summary).toHaveTextContent('INR 9000.00');
    expect(summary).toHaveTextContent('Incomplete forecast · Not a spending allowance');
    expect(within(summary).getByText('Excludes Rent and utilities (INR 33000.00): date unknown.')).toBeVisible();
    expect(summary).toHaveTextContent('Next step When are Rent and utilities due?');
    expect(summary).toHaveAttribute('data-tone', 'neutral');
    expect(summary).not.toHaveTextContent(/payments fit|ready|available to spend/i);
    expect(within(summary).queryByLabelText('First shortfall')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review|finish|download/i })).not.toBeInTheDocument();
    await userEvent.click(within(summary).getByText('What this depends on', { selector: 'summary' }));
    expect(within(summary).getByText(saved.plan.decisionAssessment!.outcome!.conditions)).toBeVisible();
    expect(within(summary).getByText(saved.plan.decisionAssessment!.outcome!.revisit)).toBeVisible();
    expect(saved).toEqual(original);
  });

  it.each(['opening', 'reliableIncome', 'uncertainIncome'])('does not attach excluded rent to the %s result', id => {
    const saved = partialSnapshot();
    const { rerender, container } = render(<ResultQualification snapshot={saved} id="closing" />);
    expect(container).toHaveTextContent('Excludes Rent and utilities (INR 33000.00): date unknown.');
    rerender(<ResultQualification snapshot={saved} id={id} />);
    expect(container).not.toHaveTextContent(/Rent and utilities|33000|Excludes|Not a spending allowance/);
    expect(saved.workspace!.results!.find(result => result.id === id)!.qualifications).toEqual([]);
  });

  it('retains minimum-only, estimated and excluded-source qualifications together', () => {
    const saved = partialSnapshot();
    saved.facts.records[0].amount.status = 'estimate';
    saved.facts.records[0].schedule.date = '2026-09-15';
    saved.facts.records.push(
      { ...saved.facts.records[0], id: 'card', label: 'Card', kind: 'debt', debtType: 'card', amount: { amountPaise: 50000, status: 'exact' },
        target: { amountPaise: null, status: 'unknown' }, schedule: { date: '2026-09-14', recurrence: 'once', certainty: 'exact' } },
      { ...saved.facts.records[0], id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 200000, status: 'exact' },
        reliability: 'reliable', schedule: { date: '2026-09-20', recurrence: 'once', certainty: 'exact' } },
    );
    saved.facts.coverage.income = 'reviewed'; saved.facts.coverage.debt = 'reviewed';
    saved.plan.events = [
      { ...saved.plan.events[0], id: 'card:2026-09-14', recordId: 'card', label: 'Card', kind: 'debt', date: '2026-09-14', originalDueDate: '2026-09-14', amountPaise: 50000, amountBasis: 'requiredOnly', requiredPaise: 50000, requiredStatus: 'exact', balancePaise: 950000 },
      { ...saved.plan.events[0], id: 'food:2026-09-15', date: '2026-09-15', originalDueDate: '2026-09-15', amountStatus: 'estimate', balancePaise: 850000 },
      { ...saved.plan.events[0], id: 'salary:2026-09-20', recordId: 'salary', label: 'Salary', kind: 'income', date: '2026-09-20', originalDueDate: '2026-09-20', amountPaise: 200000, balancePaise: 1050000 },
    ];
    saved.plan.reliableIncomePaise = 200000; saved.plan.outflowPaise = 150000;
    saved.plan.closingPaise = 1050000; saved.plan.troughPaise = 850000;
    saved.plan.budgetBasis.unresolvedAmounts.push({ recordId: 'card', reason: 'unknownTarget', amount: saved.facts.records[2].amount, recurrence: 'once' });
    projectWorkspace(saved);
    const result = saved.workspace!.results!.find(result => result.id === 'closing')!;
    result.state = 'estimated';
    result.qualifications = [
      "Includes only Card's required/minimum payment (INR 500.00); intended payment amount unknown.",
      'Uses estimated Food (INR 1000.00).',
      'Excludes Rent and utilities (INR 33000.00): date unknown.',
    ];
    render(<ResultQualification snapshot={saved} id="closing" />);
    expect(screen.getByText('Incomplete forecast · Includes estimates · Not a spending allowance')).toBeVisible();
    for (const qualification of result.qualifications) expect(screen.getByText(qualification)).toBeVisible();
  });

  it.each(['listed', 'missing', 'no selection'] as const)('shows only the selected supported workspace action (%s)', state => {
    const saved = partialSnapshot();
    const selected = saved.workspace!.actions![0];
    const other = { ...selected, id: 'review:other', question: 'Review another commitment.' };
    saved.plan.decisionAssessment!.actions = [other, selected];
    saved.plan.decisionAssessment!.outcome!.nextStep = 'Do not substitute a free-text next step.';
    saved.workspace!.actions = state === 'listed' ? [other, selected] : [other];
    if (state === 'no selection') saved.plan.decisionAssessment!.nextActionId = null;
    render(<PlanSummary snapshot={saved} />);
    const summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(summary).not.toHaveTextContent('Do not substitute a free-text next step.');
    if (state === 'listed') {
      expect(within(summary).getByText('Next step').parentElement).toHaveTextContent(selected.question);
      expect(summary).not.toHaveTextContent(other.question);
    }
    else {
      expect(within(summary).getByText('Next step').parentElement).toHaveTextContent(other.question);
      expect(summary).not.toHaveTextContent(selected.question);
    }
  });

  it('keeps the reported baseline active until acceptance and excludes the preview throughout', () => {
    const saved = fundedSnapshot();
    saved.preview = scenario('preview');
    saved.preview.adjustments = [{ ...saved.preview.adjustments[0], eventId: 'food:2026-09-12', recordId: 'food', label: 'Cinema', date: '2026-09-12', originalPaise: 100000, amountPaise: 0 }];
    saved.preview.reducedOutflowPaise = 100000;
    saved.preview.plan = structuredClone(saved.plan);
    saved.preview.plan.closingPaise = 1000000; saved.preview.plan.troughPaise = 1000000; saved.preview.plan.outflowPaise = 0;
    saved.preview.plan.events[0] = { ...saved.preview.plan.events[0], amountPaise: 0, amountBasis: 'assumed', balancePaise: 1000000 };
    saved.preview.plan.decisionAssessment!.outcome!.summary = 'Preview would leave INR 10000.00.';
    saved.preview.plan.decisionAssessment!.nextActionId = 'preview:food';
    const { rerender } = render(<PlanSummary snapshot={saved} />);
    let summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(within(summary).getByRole('heading')).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.summary);
    expect(summary).not.toHaveTextContent(/Preview would|Saved assumptions included|10000\.00/);
    const accepted = structuredClone(saved);
    accepted.revision++; accepted.sequence++; accepted.preview!.sourceRevision = accepted.revision;
    accepted.accepted = scenario('accepted');
    accepted.accepted.adjustments = [{ ...saved.preview.adjustments[0], amountPaise: 50000, acceptedRevision: accepted.revision }];
    accepted.accepted.reducedOutflowPaise = 50000;
    accepted.accepted.plan = structuredClone(saved.plan);
    accepted.accepted.plan.closingPaise = 950000; accepted.accepted.plan.troughPaise = 950000; accepted.accepted.plan.outflowPaise = 50000;
    accepted.accepted.plan.events[0] = { ...accepted.accepted.plan.events[0], amountPaise: 50000, amountBasis: 'assumed', balancePaise: 950000 };
    accepted.accepted.plan.decisionAssessment!.outcome!.summary = 'For reported commitments, dated payments fit with a minimum cash cushion of INR 9500.00; this is conditional on reported amounts and timing.';
    projectWorkspace(accepted);
    accepted.workspace!.results!.find(result => result.id === 'closing')!.state = 'known';
    accepted.workspace!.results!.find(result => result.id === 'closing')!.qualifications = ['Uses accepted Cinema (INR 500.00) on 2026-09-12: not a completed payment.'];
    rerender(<PlanSummary snapshot={accepted} />);
    summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(within(summary).getByRole('heading')).toHaveTextContent(accepted.accepted.plan.decisionAssessment!.outcome!.summary);
    expect(summary).toHaveTextContent('Uses accepted Cinema (INR 500.00) on 2026-09-12: not a completed payment.');
    expect(summary).toHaveTextContent('Saved assumptions included · No payments made');
    expect(summary).not.toHaveTextContent(/Preview would|10000\.00|9000\.00/);
    expect(saved.plan.closingPaise).toBe(900000);
    rerender(<PlanSummary snapshot={saved} />);
    expect(screen.getByRole('heading')).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.summary);
    expect(screen.queryByText('Saved assumptions included · No payments made')).not.toBeInTheDocument();
  });

  it.each([
    { income: 1000000, remaining: 0, closing: 400000 },
    { income: 400000, remaining: 200000, closing: -200000 },
  ])('separates same-day exposure from the remaining $remaining gap after $income income', ({ income, remaining, closing }) => {
    const saved = planningSnapshot();
    saved.facts.opening.amountPaise = 0;
    saved.facts.coverage = { income: 'reviewed', essential: 'reviewed', optional: 'none', debt: 'none' };
    saved.facts.records[0].amount.amountPaise = 600000;
    saved.facts.records[0].controllability = 'controllable';
    saved.facts.records[0].schedule.date = '2026-09-14';
    saved.facts.records.push({ ...saved.facts.records[0], id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: income, status: 'exact' }, reliability: 'reliable' });
    saved.plan = { ...saved.plan, projectionPartial: false, reliableIncomePaise: income, outflowPaise: 600000,
      firstGap: { date: '2026-09-14', amountPaise: 600000 }, peakGapPaise: 600000, peakGapDate: '2026-09-14', troughPaise: -600000, closingPaise: closing,
      timingRisks: [{ date: '2026-09-14', exposurePaise: 600000, remainingGapPaise: remaining }],
      events: [
        { ...saved.plan.events[0], id: 'rent:2026-09-14', date: '2026-09-14', originalDueDate: '2026-09-14', amountPaise: 600000, balancePaise: -600000 },
        { ...saved.plan.events[0], id: 'salary:2026-09-14', recordId: 'salary', label: 'Salary', kind: 'income', date: '2026-09-14', originalDueDate: '2026-09-14', amountPaise: income, balancePaise: closing },
      ],
    };
    saved.plan.decisionAssessment!.outcome!.summary = remaining
      ? "For Rent on 2026-09-14, INR 2000.00 is still unfunded after that day's receipts. Up to INR 6000.00 is needed before they arrive."
      : "Payment timing matters for Rent on 2026-09-14: INR 6000.00 is needed before that day's money arrives; the day's receipts cover these payments.";
    const action = { ...saved.plan.decisionAssessment!.actions![0], id: remaining ? 'support:rent' : 'timing:rent', kind: remaining ? 'seekSupport' as const : 'confirmReceipt' as const,
      consequenceIds: ['cash:2026-09-14'], ifDeclinedConsequenceIds: ['cash:2026-09-14'],
      question: remaining ? 'Check available funds or essential-needs support for the remaining INR 2000.00.' : 'Check that Salary is available before paying Rent.', beforeDate: '2026-09-14' };
    saved.plan.decisionAssessment!.actions = [action]; saved.plan.decisionAssessment!.nextActionId = action.id;
    saved.plan.decisionAssessment!.uncertainties = []; saved.plan.decisionAssessment!.nextQuestionId = null;
    saved.plan.decisionAssessment!.constraints = [{ id: 'rent:essential', kind: 'essential', eventIds: ['rent:2026-09-14'], date: '2026-09-14', amountPaise: 600000 }];
    saved.plan.decisionAssessment!.consequences = [{ id: 'cash:2026-09-14', kind: 'cashExposure', eventIds: ['rent:2026-09-14'], date: '2026-09-14', amountPaise: 600000 }];
    Object.assign(saved.plan.decisionAssessment!.outcome!, { nextStep: action.question, nextActionId: action.id, uncertain: [], riskIds: ['cash:2026-09-14'],
      conditions: 'Payments precede same-day income; no payment order or support is guaranteed.', revisit: 'Recalculate if the receipt amount or date changes.' });
    projectWorkspace(saved);
    Object.assign(saved.workspace!.results!.find(result => result.id === 'firstGap')!, {
      contributionIds: ['opening', 'event:rent:2026-09-14'], excludedIds: ['event:salary:2026-09-14'], excludedReasons: { 'event:salary:2026-09-14': 'afterResultPoint' },
      witnessEventIds: ['rent:2026-09-14'], qualifications: [remaining
        ? 'Excludes Salary (INR 4000.00): after this balance point.' : 'Excludes Salary (INR 10000.00): after this balance point.'],
    });
    const original = structuredClone(saved);
    render(<PlanSummary snapshot={saved} />);
    const summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(within(summary).getByRole('heading')).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.summary);
    const timing = within(summary).getByLabelText('Timing risk');
    expect(timing).toHaveTextContent('₹6,000Timing risk · 14 Sept');
    expect(timing).toHaveTextContent('If payments leave before same-day income.');
    expect(timing).toHaveTextContent(remaining ? '₹2,000 still unfunded after included income.' : 'No remaining gap after included income; payment timing is not guaranteed.');
    expect(summary).toHaveTextContent(action.question);
    expect(summary).toHaveTextContent('Before 14 Sept');
    expect(summary).toHaveTextContent(saved.workspace!.results!.find(result => result.id === 'firstGap')!.qualifications![0]);
    expect(within(summary).queryByLabelText('First shortfall')).not.toBeInTheDocument();
    expect(summary).toHaveAttribute('data-tone', 'risk');
    expect(saved).toEqual(original);
  });

  it('preserves the grocery funding action without inventing a creditor or payment agreement', () => {
    const saved = planningSnapshot();
    saved.facts.coverage = { income: 'reviewed', essential: 'reviewed', optional: 'none', debt: 'none' };
    saved.facts.records[0] = { ...saved.facts.records[0], id: 'food', label: 'Groceries', controllability: 'controllable' };
    saved.facts.records[0].schedule.date = '2026-09-14';
    saved.facts.records.push({ ...saved.facts.records[0], id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 2500000, status: 'exact' }, reliability: 'reliable', schedule: { date: '2026-09-20', recurrence: 'once', certainty: 'exact' } });
    saved.plan.events[0] = { ...saved.plan.events[0], id: 'food:2026-09-14', recordId: 'food', label: 'Groceries', date: '2026-09-14', originalDueDate: '2026-09-14' };
    saved.plan.events.push({ ...saved.plan.events[0], id: 'salary:2026-09-20', recordId: 'salary', label: 'Salary', kind: 'income', date: '2026-09-20', originalDueDate: '2026-09-20', amountPaise: 2500000, balancePaise: 1800000 });
    saved.plan.projectionPartial = false; saved.plan.outflowPaise = 1200000; saved.plan.reliableIncomePaise = 2500000;
    saved.plan.closingPaise = 1800000; saved.plan.troughPaise = -700000; saved.plan.peakGapPaise = 700000; saved.plan.peakGapDate = '2026-09-14';
    saved.plan.firstGap!.date = '2026-09-14';
    saved.plan.decisionAssessment!.outcome!.summary = 'Groceries: first shortfall INR 7000.00 on 2026-09-14.';
    saved.plan.decisionAssessment!.outcome!.conditions = 'Later Salary cannot fund the earlier deadline. Essential-needs support is not confirmed.';
    saved.plan.decisionAssessment!.outcome!.revisit = 'Recalculate when funds or the grocery amount change.';
    const action = { id: 'support:food:2026-09-14', kind: 'seekSupport' as const, recordIds: ['food'], beforeDate: '2026-09-14', consequenceIds: [], ifDeclinedConsequenceIds: [],
      question: 'Groceries needs INR 7000.00 by 2026-09-14. Check available funds or seek essential-needs support before then.' };
    saved.plan.decisionAssessment!.actions = [action]; saved.plan.decisionAssessment!.nextActionId = action.id;
    saved.plan.decisionAssessment!.uncertainties = []; saved.plan.decisionAssessment!.nextQuestionId = null;
    saved.plan.decisionAssessment!.constraints = [{ id: 'food:essential', kind: 'essential', eventIds: ['food:2026-09-14'], date: '2026-09-14', amountPaise: 1200000 }];
    saved.plan.decisionAssessment!.consequences = [{ id: 'cash:2026-09-14', kind: 'cashExposure', eventIds: ['food:2026-09-14'], date: '2026-09-14', amountPaise: 700000 }];
    Object.assign(saved.plan.decisionAssessment!.outcome!, { nextStep: action.question, nextActionId: action.id, uncertain: [], riskIds: ['cash:2026-09-14'] });
    projectWorkspace(saved);
    saved.workspace!.results!.find(result => result.id === 'firstGap')!.qualifications = ['Excludes Salary (INR 25000.00): after this balance point.'];
    render(<PlanSummary snapshot={saved} />);
    const summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(within(summary).getByRole('heading')).toHaveTextContent('Groceries: first shortfall INR 7000.00 on 2026-09-14.');
    expect(summary).toHaveTextContent(action.question);
    expect(summary).toHaveTextContent('Essential-needs support is not confirmed.');
    expect(summary).not.toHaveTextContent(/creditor|payee|lender|agreed|approved|negotiate|paid/i);
  });

  it('replaces the exclusion, current summary and action after a dated correction', () => {
    const saved = partialSnapshot();
    const { rerender } = render(<PlanSummary snapshot={saved} />);
    expect(screen.getByText('Excludes Rent and utilities (INR 33000.00): date unknown.')).toBeVisible();
    const corrected = structuredClone(saved); corrected.revision++; corrected.sequence++;
    corrected.facts.records[1].schedule = { date: '2026-09-14', recurrence: 'once', certainty: 'exact' };
    corrected.plan = { ...corrected.plan, projectionPartial: false, budgetBasis: { datedProjectionComplete: true, unresolvedAmounts: [] },
      outflowPaise: 3400000, closingPaise: -2400000, troughPaise: -2400000, peakGapPaise: 2400000, peakGapDate: '2026-09-14', firstGap: { date: '2026-09-14', amountPaise: 2400000 } };
    corrected.plan.events.push({ ...corrected.plan.events[0], id: 'rent:2026-09-14', recordId: 'rent', label: 'Rent and utilities', date: '2026-09-14', originalDueDate: '2026-09-14', amountPaise: 3300000, balancePaise: -2400000 });
    corrected.plan.decisionAssessment!.outcome = { ...corrected.plan.decisionAssessment!.outcome!, branch: 'gap', summary: 'Rent and utilities: first shortfall INR 24000.00 on 2026-09-14.', conditions: 'No changed payment terms are agreed.', revisit: 'Recalculate after a payment agreement or correction.' };
    const action = { ...corrected.workspace!.actions![0], id: 'contact:rent:2026-09-14', kind: 'contactPayee' as const, beforeDate: '2026-09-14', question: 'Discuss the INR 24000.00 rent shortfall before 2026-09-14; no agreement is assumed.' };
    corrected.plan.decisionAssessment!.actions = [action]; corrected.plan.decisionAssessment!.nextActionId = action.id;
    corrected.plan.decisionAssessment!.uncertainties = []; corrected.plan.decisionAssessment!.nextQuestionId = null;
    Object.assign(corrected.plan.decisionAssessment!.outcome!, { nextStep: action.question, nextActionId: action.id, uncertain: [] });
    projectWorkspace(corrected);
    for (const result of corrected.workspace!.results!) result.qualifications = [];
    rerender(<PlanSummary snapshot={corrected} />);
    const summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(within(summary).getByRole('heading')).toHaveTextContent(corrected.plan.decisionAssessment!.outcome.summary);
    expect(within(summary).getByLabelText('First shortfall')).toHaveTextContent('₹24,000First shortfall · 14 Sept');
    expect(summary).toHaveTextContent(action.question);
    expect(summary).not.toHaveTextContent(/INR 9000\.00|Excludes Rent|date unknown|When are Rent and utilities due/);
    expect(summary).toHaveAttribute('data-tone', 'risk');
    expect(corrected.facts.records[1].id).toBe(saved.facts.records[1].id);
    corrected.revision++; corrected.sequence++;
    corrected.facts.records[1].label = 'Home rent'; corrected.facts.records[1].amount.amountPaise = 1200000;
    corrected.plan.events[1] = { ...corrected.plan.events[1], label: 'Home rent', amountPaise: 1200000, balancePaise: -300000 };
    corrected.plan.outflowPaise = 1300000; corrected.plan.closingPaise = -300000; corrected.plan.troughPaise = -300000;
    corrected.plan.firstGap!.amountPaise = 300000; corrected.plan.peakGapPaise = 300000;
    corrected.plan.decisionAssessment!.outcome.summary = 'Home rent: first shortfall INR 3000.00 on 2026-09-14.';
    action.question = 'Discuss the INR 3000.00 Home rent shortfall before 2026-09-14; no agreement is assumed.';
    corrected.plan.decisionAssessment!.outcome.nextStep = action.question;
    projectWorkspace(corrected);
    for (const result of corrected.workspace!.results!) result.qualifications = [];
    rerender(<PlanSummary snapshot={structuredClone(corrected)} />);
    expect(within(summary).getByRole('heading')).toHaveTextContent('Home rent: first shortfall INR 3000.00 on 2026-09-14.');
    expect(within(summary).getByLabelText('First shortfall')).toHaveTextContent('₹3,000First shortfall · 14 Sept');
    expect(summary).toHaveTextContent(action.question);
    expect(summary).not.toHaveTextContent(/Rent and utilities|24000|24,000|33000|Excludes/);
  });

  it('does not advertise a ready state when updates are stale or a forecast remains qualified', () => {
    const saved = fundedSnapshot();
    const { rerender } = render(<PlanSummary snapshot={saved} />);
    expect(screen.getByRole('region', { name: 'What needs attention' })).toHaveAttribute('data-tone', 'clear');
    rerender(<PlanSummary snapshot={saved} stale />);
    const summary = screen.getByRole('region', { name: 'What needs attention' });
    expect(summary).toHaveAttribute('data-tone', 'neutral');
    expect(summary).not.toHaveTextContent(/ready|finished|available to spend/i);
    expect(summary).toHaveTextContent('Not a spending allowance');
    rerender(<PlanSummary snapshot={{ ...saved, plan: { ...saved.plan, projectionPartial: true } }} />);
    expect(summary).toHaveAttribute('data-tone', 'neutral');
    expect(summary).toHaveTextContent('Incomplete forecast');
  });

  it('renders no conclusion for empty facts or an absent canonical outcome', () => {
    const { rerender } = render(<PlanSummary snapshot={snapshot()} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    const saved = partialSnapshot(); saved.plan.decisionAssessment!.outcome = null;
    rerender(<PlanSummary snapshot={saved} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});