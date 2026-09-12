// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { readSnapshot } from '../src/api';
import type { Command, Snapshot } from '../src/api';
import { FinancialContext } from '../src/FinancialContext';
import { ResultDetails } from '../src/WorkspaceDetails';
import { planningSnapshot, scenario, snapshot } from './fixtures';
import { projectWorkspace } from './workspace';

const controls = { locked: false, stale: false, proposalActive: true, onCommand: vi.fn<(operation: Command['operation']) => Promise<Snapshot | undefined>>().mockResolvedValue(planningSnapshot()) };

it('keeps an empty or coverage-only workspace free of report and outcome cards', () => {
  const saved = snapshot();
  expect(projectWorkspace(saved).workspace!.cards).toEqual([]);
  saved.facts.coverage.income = 'unknown';
  expect(projectWorkspace(saved).workspace!.cards).toEqual([]);
  render(<FinancialContext {...controls} snapshot={saved} />);
  expect(screen.getByText('Figures appear as you talk')).toBeVisible();
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
});

it('projects four canonical patterns with active event priority, hidden uncertainty and copied metrics', () => {
  const saved = planningSnapshot();
  saved.facts.records.push(...['z', 'y', 'x', 'b', 'a', 'budget', 'salary'].map(id => ({ ...saved.facts.records[0], id, label: id,
    kind: id === 'salary' ? 'income' as const : 'essential' as const,
    schedule: { date: null, certainty: 'unknown' as const, recurrence: id === 'budget' ? 'monthlyBudget' as const : 'once' as const } })));
  saved.accepted = scenario('accepted'); saved.preview = scenario();
  saved.invalidatedAssumptions = [{ eventId: 'rent:2026-09-13', reason: 'Amount changed.' }];
  const plan = saved.accepted.plan;
  plan.events = [
    { ...saved.plan.events[0], id: 'budget:daily', recordId: 'budget', amountBasis: 'budget' },
    { ...saved.plan.events[0], id: 'salary:next', recordId: 'salary', kind: 'income' },
    saved.plan.events[0], { ...saved.plan.events[0], id: 'rent:later', date: '2026-09-20' },
  ];
  plan.closingPaise = 1234567;
  plan.decisionAssessment!.uncertainties = ['z', 'y', 'x'].map((id, priority) => ({ ...saved.plan.decisionAssessment!.uncertainties![0],
    id: `unknown:${id}`, kind: 'missing', field: 'schedule.date', recordIds: [id], priority }));
  projectWorkspace(saved);
  expect(saved.workspace!.cards!.map(card => card.template)).toEqual(['cash', 'timeline', 'questions', 'proposal']);
  const timeline = saved.workspace!.cards!.find(card => card.template === 'timeline')!;
  expect(timeline.recordIds).toEqual(['salary', 'rent', 'z', 'y', 'x', 'a', 'b', 'budget']);
  expect(timeline.eventIds).toEqual(['salary:next', 'rent:2026-09-13']);
  expect(saved.workspace!.cards!.find(card => card.template === 'cash')!.resultIds).toEqual(['opening', 'firstGap', 'closing', 'trough']);
  expect(saved.workspace!.cards!.find(card => card.template === 'questions')!.issueIds).toEqual(['unknown:x']);
  expect(saved.workspace!.cards!.find(card => card.template === 'proposal')).toMatchObject({ title: 'Plan changes', state: 'proposed' });
  expect(saved.workspace!.results!.find(result => result.id === 'closing')!.amountPaise).toBe(1234567);
  expect(saved.workspace!.results!.find(result => result.id === 'firstGap')!.amountPaise).toBe(plan.firstGap!.amountPaise);
  expect(readSnapshot(saved)).toBe(saved);
});

it('explains same-day income after the gap witness without claiming it covered that gap', async () => {
  const saved = planningSnapshot();
  saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 1000000, status: 'exact' },
    schedule: { date: '2026-09-13', certainty: 'exact', recurrence: 'once' }, reliability: 'reliable', autoDebit: false });
  projectWorkspace(saved);
  saved.workspace!.contributions!.push({ id: 'salary-event', recordId: 'salary', eventId: 'receipt', date: '2026-09-13',
    amountPaise: 1000000, included: true, reason: 'reported', references: [] });
  const result = saved.workspace!.results!.find(item => item.id === 'firstGap')!;
  result.excludedIds = ['salary-event']; result.excludedReasons = { 'salary-event': 'afterResultPoint' };
  render(<ResultDetails result={result} snapshot={saved} />);
  await userEvent.click(screen.getByRole('button', { name: 'Why this result?' }));
  const excluded = screen.getByRole('list', { name: 'Excluded figures' });
  expect(excluded).toHaveTextContent('Salary'); expect(excluded).toHaveTextContent('cannot cover that earlier cash gap');
  expect(excluded).not.toHaveTextContent('Included in this result'); expect(excluded).not.toHaveTextContent('afterResultPoint');
  expect(screen.getByRole('dialog')).toHaveTextContent('On the same day, payments come before income.');
});

