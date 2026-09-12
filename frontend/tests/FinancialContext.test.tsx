// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Snapshot } from '../src/api';
import { FinancialContext } from '../src/FinancialContext';
import { planningSnapshot, scenario, snapshot } from './fixtures';
import { projectWorkspace } from './workspace';

const controls = { locked: false, proposalActive: true, onCommand: vi.fn<(operation: Command['operation']) => void>(), stale: false, mode: 'live' as const };
beforeEach(() => controls.onCommand.mockClear());
const salary = (): Snapshot['facts']['records'][number] => ({ id: 'salary', label: 'Salary', kind: 'income', amount: { status: 'exact', amountPaise: 2500000 }, schedule: { date: '2026-09-25', recurrence: 'monthly', certainty: 'exact' }, reliability: 'reliable', autoDebit: false });
const picture = () => { const saved = planningSnapshot(); saved.facts.records.push(salary()); return projectWorkspace(saved); };

function conflictPicture(field: 'amount' | 'schedule.date' = 'amount') {
  const saved = picture();
  saved.facts = { ...saved.facts, conflicts: [{ id: 'conflict-internal', recordId: 'salary', field, values: field === 'amount'
    ? [{ id: 'first-internal', amountPaise: 2500000, status: 'exact' }, { id: 'second-internal', amountPaise: 3000000, status: 'estimate' }]
    : [{ id: 'first-internal', date: '2026-09-25', status: 'exact' }, { id: 'second-internal', date: '2026-09-28', status: 'estimate' }] }] };
  if (field === 'amount') saved.facts.records[1].amount = { status: 'unknown', amountPaise: null };
  else saved.facts.records[1].schedule = { date: null, certainty: 'unknown', recurrence: 'monthly' };
  return projectWorkspace(saved);
}

