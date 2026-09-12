// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Command, Snapshot } from '../src/api';
import { FinancialContext } from '../src/FinancialContext';
import { ResultDetails } from '../src/WorkspaceDetails';
import { planningSnapshot } from './fixtures';
import { projectWorkspace } from './workspace';

const controls = { locked: false, stale: false, mode: 'live' as const, proposalActive: true, onCommand: vi.fn<(operation: Command['operation']) => Promise<Snapshot | undefined>>().mockResolvedValue(planningSnapshot()) };

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

it.each(['pastReceipt', 'outsideHorizon'] as const)('shows the server %s exclusion even for a reliable exact receipt', reason => {
  const saved = planningSnapshot();
  saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 1000000, status: 'exact' },
    schedule: { date: '2026-09-01', certainty: 'exact', recurrence: 'once' }, reliability: 'reliable', autoDebit: false });
  projectWorkspace(saved);
  saved.workspace!.contributions!.push({ id: 'salary-record', recordId: 'salary', eventId: null, date: '2026-09-01',
    amountPaise: 1000000, included: false, reason, references: [] });
  render(<FinancialContext {...controls} snapshot={saved} />);
  const salary = screen.getByRole('listitem', { name: 'Salary' });
  expect(salary).toHaveTextContent(reason === 'pastReceipt' ? 'not added again' : 'Outside these 30 days');
  expect(salary).not.toHaveTextContent('Receipt is uncertain');
});

it('uses only the active gap evidence rather than duplicating conditional and proposed receipts', async () => {
  const saved = planningSnapshot();
  saved.facts.records.push({ id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 1000000, status: 'exact' },
    schedule: { date: '2026-09-13', certainty: 'exact', recurrence: 'once' }, reliability: 'reliable', autoDebit: false });
  projectWorkspace(saved);
  const receipt = { recordId: 'salary', eventId: 'receipt', date: '2026-09-13', amountPaise: 1000000, included: true, reason: 'reported', references: [] };
  saved.workspace!.contributions!.push({ id: 'event:receipt', ...receipt }, { id: 'income:reportedDate:event:receipt', ...receipt },
    { id: 'proposal:event:receipt', ...receipt, date: '2026-09-14' });
  const gap = saved.workspace!.results!.find(result => result.id === 'firstGap')!;
  gap.excludedIds = ['event:receipt']; gap.excludedReasons = { 'event:receipt': 'afterResultPoint' };
  render(<FinancialContext {...controls} snapshot={saved} />);
  await userEvent.click(screen.getByRole('button', { name: 'Payments and later receipts' }));
  const evidence = screen.getByRole('list', { name: 'Cash gap timing' });
  expect(within(evidence).getAllByText('Salary')).toHaveLength(1);
  expect(evidence).toHaveTextContent('cannot cover that earlier cash gap');
  expect(evidence).not.toHaveTextContent('14 Sept');
});

it.each(['contactPayee', 'followUp', 'seekSupport', 'resolveGroup'] as const)('can report inability to take a bounded %s action without inferring payee refusal', async kind => {
  const saved = planningSnapshot();
  saved.workspace!.questions = [];
  saved.workspace!.actions = [{ id: 'bounded-action', kind, recordIds: ['rent'], question: 'Check the next step before the deadline.',
    beforeDate: null, consequenceIds: [], ifDeclinedConsequenceIds: [] }];
  const onCommand = vi.fn();
  render(<FinancialContext {...controls} onCommand={onCommand} snapshot={saved} />);
  await userEvent.click(screen.getByRole('button', { name: 'I cannot take this step now' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'respondToAction', actionId: 'bounded-action', response: 'unavailable' });
  expect(saved.facts.providerResponses).toEqual([]);
  expect(screen.getByRole('article', { name: 'Cash gap and timing risk' })).toHaveTextContent('₹7,000.00');
});

it('keeps every open issue visible when no more questions are askable', () => {
  const saved = planningSnapshot();
  saved.workspace!.questions = []; saved.workspace!.actions = [];
  saved.workspace!.cards = saved.workspace!.cards!.filter(card => card.template !== 'questions');
  saved.workspace!.issues = Array.from({ length: 6 }, (_, index) => ({ ...saved.workspace!.issues![0], id: `issue${index}`,
    question: `Check reported item ${index + 1}.`, reason: 'This detail is still unresolved.' }));
  render(<FinancialContext {...controls} snapshot={saved} />);
  const issues = screen.getByRole('region', { name: 'Other open checks' });
  expect(within(issues).getAllByRole('listitem')).toHaveLength(6);
  expect(issues).toHaveTextContent('Check reported item 6.');
  expect(within(issues).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /I cannot/ })).not.toBeInTheDocument();
});

it('keeps all competing reports visible beyond the askable question limit', () => {
  const saved = planningSnapshot();
  saved.facts.records = Array.from({ length: 5 }, (_, index) => ({ ...saved.facts.records[0], id: `bill${index}`, label: `Bill ${index + 1}` }));
  saved.facts = { ...saved.facts, conflicts: saved.facts.records.map(record => ({ id: `conflict-${record.id}`, recordId: record.id, field: 'amount',
    values: [{ id: 'a', amountPaise: 10000, status: 'exact' }, { id: 'b', amountPaise: 20000, status: 'estimate' }] })) };
  saved.plan.events = []; projectWorkspace(saved); saved.workspace!.questions = [];
  render(<FinancialContext {...controls} snapshot={saved} />);
  for (const record of saved.facts.records) {
    const row = screen.getByRole('listitem', { name: record.label });
    expect(row).toHaveTextContent('Report 1: ₹100.00 · Reported'); expect(row).toHaveTextContent('Report 2: ₹200.00 · Estimated');
    expect(within(row).getByRole('button', { name: `Resolve ${record.label} · Amount` })).toBeEnabled();
  }
});

it.each([false, true])('animates only changed content with finite duration, retaining focus (reduced motion: %s)', reduced => {
  const saved = planningSnapshot();
  const animate = vi.fn(function (this: HTMLElement) { return { cancel: vi.fn(), card: this }; });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })));
  try {
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    const rent = screen.getByRole('article', { name: 'Essential spending' });
    const correct = within(rent).getByRole('button', { name: 'Correct Rent' }); correct.focus();
    animate.mockClear();
    const corrected = structuredClone(saved); corrected.facts.opening.amountPaise = 600000;
    corrected.workspace!.results!.find(result => result.id === 'opening')!.amountPaise = 600000;
    corrected.workspace!.change = { id: 'opening-change', revision: 1, items: [{ id: 'opening', state: 'updated',
      fields: [], cardIds: ['cash', 'essential'], recordIds: [], resultIds: ['opening'] }] };
    rerender(<FinancialContext {...controls} snapshot={corrected} />);
    expect(correct).toHaveFocus(); expect(animate.mock.contexts).not.toContain(rent);
    if (reduced) expect(animate).not.toHaveBeenCalled();
    else expect(animate).toHaveBeenCalledWith(expect.any(Array), { duration: 650, easing: 'ease-out', iterations: 1 });
  } finally { Reflect.deleteProperty(HTMLElement.prototype, 'animate'); }
});