it.each(['pastReceipt', 'outsideHorizon'] as const)('keeps the server %s exclusion in result evidence for a reliable exact receipt', async reason => {
  const saved = planningSnapshot();
  saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 1000000, status: 'exact' },
    schedule: { date: '2026-09-01', certainty: 'exact', recurrence: 'once' }, reliability: 'reliable', autoDebit: false });
  projectWorkspace(saved);
  saved.workspace!.contributions!.push({ id: 'salary-record', recordId: 'salary', eventId: null, date: '2026-09-01',
    amountPaise: 1000000, included: false, reason, references: [] });
  const result = saved.workspace!.results!.find(item => item.id === 'closing')!;
  result.excludedIds = ['salary-record'];
  render(<ResultDetails snapshot={saved} result={result} />);
  await userEvent.click(screen.getByRole('button', { name: 'Why this result?' }));
  const evidence = screen.getByRole('list', { name: 'Excluded figures' });
  expect(evidence).toHaveTextContent('Salary');
  expect(evidence).toHaveTextContent(reason === 'pastReceipt' ? 'not added again' : 'Outside these 30 days');
  expect(evidence).not.toHaveTextContent('Receipt is uncertain');
});

it('uses only active result evidence rather than duplicating conditional and proposed receipts', async () => {
  const saved = planningSnapshot();
  saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 1000000, status: 'exact' },
    schedule: { date: '2026-09-13', certainty: 'exact', recurrence: 'once' }, reliability: 'reliable', autoDebit: false });
  projectWorkspace(saved);
  const receipt = { recordId: 'salary', eventId: 'receipt', date: '2026-09-13', amountPaise: 1000000, included: true, reason: 'reported', references: [] };
  saved.workspace!.contributions!.push({ id: 'event:receipt', ...receipt }, { id: 'income:reportedDate:event:receipt', ...receipt },
    { id: 'proposal:event:receipt', ...receipt, date: '2026-09-14' });
  const gap = saved.workspace!.results!.find(result => result.id === 'firstGap')!;
  gap.excludedIds = ['event:receipt']; gap.excludedReasons = { 'event:receipt': 'afterResultPoint' };
  render(<ResultDetails snapshot={saved} result={gap} />);
  await userEvent.click(screen.getByRole('button', { name: 'Why this result?' }));
  const evidence = screen.getByRole('list', { name: 'Excluded figures' });
  expect(within(evidence).getAllByText('Salary')).toHaveLength(1);
  expect(evidence).toHaveTextContent('cannot cover that earlier cash gap');
  expect(evidence).not.toHaveTextContent('14 Sept');
});

it.each(['reliable', 'uncertain'] as const)('shows excluded receipts as compact status instead of a report (reliability: %s)', reliability => {
  const saved = planningSnapshot();
  saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 1000000, status: 'estimate' },
    schedule: { date: '2026-09-14', certainty: 'exact', recurrence: 'once' }, reliability, autoDebit: false });
  saved.plan.events.push({ ...saved.plan.events[0], id: 'salary:2026-09-14', recordId: 'salary', label: 'Salary', kind: 'income',
    date: '2026-09-14', originalDueDate: '2026-09-14', amountPaise: 1000000, amountStatus: 'estimate', included: false });
  render(<FinancialContext {...controls} snapshot={projectWorkspace(saved)} />);
  const row = screen.getByRole('listitem', { name: 'Salary' });
  expect(within(row).getByRole('button', { name: 'Edit Salary amount' })).toHaveTextContent('₹10,000Est.');
  expect(row).toHaveTextContent(reliability === 'reliable' ? 'Not counted on' : 'Not counted on · Receipt unconfirmed');
  expect(screen.getAllByRole('article').map(card => card.getAttribute('aria-label'))).toEqual(['Cash & timing', 'Next & commitments']);
  expect(screen.queryByText(/Why this result|Information that changes|Payments and later receipts/)).not.toBeInTheDocument();
});

