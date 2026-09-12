// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { FinancialContext } from '../src/FinancialContext';
import { planningSnapshot } from './fixtures';

it('keeps an actionable unknown visible until the corrected canonical state resolves it', () => {
  const saved = planningSnapshot();
  saved.facts.records[0].controllability = 'unknown';
  saved.workspace!.issues = [{ id: 'rent:controllability', kind: 'missing', field: 'controllability', recordIds: ['rent'],
    question: 'Can Rent be reduced?', reason: 'A reduction needs confirmed control.', priority: 0,
    beforeDate: '2026-09-13', changes: ['what', 'affordability'], blocks: ['immediateDecision', 'fullPlan'] }];
  saved.workspace!.questions = [{ id: 'rent:controllability', actionId: 'clarify:rent:controllability', fields: ['controllability'], recordIds: ['rent'], why: '', resolves: [], changes: [], blocks: ['immediateDecision'], priority: 0, beforeDate: '2026-09-13' }];
  saved.workspace!.cards = [
    { id: 'timeline', template: 'timeline', title: 'Next & commitments', section: 'timeline', state: 'known', recordIds: ['rent'], eventIds: ['rent:2026-09-13'] },
    { id: 'questions', template: 'questions', title: 'Important uncertainty', section: 'issues', state: 'unresolved', issueIds: ['rent:controllability'], recordIds: ['rent'] },
  ];
  const onCommand = vi.fn();
  const props = { snapshot: saved, onCommand, locked: false, stale: false, proposalActive: true };
  const { rerender } = render(<FinancialContext {...props} />);
  const issue = screen.getByRole('article', { name: 'Important uncertainty' });
  expect(issue).toHaveTextContent('Rent');
  expect(issue).toHaveTextContent('Unknown');
  expect(issue).toHaveTextContent('Before 13 Sept');
  expect(issue).toHaveTextContent('Confirm whether this spending can be reduced or skipped.');
  expect(within(screen.getByRole('list', { name: 'Next commitments' })).getAllByRole('listitem')).toHaveLength(1);
  const corrected = structuredClone(saved); corrected.revision++; corrected.sequence++;
  corrected.facts.records[0].controllability = 'controllable';
  corrected.workspace!.issues = []; corrected.workspace!.cards = corrected.workspace!.cards!.filter(card => card.id !== 'questions');
  rerender(<FinancialContext {...props} snapshot={corrected} />);
  expect(screen.queryByRole('article', { name: 'Important uncertainty' })).not.toBeInTheDocument();
  expect(onCommand).not.toHaveBeenCalled();
});

it('expanding records deduplicates an ordinary date but not a hidden decision field', async () => {
  const saved = planningSnapshot();
  saved.facts.records = Array.from({ length: 5 }, (_, index) => ({ ...saved.facts.records[0], id: `item${index}`, label: `Item ${index}` }));
  saved.workspace!.cards = [
    { id: 'timeline', template: 'timeline', title: 'Next & commitments', section: 'timeline', state: 'known', recordIds: saved.facts.records.map(item => item.id), eventIds: [] },
    { id: 'questions', template: 'questions', title: 'Important uncertainty', section: 'issues', state: 'unresolved', issueIds: ['control'], recordIds: ['item4'] },
  ];
  saved.workspace!.issues = [{ id: 'control', kind: 'missing', field: 'controllability', recordIds: ['item4'], question: '', reason: '', priority: 0, changes: [], blocks: ['immediateDecision'] }];
  saved.workspace!.questions = [{ id: 'control', actionId: 'clarify:control', fields: ['controllability'], recordIds: ['item4'], why: '', resolves: [], changes: [], blocks: ['immediateDecision'], priority: 0, beforeDate: null }];
  const props = { snapshot: saved, onCommand: vi.fn(), locked: false, stale: false, proposalActive: true };
  const { rerender } = render(<FinancialContext {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
  expect(screen.getByRole('article', { name: 'Important uncertainty' })).toBeVisible();
  const dated = structuredClone(saved); dated.workspace!.issues![0].field = 'schedule.date';
  rerender(<FinancialContext {...props} snapshot={dated} />);
  expect(screen.queryByRole('article', { name: 'Important uncertainty' })).not.toBeInTheDocument();
});