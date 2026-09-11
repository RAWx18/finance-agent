// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FactsInput } from '../src/api';
import { Editor } from '../src/Editor';
import { PagedList } from '../src/PagedList';
import { Projection } from '../src/Projection';
import { draftFacts } from '../src/money';
import { settings, snapshot } from './fixtures';

function Form({ save, initial = draftFacts(snapshot()) }: { save: (facts: FactsInput) => void; initial?: FactsInput }) {
  const [facts, setFacts] = useState(initial);
  return <Editor facts={facts} settings={settings} locked={false} conflict={false} pending={false}
    onChange={setFacts} onSave={() => save(facts)} onCancel={() => undefined}
    onUseSaved={() => undefined} onReconcile={() => undefined} />;
}

describe('figure editing', () => {
  it('keeps coverage and reported context on corrections and only resets membership changes', async () => {
    const initial = draftFacts(snapshot());
    initial.coverage.optional = 'reviewed';
    initial.records = [{ id: 'purchase', label: 'Purchase', kind: 'optional', controllability: 'unknown', autoDebit: false,
      amount: { status: 'exact', amount: '2000' }, schedule: { date: '2026-09-20', recurrence: 'once' } }];
    initial.decision = { intent: 'specificDecision', concern: 'Can this wait?', focusRecordIds: ['purchase'], responsePreference: 'brief' };
    const save = vi.fn();
    const user = userEvent.setup();
    render(<Form save={save} initial={initial} />);
    await user.click(screen.getByRole('button', { name: /^Purchase\s*Optional spending$/ }));
    let dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    expect(dialog.getByLabelText('Can this spending change?')).toHaveValue('unknown');
    await user.selectOptions(dialog.getByLabelText('Can this spending change?'), 'controllable');
    await user.clear(dialog.getByLabelText('Amount (₹)'));
    await user.type(dialog.getByLabelText('Amount (₹)'), '1500');
    await user.clear(dialog.getByLabelText('Next unpaid or future date'));
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Optional spending', { selector: 'select' })).toHaveValue('reviewed');
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ decision: initial.decision,
      records: [expect.objectContaining({ controllability: 'controllable', amount: { status: 'exact', amount: '1500' }, schedule: { date: null, recurrence: 'once' } })] }));
    await user.click(screen.getByRole('button', { name: /^Purchase\s*Optional spending$/ }));
    dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    expect(dialog.getByLabelText('Amount (₹)')).toHaveValue('1500');
    await user.selectOptions(dialog.getByLabelText('Category'), 'income');
    expect(dialog.getByLabelText('Income certainty')).toHaveValue('unknown');
    expect(dialog.queryByLabelText('Can this spending change?')).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    expect(screen.getByLabelText('Optional spending', { selector: 'select' })).toHaveValue('reported');
    expect(screen.getByLabelText('Income', { selector: 'select' })).toHaveValue('reported');
    await user.click(screen.getByRole('button', { name: /^Purchase\s*Income$/ }));
    dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    await user.selectOptions(dialog.getByLabelText('Category'), 'debt');
    expect(dialog.getByLabelText('Debt type')).toHaveValue('unknown');
    expect(dialog.queryByLabelText('Can this spending change?')).not.toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText('Debt type'), 'card');
    expect(dialog.getByLabelText('Can this spending change?')).toHaveValue('unknown');
  });
  it('validates required debt minimum and target, keeps outstanding informational, then explicitly confirms none after removal', async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<Form save={save} />);
    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    let dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    await waitFor(() => expect(dialog.getByLabelText('Item name')).toHaveFocus());
    await user.selectOptions(dialog.getByLabelText('Category'), 'debt');
    await user.type(dialog.getByLabelText('Item name'), 'Synthetic card');
    await user.selectOptions(dialog.getByLabelText('Debt type'), 'card');
    const minimum = dialog.getByRole('group', { name: 'Required / minimum payment' });
    await user.selectOptions(within(minimum).getByLabelText('How certain?'), 'exact');
    await user.type(within(minimum).getByRole('textbox'), '500');
    await user.type(dialog.getByLabelText('Next unpaid or future date'), '2026-09-20');
    await user.selectOptions(dialog.getByLabelText('Repeats'), 'monthly');
    await user.click(dialog.getByLabelText('Automatic debit'));
    expect(dialog.getByRole('group', { name: 'Optional debt details' })).toBeVisible();
    await user.click(dialog.getByLabelText('Include a selected target'));
    let target = dialog.getByRole('group', { name: 'Selected target' });
    await user.selectOptions(within(target).getByLabelText('How certain?'), 'estimate');
    await user.type(within(target).getByRole('textbox'), '400');
    await user.click(dialog.getByLabelText('Include outstanding balance'));
    expect(within(dialog.getByRole('group', { name: 'Outstanding balance' })).getByText('Not entered. This is not treated as zero.')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least the required payment');
    expect(save).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: /Synthetic card:.*at least the required payment/ }));
    dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    target = dialog.getByRole('group', { name: 'Selected target' });
    await waitFor(() => expect(within(target).getByRole('textbox')).toHaveFocus());
    await user.clear(within(target).getByRole('textbox'));
    await user.type(within(target).getByRole('textbox'), '1000');
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await user.selectOptions(screen.getByLabelText('Debt payments', { selector: 'select' }), 'reviewed');
    expect(within(screen.getByLabelText('Debt payments', { selector: 'select' })).getByRole('option', { name: 'Confirmed none' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ records: [expect.objectContaining({
      kind: 'debt', debtType: 'card', autoDebit: true, amount: { status: 'exact', amount: '500' },
      target: { status: 'estimate', amount: '1000' }, outstanding: { status: 'unknown', amount: null },
      schedule: { date: '2026-09-20', recurrence: 'monthly' },
    })] }));
    await user.click(screen.getByRole('button', { name: 'Remove Synthetic card' }));
    expect(screen.getByLabelText('Debt payments', { selector: 'select' })).toHaveValue('reported');
    await user.selectOptions(screen.getByLabelText('Debt payments', { selector: 'select' }), 'none');
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ records: [], coverage: expect.objectContaining({ debt: 'none' }) }));
  });
  it('keeps uncertain income and unknown dates explicit and removes debt-only details when changing category', async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<Form save={save} />);
    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    await user.selectOptions(dialog.getByLabelText('Category'), 'debt');
    await user.type(dialog.getByLabelText('Item name'), 'Possible income');
    await user.selectOptions(dialog.getByLabelText('Category'), 'income');
    expect(dialog.queryByLabelText('Debt type')).not.toBeInTheDocument();
    expect(dialog.queryByLabelText('Automatic debit')).not.toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText('Income certainty'), 'uncertain');
    await user.selectOptions(dialog.getByLabelText('Repeats'), 'fortnightly');
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ records: [expect.objectContaining({
      kind: 'income', reliability: 'uncertain', debtType: null, target: null, outstanding: null,
      schedule: { date: null, recurrence: 'fortnightly' }, amount: { status: 'unknown', amount: null },
    })] }));
  });
  it('keeps item edits on close without submitting or adding disclosures', async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Form save={save} />);
    expect(screen.getByLabelText('Reserve floor (₹)')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    const modal = screen.getByRole('dialog', { name: 'Edit item' });
    expect(modal.closest('form')).toBeNull();
    expect(modal.querySelector('form')).toBeNull();
    await waitFor(() => expect(within(modal).getByLabelText('Item name')).toHaveFocus());
    await user.type(within(modal).getByLabelText('Item name'), 'Rent{Enter}');
    expect(save).not.toHaveBeenCalled();
    await user.click(within(modal).getByRole('button', { name: 'Close edit item' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add an item' })).toHaveFocus();
    const item = screen.getByRole('button', { name: /^Rent\s*Essentials$/ });
    expect(item).toHaveAttribute('aria-haspopup', 'dialog');
    expect(item).not.toHaveAttribute('aria-expanded');
    await user.click(item);
    const dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    expect(dialog.getByLabelText('Item name')).toHaveValue('Rent');
    expect(dialog.getByLabelText('Next unpaid or future date')).toHaveValue('');
    expect(within(dialog.getByRole('group', { name: 'Amount' })).getByLabelText('How certain?')).toHaveValue('unknown');
    expect(container.querySelector('details, summary')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    expect(item).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ records: [expect.objectContaining({
      label: 'Rent', amount: { status: 'unknown', amount: null }, schedule: { date: null, recurrence: 'once' },
    })] }));
  });
  it.each([
    ['Item name', 'Rent', 'short, readable name'],
    ['Amount (₹)', '1200', 'Enter rupees'],
    ['Next unpaid or future date', '2026-09-20', 'valid date'],
  ])('reopens and focuses an invalid %s before saving', async (field, value, message) => {
    const initial = draftFacts(snapshot());
    initial.records = [{ id: 'rent', kind: 'essential', label: field === 'Item name' ? '' : 'Rent', autoDebit: false,
      amount: { status: 'exact', amount: field === 'Amount (₹)' ? '1.234' : '1200' },
      schedule: { date: field === 'Next unpaid or future date' ? '2026-02-30' : '2026-09-20', recurrence: 'once' } }];
    const save = vi.fn();
    const user = userEvent.setup();
    render(<Form save={save} initial={initial} />);
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    const summary = screen.getByRole('alert');
    expect(summary).toHaveTextContent(message);
    await waitFor(() => expect(summary).toHaveFocus());
    expect(save).not.toHaveBeenCalled();
    await user.click(within(summary).getByRole('button'));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    const input = dialog.getByLabelText(field);
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.clear(input);
    await user.type(input, value);
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Save figures' }));
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ records: [expect.objectContaining({
      label: 'Rent', amount: { status: 'exact', amount: '1200' }, schedule: { date: '2026-09-20', recurrence: 'once' },
    })] }));
  });
  it.each(['locked', 'pending'] as const)('uses the latest parent draft and honors %s while the modal stays open', async (lock) => {
    let facts = draftFacts(snapshot());
    facts.records = [{ id: 'rent', kind: 'essential', label: 'Rent', autoDebit: false,
      amount: { status: 'unknown', amount: null }, schedule: { date: null, recurrence: 'once' } }];
    const props = { facts, settings, locked: false, pending: false, conflict: false,
      onChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(), onUseSaved: vi.fn(), onReconcile: vi.fn() };
    const user = userEvent.setup();
    const { rerender } = render(<Editor {...props} />);
    await user.click(screen.getByRole('button', { name: /^Rent\s*Essentials$/ }));
    facts = { ...facts, opening: { status: 'exact', amount: '5000' },
      records: [...facts.records, { ...facts.records[0], id: 'food', label: 'Food' }] };
    rerender(<Editor {...props} facts={facts} />);
    const dialog = within(screen.getByRole('dialog', { name: 'Edit item' }));
    await user.type(dialog.getByLabelText('Item name'), 's');
    expect(props.onChange).toHaveBeenLastCalledWith({ ...facts, records: [{ ...facts.records[0], label: 'Rents' }, facts.records[1]] });
    rerender(<Editor {...props} facts={facts} {...{ [lock]: true }} />);
    expect(dialog.getByLabelText('Item name')).toBeDisabled();
    expect(dialog.getByLabelText('Category')).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it('bounds a growing list and keeps keyboard-operable paging', async () => {
    const user = userEvent.setup();
    render(<PagedList label="Test items" className="items">{Array.from({ length: 25 }, (_, index) => <li key={index}>Item {index + 1}</li>)}</PagedList>);
    const list = screen.getByRole('list', { name: 'Test items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(list).toHaveTextContent('Item 21');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
  it('renders labels as text, signed saved running balances, and prominent timing/uncertainty issues', () => {
    const saved = snapshot();
    saved.facts.records = [{ id: 'income', kind: 'income', label: '<img src=x onerror=alert(1)>', amount: { amountPaise: 10000, status: 'estimate' }, schedule: { date: '2026-09-20', recurrence: 'once' }, autoDebit: false, reliability: 'uncertain' }];
    saved.plan.events = [{ id: 'income:2026-09-20', recordId: 'income', label: '<img src=x onerror=alert(1)>', kind: 'income', originalDueDate: '2026-09-20', date: '2026-09-20', amountPaise: 10000, amountBasis: 'reported', included: false, overdue: false, autoDebit: false, balancePaise: -100 }];
    saved.plan.issues = [{ code: 'uncertainIncome', message: 'Uncertain income is displayed but excluded from assurance.', recordId: 'income' }, { code: 'sameDayTiming', message: 'Debits precede receipts conservatively; verify receipt availability.', recordId: null }];
    render(<Projection snapshot={saved} stale />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getAllByText('<img src=x onerror=alert(1)>').length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: 'Dated cash flow events' })).toHaveTextContent('+₹100.00');
    expect(screen.getByRole('list', { name: 'Dated cash flow events' })).toHaveTextContent('Balance -₹1.00');
    expect(screen.getByRole('list', { name: 'Figures and timing to check' })).toHaveTextContent('verify receipt availability');
    expect(screen.getByText('Based on what you shared · may be out of date')).toBeVisible();
  });
});