it('shows one hidden noncoverage uncertainty instead of question lists or action prompts', () => {
  const saved = planningSnapshot();
  saved.facts.records = Array.from({ length: 6 }, (_, index) => ({ ...saved.facts.records[0], id: `bill${index}`, label: `Bill ${index + 1}`,
    amount: { amountPaise: null, status: 'unknown' as const } }));
  saved.plan.events = [];
  saved.plan.decisionAssessment!.uncertainties = [
    { ...saved.plan.decisionAssessment!.uncertainties![0], id: 'coverage', kind: 'coverage', field: 'coverage', recordIds: [], priority: -1 },
    ...saved.facts.records.map((record, priority) => ({ ...saved.plan.decisionAssessment!.uncertainties![0], id: `unknown:${record.id}`,
      kind: 'missing' as const, field: 'amount' as const, recordIds: [record.id], priority, question: `How much is ${record.label}?` })),
  ];
  projectWorkspace(saved);
  saved.workspace!.questions = []; saved.workspace!.actions = [];
  render(<FinancialContext {...controls} snapshot={saved} />);
  const uncertainty = screen.getByRole('article', { name: 'Important uncertainty' });
  expect(uncertainty).toHaveTextContent('Bill 5 · Amount');
  expect(within(uncertainty).getByRole('button', { name: 'Edit Bill 5 amount' })).toHaveTextContent('Unknown');
  expect(within(screen.getByRole('list', { name: 'Next commitments' })).getAllByRole('listitem')).toHaveLength(4);
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(screen.queryByText(/How much|Contact the provider|Unreported commitments/)).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Other open checks' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /I cannot/ })).not.toBeInTheDocument();
});

it('retains competing reports and existing rows when commitments expand', async () => {
  const saved = planningSnapshot();
  saved.facts.records = Array.from({ length: 5 }, (_, index) => ({ ...saved.facts.records[0], id: `bill${index}`, label: `Bill ${index + 1}` }));
  saved.facts = { ...saved.facts, conflicts: saved.facts.records.map(record => ({ id: `conflict-${record.id}`, recordId: record.id, field: 'amount',
    values: [{ id: 'a', amountPaise: 10000, status: 'exact' }, { id: 'b', amountPaise: 20000, status: 'estimate' }] })) };
  saved.plan.events = []; projectWorkspace(saved); saved.workspace!.questions = [];
  render(<FinancialContext {...controls} snapshot={saved} />);
  const first = screen.getByRole('listitem', { name: 'Bill 1' });
  expect(screen.queryByRole('listitem', { name: 'Bill 5' })).not.toBeInTheDocument();
  const expand = screen.getByRole('button', { name: 'Show 1 more' }); expand.focus();
  await userEvent.keyboard('{Enter}');
  expect(expand).toHaveAttribute('aria-expanded', 'true'); expect(expand).toHaveFocus();
  expect(screen.getByRole('listitem', { name: 'Bill 1' })).toBe(first);
  for (const record of saved.facts.records) {
    const row = screen.getByRole('listitem', { name: record.label });
    expect(row).toHaveTextContent('₹100 · Reported / ₹200 · Est.');
    expect(within(row).getByRole('button', { name: `Resolve ${record.label} amount` })).toHaveAttribute('aria-disabled', 'false');
  }
  await userEvent.click(screen.getByRole('button', { name: 'Show fewer commitments' }));
  expect(screen.queryByRole('listitem', { name: 'Bill 5' })).not.toBeInTheDocument();
  expect(first).toHaveTextContent('₹100 · Reported / ₹200 · Est.');
});

it.each([false, true])('animates only changed content with finite duration, retaining focus (reduced motion: %s)', reduced => {
  const saved = planningSnapshot();
  const animate = vi.fn(function (this: HTMLElement) { return { cancel: vi.fn(), card: this }; });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })));
  try {
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    const rent = screen.getByRole('listitem', { name: 'Rent' });
    const edit = within(rent).getByRole('button', { name: 'Edit Rent amount' }); edit.focus();
    expect(animate).not.toHaveBeenCalled();
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, sequence: 1 }} />);
    expect(animate).not.toHaveBeenCalled();
    const corrected = structuredClone(saved); corrected.facts.opening.amountPaise = 600000;
    corrected.workspace!.results!.find(result => result.id === 'opening')!.amountPaise = 600000;
    corrected.workspace!.change = { id: 'opening-change', revision: 1, items: [{ id: 'opening', state: 'updated',
      fields: [], cardIds: ['cash', 'timeline'], recordIds: [], resultIds: ['opening'] }] };
    rerender(<FinancialContext {...controls} snapshot={corrected} />);
    expect(edit).toHaveFocus(); expect(animate.mock.contexts).not.toContain(rent);
    if (reduced) expect(animate).not.toHaveBeenCalled();
    else {
      expect(animate).toHaveBeenCalledExactlyOnceWith(expect.any(Array), { duration: 900, easing: 'ease-out' });
      expect(animate.mock.contexts[0]).toBe(within(screen.getByRole('button', { name: 'Edit Cash at plan start' })).getByText('₹6,000'));
    }
  } finally { Reflect.deleteProperty(HTMLElement.prototype, 'animate'); }
});