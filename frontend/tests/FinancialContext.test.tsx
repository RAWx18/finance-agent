// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Snapshot } from '../src/api';
import { FinancialContext } from '../src/FinancialContext';
import { Projection } from '../src/Projection';
import { adjustmentOptions, choiceSnapshot, planningSnapshot, scenario, snapshot, unconfirmedSnapshot } from './fixtures';

const controls = { locked: false, proposalActive: true, onCommand: vi.fn<(operation: Command['operation']) => void>() };
beforeEach(() => controls.onCommand.mockClear());

function salary(): Snapshot['facts']['records'][number] {
  return { id: 'salary', label: 'Salary', kind: 'income', amount: { status: 'exact', amountPaise: 2500000 },
    schedule: { date: '2026-09-25', recurrence: 'monthly' }, reliability: 'reliable', autoDebit: false };
}

describe('FinancialContext', () => {
  it.each([null, snapshot()])('keeps an untouched picture free of financial metrics while exposing only the selected server question', saved => {
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.getByRole('region', { name: 'Your financial picture' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
    expect(screen.getByText('They’ll appear as you talk.')).toBeVisible();
    expect(container.querySelector('.context-updates .change-note')).toBeEmptyDOMElement();
    expect(container.querySelector('.proposal-notice')).toBeEmptyDOMElement();
    expect(container.querySelectorAll('.fact-card, .focus-card, .review-numbers')).toHaveLength(0);
    expect(container).not.toHaveTextContent(/₹|Confirm available cash|plan ready/i);
    if (saved) {
      expect(container.querySelector('.focus-action')).toHaveTextContent(saved.plan.decisionAssessment!.actions![0].question);
      expect(screen.getByRole('button', { name: 'I cannot confirm this now' })).toBeEnabled();
    } else expect(screen.queryByRole('button', { name: 'I cannot confirm this now' })).not.toBeInTheDocument();
  });

  it('progressively shows partial opening, income and a server gap without a finished claim', () => {
    const saved = snapshot();
    const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    const learned = planningSnapshot();
    learned.sequence = 1;
    learned.facts.records.push(salary());
    rerender(<FinancialContext {...controls} snapshot={learned} stale={false} mode="live" />);
    expect(screen.getByRole('article', { name: 'Money available' })).toHaveTextContent('₹5,000.00 · Reported');
    expect(screen.getByRole('article', { name: 'Money available' })).toHaveTextContent('At the start of this plan');
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('25 Sept 2026 · Every month');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Not all costs are included');
    expect(container).not.toHaveTextContent(/plan ready|all safe|finished|paid off/i);
  });

  it('preserves unknown amounts, dates, uncertain income and reported debt details', () => {
    const saved = planningSnapshot();
    saved.facts.opening = { status: 'estimate', amountPaise: 500000 };
    saved.facts.records = [
      { ...salary(), reliability: 'uncertain', amount: { status: 'unknown', amountPaise: null }, schedule: { date: null, recurrence: 'fortnightly' } },
      { id: 'card', label: 'Credit card', kind: 'debt', debtType: 'unknown', autoDebit: true,
        amount: { status: 'unknown', amountPaise: null }, target: { status: 'estimate', amountPaise: 700000 },
        outstanding: { status: 'exact', amountPaise: 9000000 }, schedule: { date: null, recurrence: 'weekly' } },
    ];
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('Unknown');
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('Date unknown · Every two weeks');
    expect(screen.getByRole('article', { name: 'Salary' })).toHaveTextContent('Uncertain income · Excluded');
    const debt = screen.getByRole('article', { name: 'Credit card' });
    expect(debt).toHaveTextContent('Required / minimumUnknown');
    expect(debt).toHaveTextContent('Selected target: ₹7,000.00 · Estimate');
    expect(debt).toHaveTextContent('Reported outstanding: ₹90,000.00 · Reported');
    expect(debt).toHaveTextContent('Debt type unknown');
    expect(debt).toHaveTextContent('Every week');
    expect(debt).not.toHaveTextContent('₹0.00');
  });

  it('spotlights a corrected fifth record without reordering saved cards or moving focus', async () => {
    const saved = planningSnapshot();
    saved.facts.records = Array.from({ length: 4 }, (_, index) => ({ ...saved.facts.records[0], id: `bill${index}`, label: `Bill ${index}` }));
    saved.facts.records.push(salary());
    const onInspect = vi.fn();
    const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" onInspect={onInspect} />);
    expect(screen.queryByText(/Latest saved change:/)).not.toBeInTheDocument();
    rerender(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" onInspect={onInspect} />);
    expect(screen.queryByRole('article', { name: 'Salary' })).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'View all figures' }).focus();
    const corrected = structuredClone(saved);
    corrected.sequence = 1;
    corrected.facts.records[4].schedule.date = '2026-09-20';
    corrected.plan.firstGap = { date: '2026-09-16', amountPaise: 1234567 };
    corrected.plan.closingPaise = 7654321;
    corrected.plan.decisionAssessment = { ...corrected.plan.decisionAssessment,
      actions: [{ id: 'checkTiming', kind: 'clarify', question: 'Verify the corrected receipt timing.', beforeDate: '2026-09-16', recordIds: ['salary'], consequenceIds: [], ifDeclinedConsequenceIds: [] }],
      nextActionId: 'checkTiming' };
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="live" onInspect={onInspect} />);
    expect(within(screen.getByRole('group', { name: 'Current reported item' })).getByRole('article', { name: 'Salary' })).toHaveTextContent('20 Sept 2026');
    expect(Array.from(container.querySelectorAll('.context-scroll > .fact-grid > article'), item => item.getAttribute('aria-label')))
      .toEqual(['Money available', 'Bill 0', 'Bill 1', 'Bill 2', 'Bill 3']);
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Salary: 25 Sept 2026 → 20 Sept 2026');
    expect(screen.getByText(/Latest saved change:/)).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹12,345.67');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveAttribute('data-changed', 'true');
    expect(screen.getByRole('button', { name: 'View all figures' })).toHaveFocus();
    expect(screen.getByRole('article', { name: 'Bill 0' })).toHaveAttribute('data-changed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'View all figures' }));
    const figures = screen.getByRole('dialog', { name: 'View all figures' });
    expect(within(figures).getByRole('article', { name: 'Salary' })).toHaveAttribute('data-changed', 'true');
    expect(within(figures).getByRole('article', { name: 'Salary' })).toHaveTextContent('20 Sept 2026');
    expect(within(figures).getAllByRole('listitem').map(item => within(item).getByRole('heading').textContent))
      .toEqual(['Bill 0', 'Bill 1', 'Bill 2', 'Bill 3', 'Salary']);
    await userEvent.click(within(figures).getByRole('button', { name: 'Close view all figures' }));
    expect(onInspect).not.toHaveBeenCalled();
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="review" />);
    expect(screen.getByRole('definition')).toHaveTextContent('₹76,543.21');
    expect(screen.getByRole('article', { name: 'Plan focus' })).not.toHaveTextContent('₹7,000.00');
  });

  it('tracks amounts, additions, removals and opening corrections by stable IDs', () => {
    const saved = planningSnapshot();
    saved.facts.records.push(salary());
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    const corrected = structuredClone(saved);
    corrected.sequence++;
    corrected.facts.opening.amountPaise = 600000;
    corrected.facts.records[1].amount.amountPaise = 3000000;
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="live" />);
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('₹5,000.00 · Reported → ₹6,000.00 · Reported');
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Salary: ₹25,000.00 · Reported → ₹30,000.00 · Reported');
    expect(screen.getByRole('article', { name: 'Money available' })).toHaveAttribute('data-changed', 'true');
    const removed = structuredClone(corrected);
    removed.sequence++;
    removed.facts.records = [removed.facts.records[0], { ...salary(), id: 'bonus', label: 'Bonus' }];
    removed.facts.opening = { amountPaise: null, status: 'unknown' };
    rerender(<FinancialContext {...controls} snapshot={removed} stale={false} mode="live" />);
    expect(screen.queryByRole('article', { name: 'Salary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Money available' })).not.toBeInTheDocument();
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Salary: removed');
    expect(screen.getByRole('article', { name: 'Bonus' })).toHaveAttribute('data-changed', 'true');
  });

  it('keeps proposals separate from accepted plans and reported facts', async () => {
    const saved = planningSnapshot();
    saved.facts.records = [{ ...salary(), id: 'card', label: 'Card', kind: 'debt', debtType: 'card', reliability: null,
      amount: { status: 'exact', amountPaise: 200000 }, target: { status: 'exact', amountPaise: 400000 }, outstanding: { status: 'exact', amountPaise: 8000000 } }];
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    const accepted = structuredClone(saved);
    accepted.sequence++;
    accepted.accepted = scenario('accepted');
    accepted.accepted.adjustments[0].acceptedRevision = 1;
    accepted.accepted.plan.firstGap = { date: '2026-09-15', amountPaise: 432100 };
    accepted.preview = scenario('preview');
    accepted.preview.plan.firstGap = { date: '2026-09-17', amountPaise: 999999 };
    accepted.preview.plan.closingPaise = 8888888;
    rerender(<FinancialContext {...controls} snapshot={accepted} stale={false} mode="live" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹4,321.00');
    expect(screen.getByRole('article', { name: 'Card' })).toHaveTextContent('Reported outstanding: ₹80,000.00');
    expect(screen.getByRole('article', { name: 'Card' })).toHaveTextContent('Selected target: ₹4,000.00');
    expect(screen.getByRole('article', { name: 'Card' })).toHaveAttribute('data-changed', 'false');
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Planning assumptions saved');
    await userEvent.click(screen.getByRole('button', { name: 'Saved planning assumptions' }));
    const assumptions = screen.getByRole('dialog', { name: 'Saved planning assumptions' });
    expect(within(assumptions).getByText(/Consent saved for this occurrence/)).toBeVisible();
    await userEvent.click(within(assumptions).getByRole('button', { name: 'Close saved planning assumptions' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    const proposed = screen.getByRole('region', { name: 'Spending change preview' });
    expect(within(proposed).getByRole('heading', { name: 'Spending change preview' })).toHaveFocus();
    expect(proposed).toHaveTextContent('Not saved');
    expect(proposed).toHaveTextContent('Optional purchase · 27 Sept 2026');
    expect(proposed).toHaveTextContent('₹2,000.00 reported → ₹0.00 assumed');
    expect(proposed).toHaveTextContent('₹88,888.88');
    expect(proposed).toHaveTextContent('₹9,999.99');
    expect(within(proposed).getByRole('checkbox')).toHaveAccessibleName(/unconditionally—not dependent on uncertain income or payee agreement/);
    expect(within(proposed).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposed).getByRole('button', { name: 'Reject preview' })).toBeEnabled();
    expect(controls.onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('article', { name: 'Plan focus' })).not.toHaveTextContent(/₹88,888.88|₹9,999.99/);
    rerender(<FinancialContext {...controls} snapshot={accepted} stale={false} mode="review" />);
    expect(screen.getByText('Assumed closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹12,000.00');
    expect(proposed).toBeVisible();
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, sequence: 2, preview: accepted.preview }} stale={false} mode="review" />);
    expect(screen.getByText('Projected closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹10,000.00');
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Planning assumptions cleared');
  });

  it('does not announce initial GETs, retains changes on identical snapshots and resets between sessions', () => {
    const saved = planningSnapshot();
    const { rerender } = render(<FinancialContext {...controls} snapshot={null} stale={false} mode="live" />);
    rerender(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.queryByText(/Latest saved change:/)).not.toBeInTheDocument();
    const corrected = structuredClone(saved);
    corrected.sequence = 10;
    corrected.facts.records[0].label = 'Home rent';
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="live" />);
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Rent → Home rent');
    rerender(<FinancialContext {...controls} snapshot={structuredClone(corrected)} stale={false} mode="live" />);
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Rent → Home rent');
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, sessionId: 'another-session' }} stale={false} mode="live" />);
    expect(screen.queryByText(/Latest saved change:/)).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Rent' })).toHaveAttribute('data-changed', 'false');
  });

  it('shows only an actual stale notice, clearing it without claiming the voice connection is live', () => {
    const saved = planningSnapshot();
    const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} stale mode="live" />);
    expect(screen.getByText(/Latest changes are not confirmed/)).toHaveAttribute('role', 'status');
    rerender(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.queryByText(/Latest changes are not confirmed/)).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/connected|listening|updating|synchronizing/i);
  });

  it('limits live cards across all categories and opens all figures without editing', async () => {
    const saved = planningSnapshot();
    saved.facts.records = Array.from({ length: 8 }, (_, index) => ({ ...salary(), id: `item${index}`, label: `Item ${index}`,
      kind: (['income', 'essential', 'debt', 'optional'] as const)[index % 4] }));
    const onInspect = vi.fn();
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" onInspect={onInspect} />);
    expect(screen.getAllByRole('article').filter(item => item.classList.contains('fact-card'))).toHaveLength(5);
    expect(screen.getByText('Showing 4 of 8 reported items.')).toBeVisible();
    expect(container.querySelectorAll('.context-scroll > .fact-grid .fact-kind')).toHaveLength(4);
    expect(container.querySelectorAll('details, summary')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'View all figures' }));
    expect(within(screen.getByRole('dialog', { name: 'View all figures' })).getAllByRole('listitem')).toHaveLength(8);
    expect(onInspect).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('offers paged figures in a closed-by-default dialog without an inspection callback', async () => {
    const saved = planningSnapshot();
    saved.facts.records = Array.from({ length: 25 }, (_, index) => ({ ...salary(), id: `item${index}`, label: `Item ${index}` }));
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View all figures' }));
    expect(within(screen.getByRole('list', { name: 'Saved items' })).getAllByRole('listitem')).toHaveLength(20);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(within(screen.getByRole('list', { name: 'Saved items' })).getAllByRole('listitem')).toHaveLength(5);
    expect(within(screen.getByRole('list', { name: 'Saved items' })).getByRole('article', { name: 'Item 24' })).toBeVisible();
  });

  it.each(['review', 'finished'] as const)('keeps %s incomplete, limits actions and opens facts and checks on request', async mode => {
    const saved = planningSnapshot();
    saved.plan.closingPaise = null;
    saved.plan.decisionAssessment = {
      actions: Array.from({ length: 5 }, (_, index) => ({ id: `step${index}`, kind: 'clarify',
        question: `Server guidance ${index}`, beforeDate: '2026-09-13', recordIds: ['rent'], consequenceIds: [], ifDeclinedConsequenceIds: [] })),
      nextActionId: 'step4',
      uncertainties: Array.from({ length: 25 }, (_, index) => ({ id: `check${index}`, kind: 'missing',
        question: `Unresolved ${index}`, recordIds: ['rent'], field: 'amount', priority: index,
        changes: ['affordability'], blocks: ['fullPlan'], reason: 'The reported amount needs checking.' })),
    };
    const onInspect = vi.fn();
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode={mode} onInspect={onInspect} />);
    expect(screen.getByRole('heading', { name: 'Your 30-day plan' })).toBeVisible();
    expect(screen.getByText('Projected closing cash').parentElement).toHaveTextContent('Unknown');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Not all costs are included');
    const actions = screen.getByRole('region', { name: 'Next steps' });
    expect(within(actions).getAllByRole('listitem')).toHaveLength(3);
    expect(within(actions).getAllByRole('listitem')[0]).toHaveTextContent('Server guidance 4');
    expect(actions).toHaveTextContent('13 Sept 2026');
    expect(actions).toHaveTextContent('Rent');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'What this is based on' })).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Open questions' }));
    expect(within(screen.getByRole('list', { name: 'Remaining checks' })).getAllByRole('listitem')).toHaveLength(20);
    await userEvent.click(screen.getByRole('button', { name: 'Close open questions' }));
    await userEvent.click(screen.getByRole('button', { name: 'What this is based on' }));
    expect(screen.getByRole('list', { name: 'Saved items' })).toHaveTextContent('Rent');
    await userEvent.click(screen.getByRole('button', { name: 'Close what this is based on' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit figures' }));
    expect(onInspect).toHaveBeenCalledOnce();
    expect(container).not.toHaveTextContent(/plan ready|all resolved|all safe|paid off/i);
  });

  it('keeps a first gap prominent even with a qualified plan and positive closing cash', () => {
    const saved = planningSnapshot();
    saved.plan.decisionAssessment!.outcome!.readiness = 'qualified';
    saved.plan.projectionPartial = false;
    saved.plan.peakGapPaise = saved.plan.firstGap!.amountPaise;
    saved.plan.peakGapDate = saved.plan.firstGap!.date;
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    const focus = screen.getByRole('article', { name: 'Plan focus' });
    expect(focus).toHaveAttribute('data-tone', 'warning');
    expect(focus).toHaveTextContent('First cash gap');
    expect(focus).toHaveTextContent('₹7,000.00');
    expect(focus).toHaveTextContent('Some figures need checking');
    expect(screen.getByRole('region', { name: 'Next steps' })).toHaveTextContent('Contact the provider before the due date.');
    expect(focus).not.toHaveTextContent('Largest gap');
    expect(screen.getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    expect(screen.getByText('Closing cash does not remove an earlier gap.')).toBeVisible();
    expect(screen.queryByText('Known commitments look covered')).not.toBeInTheDocument();
  });

  it('only calls known commitments covered when the server says fits', () => {
    const saved = planningSnapshot();
    saved.plan = { ...saved.plan, firstGap: null, peakGapPaise: 0, projectionPartial: false, issues: [],
      decisionAssessment: { actions: [], uncertainties: [], outcome: {
        branch: 'fits', readiness: 'ready', trueNow: [], uncertain: [], revisit: 'Revisit if figures change.',
        summary: 'Known dated commitments fit the reported cash.', covered: 'Known dated requirements.',
        notCovered: 'Unreported commitments.', nextStep: 'Review this outcome.', conditions: 'Reported figures only.',
        riskIds: [], choiceIds: [], nextActionId: null,
      } } };
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="finished" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveAttribute('data-tone', 'positive');
    expect(screen.getByRole('heading', { name: 'Known commitments look covered' })).toBeVisible();
    expect(screen.queryByText(/all safe|plan ready/i)).not.toBeInTheDocument();
  });

  it('uses the server-selected question rather than array order, priority numbers or gap maths', async () => {
    const saved = snapshot();
    saved.facts.records = [{ ...salary(), schedule: { date: null, recurrence: 'monthly' } }];
    saved.plan.firstGap = { date: '2026-09-13', amountPaise: 700000 };
    saved.plan.decisionAssessment!.uncertainties!.push({ id: 'selectedDate', kind: 'missing', field: 'schedule.date',
      question: 'When will Salary arrive?', recordIds: ['salary'], beforeDate: '2026-09-25',
      changes: ['when'], blocks: ['fullPlan'], priority: 99, reason: 'Receipt timing affects this decision.' });
    saved.plan.decisionAssessment!.nextQuestionId = 'selectedDate';
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(container.querySelectorAll('.clarification')).toHaveLength(1);
    expect(container.querySelector('.clarification')).toHaveTextContent('When will Salary arrive? · Before 25 Sept 2026');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('First cash gap');
    for (const reason of screen.getAllByText('Receipt timing affects this decision.')) expect(reason).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Why this matters' }));
    const explanation = screen.getByRole('dialog', { name: 'Why this matters' });
    expect(explanation).toHaveTextContent('What cash was available at the original cash basis?');
    expect(explanation).toHaveTextContent('Receipt timing affects this decision.');
    expect(container).not.toHaveTextContent('Confirm available cash; balances cannot be calculated yet.');
    expect(screen.queryByRole('article', { name: 'Money available' })).not.toBeInTheDocument();
  });

  it.each(['uncertain', 'conflict', 'gap'] as const)('does not turn the %s branch into a covered conclusion', branch => {
    const saved = planningSnapshot();
    saved.plan.firstGap = null;
    saved.plan.peakGapPaise = 0;
    saved.plan.projectionPartial = false;
    saved.plan.decisionAssessment!.outcome!.branch = branch;
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Some figures need checking');
    expect(container).not.toHaveTextContent('Known commitments look covered');
    expect(container).toHaveTextContent('11 Sept 2026 – 10 Oct 2026');
  });

  it('shows learned coverage without inventing a finished outcome or questionnaire', () => {
    const saved = snapshot();
    saved.facts.coverage.debt = 'none';
    saved.plan.decisionAssessment = {};
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Your picture is taking shape');
    expect(container.querySelectorAll('.fact-card, .clarification')).toHaveLength(0);
    expect(container).not.toHaveTextContent(/₹|Review essential coverage|Known commitments look covered/);
  });

  it('keeps first and largest gaps visible when conflicting figures need reconciliation', async () => {
    const saved = planningSnapshot();
    saved.plan.decisionAssessment!.outcome!.branch = 'conflict';
    saved.plan.decisionAssessment!.actions![0].question = 'Do the required payment and outstanding balance refer to the same account?';
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    const focus = screen.getByRole('article', { name: 'Plan focus' });
    expect(focus).toHaveTextContent('Reported figures conflict');
    expect(focus).toHaveTextContent('First cash gap₹7,000.00On 13 Sept 2026');
    expect(focus).toHaveTextContent('Largest gap: ₹16,000.00 on 18 Sept 2026');
    await userEvent.click(within(focus).getByRole('button', { name: 'Contact the payee · Before 13 Sept 2026' }));
    expect(within(screen.getByRole('dialog', { name: 'Contact the payee · Before 13 Sept 2026' }))
      .getByText('Do the required payment and outstanding balance refer to the same account?')).toBeVisible();
    expect(focus).not.toHaveTextContent('Known commitments look covered');
  });

  it('qualifies positive dated totals with unresolved commitments instead of available spending money', async () => {
    const saved = planningSnapshot();
    saved.plan.firstGap = null;
    saved.plan.peakGapPaise = 0;
    saved.plan.projectionPartial = false;
    saved.facts.records[0].schedule.date = null;
    saved.plan.budgetBasis = { datedProjectionComplete: false, unresolvedAmounts: [
      { recordId: 'rent', reason: 'missingDate', amount: { amountPaise: 1200000, status: 'exact' }, recurrence: 'monthly' },
    ] };
    saved.plan.decisionAssessment = {
      uncertainties: [{ id: 'rentDate', kind: 'missing', field: 'schedule.date', recordIds: ['rent'],
        question: 'When is the next unpaid Rent due?', reason: 'The rent date determines which cash must be available first.',
        changes: ['when', 'affordability'], blocks: ['immediateDecision', 'fullPlan'], priority: 10 }],
      actions: [{ id: 'clarifyRent', kind: 'clarify', recordIds: ['rent'], beforeDate: null,
        question: 'When is the next unpaid Rent due?', consequenceIds: [], ifDeclinedConsequenceIds: [] }],
      nextQuestionId: 'rentDate', nextActionId: 'clarifyRent', outcome: { ...saved.plan.decisionAssessment!.outcome!,
        branch: 'uncertain', summary: 'Rent is reported but its timing is unresolved.', nextActionId: 'clarifyRent',
        nextStep: 'When is the next unpaid Rent due?', uncertain: ['rentDate'],
        covered: 'Only dated commitments are in this balance.', notCovered: 'Rent is not included in dated outflows.', conditions: 'Confirm its due date before deciding what is available.' },
    };
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Not all costs are included');
    expect(screen.getByText('Rent is reported but its timing is unresolved.')).not.toBeVisible();
    expect(screen.getByRole('region', { name: 'Next steps' })).toHaveTextContent('When is the next unpaid Rent due?');
    expect(screen.getByRole('region', { name: 'Next steps' })).toHaveTextContent('Rent · Reported ₹12,000.00 · Date unknown');
    expect(screen.getByText(/These balances are not available to spend/)).toBeVisible();
    expect(screen.getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Missing amounts or dates' }));
    const unresolved = screen.getByRole('list', { name: 'Unresolved amounts and dates' });
    expect(unresolved).toHaveTextContent('Rent₹12,000.00 · Every month');
    expect(unresolved).toHaveTextContent('Date unknown · not included in dated totals.');
    expect(screen.queryByText('Known commitments look covered')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('resolves outcome uncertainty references and exposes server truth and revisit text without IDs', async () => {
    const saved = planningSnapshot();
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    await userEvent.click(screen.getByRole('button', { name: 'Plan details' }));
    expect(screen.getByRole('list', { name: 'What is known now' })).toHaveTextContent('Later income does not resolve earlier dues.');
    expect(screen.getByText(/Recalculate after a receipt correction/)).toBeVisible();
    expect(screen.getByText(saved.plan.decisionAssessment!.outcome!.covered)).toBeVisible();
    expect(screen.getByText(saved.plan.decisionAssessment!.outcome!.notCovered)).toBeVisible();
    expect(screen.getByText(saved.plan.decisionAssessment!.outcome!.conditions)).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Plan details' })).toHaveTextContent(saved.plan.decisionAssessment!.outcome!.summary);
    await userEvent.click(screen.getByRole('button', { name: 'Close plan details' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open questions' }));
    expect(screen.getByRole('list', { name: 'Remaining checks' })).toHaveTextContent('Only an actual agreement could change this exposed deadline.');
    await userEvent.click(screen.getByRole('button', { name: 'Close open questions' }));
    const actions = screen.getByRole('region', { name: 'Next steps' });
    expect(actions).toHaveTextContent('Before 13 Sept 2026');
    expect(actions).toHaveTextContent('Rent · Reported ₹12,000.00 · Due 13 Sept 2026');
    expect(actions).toHaveTextContent('Remains if the payee declines; no agreement is assumed.');
    expect(container).not.toHaveTextContent(/provider:rent|contact:rent|cash:2026|providerResponses|cashExposure/);
  });

  it('shows explicit income conditions and server comparison amounts without replacing the current picture', async () => {
    const saved = planningSnapshot();
    saved.plan.events = [{ id: 'salary:2026-09-25', recordId: 'salary', label: 'Salary', kind: 'income',
      date: '2026-09-25', originalDueDate: '2026-09-25', amountPaise: 2500000, amountBasis: 'reported', included: false,
      overdue: false, autoDebit: false, balancePaise: 1000000 }];
    saved.plan.incomeComparisons = [
      { id: 'income:reportedDate', conditions: [{ eventId: 'salary:2026-09-25', arrival: 'reportedDate' }], metrics: { ...saved.plan, closingPaise: 3500000 } },
      { id: 'income:notByHorizon', conditions: [{ eventId: 'salary:2026-09-25', arrival: 'notByHorizon' }], metrics: { ...saved.plan } },
    ];
    const { container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    await userEvent.click(screen.getByRole('button', { name: 'Income possibilities' }));
    const conditions = screen.getByRole('list', { name: 'Conditional income comparisons' });
    expect(conditions).toHaveTextContent('If Salary (₹25,000.00) arrives on 25 Sept 2026.');
    expect(conditions).toHaveTextContent('If Salary (₹25,000.00) does not arrive within these 30 days.');
    expect(conditions).toHaveTextContent('Conditional closing cash: ₹35,000.00');
    expect(conditions).toHaveTextContent('Conditional closing cash: ₹10,000.00');
    expect(screen.getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    expect(container).not.toHaveTextContent(/income:reportedDate|notByHorizon|salary:2026/);
  });

  it('renders only returned proposals, including readiness, exact occurrences and an unsolved earliest gap', async () => {
    const saved = planningSnapshot();
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.queryByRole('button', { name: 'Review proposed change' })).not.toBeInTheDocument();
    saved.preview = scenario();
    saved.preview.adjustments[0].acceptanceReady = false;
    saved.preview.adjustments.push({ ...adjustmentOptions.options[1], amountPaise: 200000, acceptedRevision: null });
    rerender(<FinancialContext {...controls} snapshot={{ ...saved }} stale={false} mode="live" />);
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(proposal).toHaveTextContent('Not saved');
    expect(proposal).toHaveTextContent('Not ready to save · confirm this spending is changeable and uncommitted first.');
    expect(proposal).toHaveTextContent('Card payment · 26 Sept 2026');
    expect(proposal).toHaveTextContent('₹4,000.00 reported → ₹2,000.00 assumed');
    expect(proposal).toHaveTextContent('Minimum is not payoff');
    expect(proposal).toHaveTextContent('A cash gap remains on 13 Sept 2026.');
    expect(proposal).not.toHaveTextContent(/optional-terms|card-terms|acceptedRevision|acceptanceReady/);
    expect(within(proposal).getByRole('checkbox')).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(within(proposal).getByRole('button', { name: 'Reject preview' })).toBeEnabled();
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, preview: null }} stale={false} mode="live" />);
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review proposed change' })).not.toBeInTheDocument();
  });

  it('shows removed consent in a replacement proposal without clearing current accepted assumptions', async () => {
    const saved = planningSnapshot();
    saved.accepted = scenario('accepted');
    saved.accepted.adjustments[0].acceptedRevision = 1;
    saved.preview = scenario();
    saved.preview.adjustments = [{ ...adjustmentOptions.options[1], amountPaise: 200000 }];
    saved.preview.removedAssumptionIds = [saved.accepted.adjustments[0].eventId];
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    expect(proposal).toHaveTextContent('Optional purchase · 27 Sept 2026 · ₹0.00 assumed → ₹2,000.00 reported');
    expect(screen.getByText('Assumed closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹12,000.00');
  });

  it('preserves independent accepted assumptions and names only the actual invalidated occurrence after corrections', async () => {
    const saved = planningSnapshot();
    saved.facts.records.push({ id: 'optional', label: 'Optional purchase', kind: 'optional',
      amount: { status: 'exact', amountPaise: 200000 }, schedule: { date: '2026-09-27', recurrence: 'once' },
      controllability: 'controllable', autoDebit: false });
    saved.accepted = scenario('accepted');
    saved.accepted.adjustments[0].acceptedRevision = 1;
    saved.accepted.adjustments.push({ ...adjustmentOptions.options[1], amountPaise: 200000, acceptedRevision: 1 });
    saved.preview = scenario();
    const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    const corrected = structuredClone(saved);
    corrected.sequence++;
    corrected.revision++;
    corrected.preview = null;
    corrected.facts.opening.amountPaise = 600000;
    corrected.facts.records[1].schedule.date = '2026-09-28';
    corrected.accepted!.adjustments = [corrected.accepted!.adjustments[1]];
    corrected.accepted!.plan.closingPaise = 1234500;
    corrected.invalidatedAssumptions = [{ eventId: 'optional:2026-09-27', reason: 'Occurrence date, amount, minimum, controllability or obligation terms changed; confirm a fresh proposal.' }];
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="review" />);
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('₹5,000.00 · Reported → ₹6,000.00 · Reported');
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('unaffected assumptions remain saved');
    const invalidated = screen.getByRole('region', { name: 'Assumptions needing fresh consent' });
    expect(invalidated).toHaveTextContent('Optional purchase · 27 Sept 2026');
    expect(invalidated).toHaveTextContent(corrected.invalidatedAssumptions[0].reason);
    expect(invalidated).not.toHaveTextContent('Card payment');
    expect(screen.getByText('Assumed closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹12,345.00');
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Saved planning assumptions' }));
    expect(screen.getByRole('list', { name: 'Planning assumptions' })).toHaveTextContent('Card payment · 26 Sept 2026');
    expect(screen.getByRole('list', { name: 'Planning assumptions' })).toHaveTextContent('Consent saved for this occurrence');
    expect(container).not.toHaveTextContent(/optional:2026|dependencyKey|Planning assumptions cleared/);
    rerender(<FinancialContext {...controls} snapshot={structuredClone(corrected)} stale={false} mode="review" />);
    expect(screen.getByRole('list', { name: 'Affected assumptions' })).toHaveTextContent('Optional purchase · 27 Sept 2026');
  });

  it('does not invent invalidations when a receipt correction retains every accepted assumption', () => {
    const saved = planningSnapshot();
    saved.facts.records.push(salary());
    saved.accepted = scenario('accepted');
    saved.accepted.adjustments[0].acceptedRevision = 1;
    const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="review" />);
    const corrected = structuredClone(saved);
    corrected.sequence++;
    corrected.facts.records[1].schedule.date = '2026-09-20';
    corrected.accepted!.plan.closingPaise = 987654;
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="review" />);
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Salary: 25 Sept 2026 → 20 Sept 2026');
    expect(screen.getByText('Assumed closing cash', { selector: '.review-numbers dt' }).parentElement).toHaveTextContent('₹9,876.54');
    expect(screen.queryByRole('region', { name: 'Assumptions needing fresh consent' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/Planning assumptions cleared|Affected assumptions need fresh consent/);
  });

  it('keeps the picture and inline proposal mounted while replacing exact amounts without moving focus', async () => {
    const saved = planningSnapshot();
    saved.facts.records.push(salary());
    const { container, rerender } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    const scroll = screen.getByRole('region', { name: 'Financial picture details' });
    const updates = container.querySelector('.context-updates');
    const note = container.querySelector('.change-note');
    const notice = container.querySelector('.proposal-notice');
    expect(note).toBeEmptyDOMElement();
    expect(notice).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Recent changes' })).not.toBeInTheDocument();
    const corrected = structuredClone(saved);
    corrected.sequence++;
    corrected.facts.records[1].amount.amountPaise = 3000000;
    corrected.facts.records[1].schedule.date = '2026-09-20';
    corrected.preview = scenario();
    scroll.focus();
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="live" />);
    expect(scroll).toHaveFocus();
    expect(container.querySelector('.context-updates')).toBe(updates);
    expect(container.querySelector('.change-note')).toBe(note);
    expect(container.querySelector('.proposal-notice')).toBe(notice);
    expect(screen.getByRole('region', { name: 'Financial picture details' })).toBe(scroll);
    expect(scroll.querySelector('.context-preview')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Latest saved change:/)).toHaveTextContent('Salary: ₹25,000.00 · Reported → ₹30,000.00 · Reported; 25 Sept 2026 → 20 Sept 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Recent changes' }));
    expect(screen.getByRole('dialog', { name: 'Recent changes' })).toHaveTextContent('₹25,000.00 · Reported → ₹30,000.00 · Reported');
    expect(screen.getByRole('dialog', { name: 'Recent changes' })).toHaveTextContent('25 Sept 2026 → 20 Sept 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Close recent changes' }));
    expect(screen.getByRole('button', { name: 'Recent changes' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Review proposed change' }));
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    const consent = within(proposal).getByRole('checkbox');
    await userEvent.click(consent);
    expect(consent).toBeChecked();
    expect(consent).toHaveFocus();
    const revised = structuredClone(corrected);
    revised.sequence++;
    revised.preview!.plan.closingPaise = 987654;
    revised.preview!.adjustments[0].amountPaise = 12345;
    revised.preview!.reducedOutflowPaise = 187655;
    rerender(<FinancialContext {...controls} snapshot={revised} stale={false} mode="live" />);
    expect(screen.getByRole('region', { name: 'Spending change preview' })).toBe(proposal);
    expect(consent).toHaveFocus();
    expect(consent).not.toBeChecked();
    expect(within(proposal).getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(proposal).toHaveTextContent('₹9,876.54');
    expect(proposal).toHaveTextContent('₹2,000.00 reported → ₹123.45 assumed');
    expect(proposal).toHaveTextContent('₹1,876.55 less planned spending');
    expect(proposal).not.toHaveTextContent('₹12,000.00');
    expect(container.querySelector('.proposal-notice')).toBe(notice);
    expect(container.querySelector('.context-scroll')).toBe(scroll);
    expect(container.querySelectorAll('details, summary')).toHaveLength(0);
  });

  it('keeps open figures in stable order while showing corrected authoritative amounts', async () => {
    const saved = planningSnapshot();
    saved.facts.records = Array.from({ length: 5 }, (_, index) => ({ ...salary(), id: `item${index}`, label: `Item ${index}` }));
    const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    await userEvent.click(screen.getByRole('button', { name: 'View all figures' }));
    const figures = screen.getByRole('dialog', { name: 'View all figures' });
    const close = within(figures).getByRole('button', { name: 'Close view all figures' });
    close.focus();
    const corrected = structuredClone(saved);
    corrected.sequence++;
    corrected.facts.records[4].amount.amountPaise = 3210987;
    rerender(<FinancialContext {...controls} snapshot={corrected} stale={false} mode="live" />);
    expect(screen.getByRole('dialog', { name: 'View all figures' })).toBe(figures);
    expect(close).toHaveFocus();
    expect(within(figures).getAllByRole('listitem').map(item => within(item).getByRole('heading').textContent))
      .toEqual(['Item 0', 'Item 1', 'Item 2', 'Item 3', 'Item 4']);
    expect(within(figures).getByRole('article', { name: 'Item 4' })).toHaveTextContent('₹32,109.87');
    expect(within(figures).getByRole('article', { name: 'Item 4' })).toHaveAttribute('data-changed', 'true');
    await userEvent.click(close);
    expect(screen.getByRole('button', { name: 'View all figures' })).toHaveFocus();
    expect(within(screen.getByRole('group', { name: 'Current reported item' })).getByRole('article', { name: 'Item 4' })).toHaveTextContent('₹32,109.87');
    expect(container.querySelectorAll('.context-scroll > .fact-grid > article')).toHaveLength(5);
  });

  it('defers the selected opening question and displays the next server question without resolving either risk', async () => {
    const saved = snapshot();
    const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    await userEvent.click(screen.getByRole('button', { name: 'I cannot confirm this now' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'respondToAction', actionId: 'clarify:opening', response: 'unavailable' });
    expect(screen.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    const deferred = unconfirmedSnapshot();
    rerender(<FinancialContext {...controls} snapshot={deferred} stale={false} mode="live" />);
    const focus = screen.getByRole('article', { name: 'Plan focus' });
    expect(focus.querySelector('.focus-action')).toHaveTextContent(deferred.plan.decisionAssessment!.actions![0].question);
    expect(focus).not.toHaveTextContent(saved.plan.decisionAssessment!.actions![0].question);
    expect(screen.getByLabelText('Saved answers')).toHaveTextContent('Unconfirmed details remain open.');
    expect(screen.queryByRole('article', { name: 'Money available' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/₹0\.00|Known commitments look covered/);
    await userEvent.click(screen.getByRole('button', { name: 'Open questions' }));
    const questions = screen.getByRole('list', { name: 'Remaining checks' });
    expect(questions).toHaveTextContent(saved.plan.decisionAssessment!.uncertainties![0].question);
    expect(within(questions).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Close open questions' }));
    await userEvent.click(screen.getByRole('button', { name: 'I cannot confirm this now' }));
    expect(controls.onCommand).toHaveBeenLastCalledWith({ type: 'respondToAction', actionId: 'clarify:coverage', response: 'unavailable' });
    expect(deferred.facts.opening.amountPaise).toBeNull();
    expect(deferred.plan.closingPaise).toBeNull();
  });

  it.each(['clarify', 'confirmReceipt', 'verifyTerms'] as const)('submits unavailable only for the selected %s action', async kind => {
    const saved = planningSnapshot();
    saved.plan.decisionAssessment!.actions![0].kind = kind;
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    await userEvent.click(screen.getByRole('button', { name: 'I cannot confirm this now' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'respondToAction', actionId: saved.plan.decisionAssessment!.nextActionId, response: 'unavailable' });
  });

  it.each(['reduceOptional', 'cardMinimum'] as const)('distinguishes discarding a preview from declining the selected %s cut', async kind => {
    const saved = choiceSnapshot(kind);
    saved.preview = scenario();
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
    await userEvent.click(screen.getByRole('button', { name: 'Reject preview' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'discardPreview', previewId: saved.preview.id });
    expect(screen.queryByLabelText('Saved answers')).not.toBeInTheDocument();
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, sequence: 1, preview: null }} stale={false} mode="live" />);
    await userEvent.click(screen.getByRole('button', { name: 'Do not suggest this cut' }));
    expect(controls.onCommand).toHaveBeenLastCalledWith({ type: 'respondToAction', actionId: 'preview-spending', response: 'declined' });
    const declined = structuredClone(saved);
    declined.sequence = 2; declined.revision = 1; declined.preview = null;
    declined.facts.decision = { ...declined.facts.decision!, responses: [{ actionId: 'preview-spending', response: 'declined', dependencyKey: 'spending-terms' }] };
    declined.plan.decisionAssessment!.actions = [declined.plan.decisionAssessment!.actions![0]];
    declined.plan.decisionAssessment!.nextActionId = declined.plan.decisionAssessment!.actions[0].id;
    rerender(<FinancialContext {...controls} snapshot={declined} stale={false} mode="live" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Contact the provider before the due date.');
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
    expect(screen.getByLabelText('Saved answers')).toHaveTextContent('Declined cuts are not assumed.');
    expect(screen.queryByRole('button', { name: 'Do not suggest this cut' })).not.toBeInTheDocument();
    expect(declined.facts.records).toEqual(saved.facts.records);
  });

  it.each(['contactPayee', 'reviewOutcome', 'followUp', 'seekSupport', 'resolveGroup', 'reconcileStatus', 'previewChange'] as const)('does not invent a response for unsupported or unlinked %s actions', kind => {
    const saved = planningSnapshot();
    saved.plan.decisionAssessment!.actions![0].kind = kind;
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.queryByRole('button', { name: /I cannot confirm this now|Do not suggest this cut/ })).not.toBeInTheDocument();
  });

  it('uses the accepted assessment rather than an inactive baseline cut', () => {
    const saved = choiceSnapshot();
    saved.accepted = scenario('accepted');
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('Contact the provider before the due date.');
    expect(screen.queryByRole('button', { name: 'Do not suggest this cut' })).not.toBeInTheDocument();
  });

  it.each(['locked', 'stale'] as const)('blocks action answers while %s, including before any figures are known', async reason => {
    const { rerender } = render(<FinancialContext {...controls} snapshot={snapshot()} stale={reason === 'stale'} locked={reason === 'locked'} mode="live" />);
    const unavailable = screen.getByRole('button', { name: 'I cannot confirm this now' });
    expect(unavailable).toBeDisabled();
    await userEvent.click(unavailable);
    rerender(<FinancialContext {...controls} snapshot={choiceSnapshot()} stale={reason === 'stale'} locked={reason === 'locked'} mode="live" />);
    const declined = screen.getByRole('button', { name: 'Do not suggest this cut' });
    expect(declined).toBeDisabled();
    await userEvent.click(declined);
    expect(controls.onCommand).not.toHaveBeenCalled();
  });

  it.each(['sequence', 'revision', 'sourceRevision', 'replacement', 'session', 'stale', 'locked', 'inactive'] as const)('requires fresh explicit consent after %s changes and never restores an earlier check', async change => {
    const saved: Snapshot = { ...planningSnapshot(), sequence: 1, preview: scenario() };
    const props = { ...controls, snapshot: saved, stale: false, mode: 'live' as const };
    const { rerender } = render(<FinancialContext {...props} />);
    const consent = screen.getByRole('checkbox');
    await userEvent.click(consent);
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    rerender(<FinancialContext {...props} snapshot={structuredClone(saved)} />);
    expect(consent).toBeChecked();
    const changed = { ...props, snapshot: structuredClone(saved) };
    if (change === 'sequence') changed.snapshot.sequence++;
    if (change === 'revision') { changed.snapshot.revision++; changed.snapshot.preview!.sourceRevision++; }
    if (change === 'sourceRevision') changed.snapshot.preview!.sourceRevision++;
    if (change === 'replacement') changed.snapshot.preview!.id = 'replacement-preview';
    if (change === 'session') changed.snapshot.sessionId = 'another-session';
    if (change === 'stale') changed.stale = true;
    if (change === 'locked') changed.locked = true;
    if (change === 'inactive') changed.proposalActive = false;
    rerender(<FinancialContext {...changed} />);
    expect(consent).not.toBeChecked();
    if (change !== 'inactive') expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    else expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument();
    rerender(<FinancialContext {...props} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    expect(controls.onCommand).not.toHaveBeenCalled();
  });

  it('cannot carry consent across preview removal or submit before explicit agreement', async () => {
    const saved = { ...planningSnapshot(), preview: scenario() };
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(controls.onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox'));
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, preview: null }} stale={false} mode="live" />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    rerender(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(controls.onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'acceptPreview', previewId: saved.preview.id, confirmed: true, consentScope: 'unconditional' });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('article', { name: 'Plan focus' })).toHaveTextContent('₹7,000.00');
  });

  it('keeps the full proposal accessible through pagination and includes every occurrence in consent', async () => {
    const saved = { ...planningSnapshot(), preview: scenario() };
    saved.preview.adjustments = Array.from({ length: 23 }, (_, index) => ({ ...saved.preview.adjustments[0],
      eventId: `expense${index}:2026-09-27`, label: `Expense ${index}`, amountPaise: index }));
    render(<FinancialContext {...controls} snapshot={saved} stale={false} mode="live" />);
    const proposal = screen.getByRole('region', { name: 'Spending change preview' });
    const assumptions = within(proposal).getByRole('list', { name: 'Planning assumptions' });
    expect(within(assumptions).getAllByRole('listitem')).toHaveLength(20);
    expect(assumptions).not.toHaveTextContent('Expense 22');
    await userEvent.click(within(proposal).getByRole('button', { name: 'Next' }));
    expect(within(assumptions).getAllByRole('listitem')).toHaveLength(3);
    expect(assumptions).toHaveTextContent('Expense 22 · 27 Sept 2026');
    expect(assumptions).toHaveTextContent('₹2,000.00 reported → ₹0.22 assumed');
    await userEvent.click(within(proposal).getByRole('checkbox'));
    await userEvent.click(within(proposal).getByRole('button', { name: 'Accept planning assumptions' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'acceptPreview', previewId: saved.preview.id, confirmed: true, consentScope: 'unconditional' });
  });

  it('keeps the secondary inspector on the authoritative assessment and preserves its financial labels', () => {
    const saved = planningSnapshot();
    saved.plan.decisionAssessment!.outcome!.branch = 'conflict';
    const { container } = render(<Projection snapshot={saved} stale={false}><p>Compare your spending choices.</p></Projection>);
    expect(container.querySelector('.projection')).toHaveAttribute('aria-label', 'Financial details');
    expect(container.querySelectorAll('details, summary')).toHaveLength(0);
    expect(screen.getByText('Compare your spending choices.')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Saved items' })).toHaveTextContent('Rent');
    expect(screen.getByRole('heading', { name: 'Reported figures conflict' })).toBeVisible();
    expect(screen.getByText('First cash gap').parentElement).toHaveTextContent('₹7,000.00');
    expect(screen.getByText('Largest cash gap').parentElement).toHaveTextContent('₹16,000.00');
    expect(screen.getByText('Projected closing cash').parentElement).toHaveTextContent('₹10,000.00');
    expect(screen.getByRole('region', { name: 'Next steps' })).toHaveTextContent('Contact the provider before the due date.');
  });
});