describe('server financial workspace', () => {
  it.each([null, snapshot()])('keeps blank sessions free of cards, metrics and generic questions', saved => {
    const { container } = render(<FinancialContext {...controls} snapshot={saved} />);
    expect(screen.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/₹|What cash was available|Plan focus/);
  });
  it('uses only server card membership, progressively adding and removing grouped facts', () => {
    const saved = picture(); saved.workspace!.cards = [];
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    const learned = projectWorkspace(structuredClone(saved)); rerender(<FinancialContext {...controls} snapshot={learned} />);
    expect(screen.getByRole('article', { name: 'Expected income' })).toHaveTextContent('Salary');
    expect(screen.getByRole('article', { name: 'Qualified outlook' })).toHaveTextContent('still taking shape');
    learned.workspace!.cards = learned.workspace!.cards!.filter(card => card.template !== 'income');
    rerender(<FinancialContext {...controls} snapshot={{ ...learned }} />);
    expect(screen.queryByRole('article', { name: 'Expected income' })).not.toBeInTheDocument();
  });
  it('shows all estimated reliable income exclusions and never substitutes zero for unknown', () => {
    const saved = picture(); saved.facts.records[1].amount.status = 'estimate'; saved.facts.records[1].schedule.certainty = 'estimate';
    saved.facts.records[0].amount = { status: 'unknown', amountPaise: null }; saved.facts.records[0].schedule.date = null;
    render(<FinancialContext {...controls} snapshot={projectWorkspace(saved)} />);
    const income = screen.getByRole('listitem', { name: 'Salary' }); expect(income).toHaveTextContent('Reliable receipt');
    expect(income).toHaveTextContent('Excluded from balances: Amount is estimated; Date is estimated or unconfirmed');
    const rent = screen.getByRole('listitem', { name: 'Rent' }); expect(rent).toHaveTextContent('Unknown'); expect(rent).toHaveTextContent('Date unknown'); expect(rent).not.toHaveTextContent('₹0.00');
    expect(screen.getByRole('article', { name: 'Available opening cash' })).not.toHaveTextContent('Reserve floor');
  });
  it.each(['amount', 'schedule.date'] as const)('resolves %s only with a supplied alternative and explicit confirmation', async field => {
    const saved = conflictPicture(field); const { rerender, container } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('button', { name: /^Resolve Salary/ }));
    expect(screen.getByRole('button', { name: 'Confirm selected report' })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: /^Report 2/ })); expect(controls.onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm selected report' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: saved.revision, resolutions: [{ conflictId: 'conflict-internal', value: { id: 'second-internal', status: 'estimate', ...(field === 'amount' ? { amount: '30000.00' } : { date: '2026-09-28' }) } }] } });
    expect(screen.getByRole('button', { name: /^Resolve Salary/ })).toBeVisible();
    const resolved = structuredClone(saved); resolved.facts = { ...resolved.facts, conflicts: [] }; resolved.revision++;
    rerender(<FinancialContext {...controls} snapshot={projectWorkspace(resolved)} />);
    expect(screen.queryByRole('button', { name: /^Resolve Salary/ })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/conflict-internal|second-internal|workspace.results|conditionalReceipt/);
  });
  it('retains focus, scroll and server correction deltas across coalesced snapshots', async () => {
    const saved = picture(); const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    const row = screen.getByRole('listitem', { name: 'Salary' }); const button = screen.getByRole('button', { name: 'Correct Salary' }); button.focus();
    const scroll = screen.getByRole('region', { name: 'Financial picture details' }); scroll.scrollTop = 200;
    const corrected = structuredClone(saved); corrected.sequence = 4; corrected.revision = 2; corrected.facts.records[1].amount.amountPaise = 3000000;
    corrected.workspace!.change = { id: 'change-one', revision: 2, items: [
      { id: 'salary', state: 'updated', fields: [{ reference: 'facts.records.salary.amount.amountPaise', before: 2500000, after: 3000000 }], recordIds: ['salary'], cardIds: ['income', 'timeline'], resultIds: ['closing'] },
      { id: 'closing', state: 'updated', fields: [{ reference: 'workspace.results.closing.amountPaise', before: 1000000, after: 1500000 }], recordIds: [], cardIds: ['timeline'], resultIds: ['closing'] },
    ] };
    corrected.workspace!.results!.find(result => result.id === 'closing')!.amountPaise = 1500000;
    rerender(<FinancialContext {...controls} snapshot={corrected} />);
    expect(screen.getByRole('listitem', { name: 'Salary' })).toBe(row); expect(button).toHaveFocus(); expect(scroll.scrollTop).toBe(200);
    expect(screen.getByRole('article', { name: 'Expected income' })).toHaveAttribute('data-changed', 'true');
    rerender(<FinancialContext {...controls} snapshot={{ ...corrected, sequence: 5, workspace: { ...corrected.workspace, change: null } }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Recent changes' }));
    const dialog = screen.getByRole('dialog', { name: 'Recent changes' }); expect(dialog).toHaveTextContent('Projected closing cash: ₹10,000.00 → ₹15,000.00'); expect(dialog).toHaveTextContent('earlier cash gap amount and date are unchanged');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close recent changes' })); expect(screen.getByRole('button', { name: 'Recent changes' })).toHaveFocus();
  });
  it('sends targeted rupee corrections and protects drafts across revision changes', async () => {
    const saved = picture(); const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Correct Salary' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Correct Salary' }));
    await userEvent.clear(dialog.getByLabelText('Amount (₹)')); await userEvent.type(dialog.getByLabelText('Amount (₹)'), '31000.25');
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: 'salary', delete: false, distinct: false, amount: { status: 'exact', amount: '31000.25' } }] } });
    await userEvent.click(screen.getByRole('button', { name: 'Correct Salary' })); rerender(<FinancialContext {...controls} snapshot={{ ...saved, revision: 1 }} />);
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('Saved figures changed');
  });
  it.each(['locked', 'stale'] as const)('blocks conflict confirmation and refusal while %s', async reason => {
    const saved = conflictPicture(); saved.preview = scenario(); projectWorkspace(saved); const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('button', { name: /^Resolve Salary/ })); await userEvent.click(screen.getByRole('radio', { name: /^Report 2/ }));
    rerender(<FinancialContext {...controls} snapshot={saved} {...{ [reason]: true }} />);
    expect(screen.getByRole('button', { name: 'Confirm selected report' })).toBeDisabled(); await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Correct Salary' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Reject preview' })).toBeDisabled(); expect(controls.onCommand).not.toHaveBeenCalled();
  });
  it.each(['opening', 'closing', 'firstGap'] as const)('explains %s using server contributions and assumptions', async id => {
    const saved = picture(); saved.plan.events = [{ id: 'rent-event', recordId: 'rent', label: 'Rent', kind: 'essential', date: '2026-09-13', originalDueDate: '2026-09-13', amountPaise: 1200000, amountBasis: 'reported', included: true, overdue: false, autoDebit: false, balancePaise: -700000 }]; projectWorkspace(saved);
    const result = saved.workspace!.results!.find(result => result.id === id)!; result.amountPaise = 123456;
    saved.workspace!.contributions!.push({ id: 'excluded', recordId: 'salary', eventId: null, date: null, amountPaise: 2500000, included: false, reason: 'unknownDate', references: [] }); result.excludedIds.push('excluded');
    render(<FinancialContext {...controls} snapshot={saved} />);
    const card = screen.getByRole('article', { name: id === 'opening' ? 'Available opening cash' : id === 'closing' ? 'Dated cash requirements' : 'Cash gap and timing risk' });
    await userEvent.click(within(card).getAllByRole('button', { name: 'Why this result?' })[0]);
    const dialog = screen.getByRole('dialog'); expect(dialog).toHaveTextContent('₹1,234.56'); expect(dialog).toHaveTextContent('Opening cash'); expect(dialog).toHaveTextContent('Date is unknown; not in dated balances'); expect(dialog).toHaveTextContent('Unreported amounts are unknown, not zero'); expect(dialog).not.toHaveTextContent(/rent-event|unknownDate/);
  });
  it.each(['rejectPreview', 'discardPreview'] as const)('distinguishes %s and waits for server confirmation', async type => {
    const saved = picture(); saved.preview = scenario(); projectWorkspace(saved); const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('button', { name: type === 'rejectPreview' ? 'Reject preview' : 'Close preview' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type, previewId: saved.preview.id }); expect(screen.getByRole('region', { name: 'Spending change preview' })).toBeVisible();
    const completed = structuredClone(saved); completed.preview = null; completed.workspace!.change = { id: 'decision', revision: 0, items: [{ id: 'preview', state: type === 'rejectPreview' ? 'rejected' : 'discarded', fields: [], cardIds: [], resultIds: [], recordIds: [] }] };
    rerender(<FinancialContext {...controls} snapshot={projectWorkspace(completed)} />);
    expect(screen.queryByRole('region', { name: 'Spending change preview' })).not.toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent(type === 'rejectPreview' ? 'refusal saved' : 'not a refusal');
  });
  it.each(['sequence', 'revision', 'stale', 'locked', 'proposalActive'] as const)('resets exact proposal consent after %s changes', async field => {
    const saved = picture(); saved.preview = scenario(); projectWorkspace(saved); const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('checkbox')); expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    const updated = structuredClone(saved); if (field === 'sequence' || field === 'revision') updated[field]++;
    rerender(<FinancialContext {...controls} snapshot={updated} {...(field === 'stale' || field === 'locked' ? { [field]: true } : field === 'proposalActive' ? { proposalActive: false } : {})} />); rerender(<FinancialContext {...controls} snapshot={saved} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled(); expect(controls.onCommand).not.toHaveBeenCalled();
  });
  it('saves exact consent and keeps accepted and invalidated assumptions separate from facts', async () => {
    const saved = picture(); saved.preview = scenario(); projectWorkspace(saved); const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('checkbox')); await userEvent.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'acceptPreview', previewId: saved.preview.id, confirmed: true, consentScope: 'unconditional' });
    const accepted = structuredClone(saved); accepted.accepted = accepted.preview; accepted.preview = null; accepted.accepted!.adjustments[0].acceptedRevision = 1;
    rerender(<FinancialContext {...controls} snapshot={projectWorkspace(accepted)} />); expect(screen.getByRole('article', { name: /Accepted planning assumptions/ })).toHaveTextContent('Accepted does not mean paid');
    accepted.invalidatedAssumptions = [{ eventId: 'optional:2026-09-27', reason: 'The reported amount changed; confirm a fresh proposal.' }];
    rerender(<FinancialContext {...controls} snapshot={projectWorkspace({ ...accepted })} />); expect(screen.getByRole('article', { name: 'Assumptions need confirmation again' })).toHaveTextContent('The reported amount changed');
  });
  it('bounds grouped records with keyboard-operable pagination', async () => {
    const saved = picture(); saved.facts.records = Array.from({ length: 25 }, (_, index) => ({ ...salary(), id: `income${index}`, label: `Income ${index}` })); render(<FinancialContext {...controls} snapshot={projectWorkspace(saved)} />);
    const group = screen.getByRole('article', { name: 'Expected income' }); expect(within(group).getAllByRole('listitem')).toHaveLength(20);
    within(group).getByRole('button', { name: 'Next' }).focus(); await userEvent.keyboard('{Enter}'); expect(within(group).getByRole('listitem', { name: 'Income 24' })).toBeVisible(); expect(within(group).getAllByRole('listitem')).toHaveLength(5);
  });
});