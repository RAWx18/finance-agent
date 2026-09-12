// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { MoneyInput } from '../src/api';
import { MoneyEdit } from '../src/MoneyEdit';
import { RecordRow } from '../src/MoneyRecords';
import type { EditTarget } from '../src/MoneyEdit';
import { MoneyFields } from '../src/MoneyFields';
import { fieldDraft, fieldOperation, fieldSaved } from '../src/cardFields';
import { amountLabel, draftFacts, sourceDescription } from '../src/money';
import { initialState } from '../src/session';
import { planningSnapshot, settings } from './fixtures';

const source: MoneyInput = { amount: '50', status: 'exact', conversion: { currency: 'USD', rate: null, rateStatus: 'unknown', rateDate: null, fee: null, feeStatus: 'unknown', direction: 'payment' } };

it.each(['amount', 'schedule.date'] as const)('opens the existing MoneyEdit at the compact record %s value', async field => {
  const saved = planningSnapshot(); const record = saved.facts.records[0];
  record.amount = { amountPaise: 400000, status: 'estimate', source: { ...structuredClone(source), conversion: {
    ...source.conversion!, rate: '80', rateStatus: 'estimate', fee: '0', feeStatus: 'exact',
  } } };
  record.schedule = { date: '2026-09-06', recurrence: 'weekly', certainty: 'estimate', basis: 'payment' };
  saved.plan.evaluatedOn = '2026-09-14';
  saved.plan.events[0] = { ...saved.plan.events[0], date: '2026-09-20' };
  saved.plan.planningFacts = structuredClone(saved.facts);
  saved.plan.planningFacts.records[0].amount.amountPaise = 420000;
  saved.plan.planningFacts.records[0].amount.source!.conversion!.rate = '84';
  const onEdit = vi.fn(); const onCommand = vi.fn(); const original = structuredClone(saved);
  const view = render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={onEdit} onCommand={onCommand} />);
  expect(screen.getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('₹4,200.00');
  expect(screen.getByRole('button', { name: 'Edit Rent date' })).toHaveTextContent('Due 20 Sept');
  await userEvent.click(screen.getByRole('button', { name: `Edit Rent ${field === 'amount' ? 'amount' : 'date'}` }));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ recordId: 'rent', field });
  view.rerender(<MoneyEdit target={onEdit.mock.calls[0][0]} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }} active onCommand={onCommand} onClose={vi.fn()} onRetry={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Correct Rent' });
  expect(within(dialog).getByLabelText('Detail')).toHaveValue(field);
  if (field === 'amount') {
    expect(within(dialog).getByLabelText('Original amount (USD)')).toHaveValue('50');
    expect(within(dialog).getByLabelText('Rate certainty')).toHaveValue('estimate');
    expect(within(dialog).getByLabelText('Rate (INR per 1 USD)')).toHaveValue('80');
    expect(within(dialog).getByText(/Last saved:/)).toHaveTextContent('₹4,000.00');
  } else {
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-09-06');
    expect(within(dialog).getByLabelText('Date certainty')).toHaveValue('estimate');
  }
  expect(onCommand).not.toHaveBeenCalled(); expect(saved).toEqual(original);
});

it.each([
  { income: true, valuation: false, direction: 'receipt' },
  { income: false, valuation: false, direction: 'payment' },
  { income: false, valuation: true, direction: 'valuation' },
] as const)('starts foreign conversion with $direction direction and unknown terms', async ({ income, valuation, direction }) => {
  const onChange = vi.fn();
  render(<MoneyFields value={{ amount: '50', status: 'exact' }} onChange={onChange} income={income} valuation={valuation} />);
  await userEvent.selectOptions(screen.getByLabelText('Currency'), 'foreign');
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...source, conversion: { ...source.conversion, currency: '', direction } });
});

it.each(['essential', 'optional', 'debt'] as const)('edits unknown %s source quotes without inventing INR or dates', async kind => {
  const saved = planningSnapshot();
  saved.facts.records[0] = { ...saved.facts.records[0], kind, debtType: kind === 'debt' ? 'card' : null, amount: { amountPaise: null, status: 'unknown', source: structuredClone(source) } };
  const onCommand = vi.fn();
  render(<MoneyEdit target={{ recordId: saved.facts.records[0].id, field: 'amount' }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }} active onCommand={onCommand} onClose={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByLabelText('Currency code')).toHaveValue('USD');
  expect(screen.getByLabelText('INR fee (₹)')).toBeDisabled();
  expect(screen.getByText(/Fees are added/)).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText('Rate certainty'), 'exact');
  fireEvent.change(screen.getByLabelText('Rate (INR per 1 USD)'), { target: { value: '80' } });
  await userEvent.selectOptions(screen.getByLabelText('Fee certainty'), 'exact');
  fireEvent.change(screen.getByLabelText('INR fee (₹)'), { target: { value: '10' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand.mock.calls[0][0].changes.records[0].amount).toEqual({ ...source, conversion: { ...source.conversion, rate: '80', rateStatus: 'exact', fee: '10', feeStatus: 'exact', provider: null, fetchedAt: null } });
  expect(saved.facts.records[0].amount.amountPaise).toBeNull();
});

it.each(['opening', 'target', 'outstanding'] as const)('allows %s currency edits with field-specific semantics', async field => {
  const saved = planningSnapshot();
  saved.facts.opening = { amountPaise: null, status: 'unknown', source: { ...source, conversion: { ...source.conversion!, direction: 'receipt' } } };
  saved.facts.records[0] = { ...saved.facts.records[0], kind: 'debt', debtType: 'card', target: { amountPaise: null, status: 'unknown', source: structuredClone(source) }, outstanding: { amountPaise: null, status: 'unknown', source: { ...source, conversion: { ...source.conversion!, direction: 'valuation' } } } };
  const target: EditTarget = field === 'opening' ? { field } : { field, recordId: saved.facts.records[0].id };
  const onCommand = vi.fn();
  render(<MoneyEdit {...{ target, snapshot: saved, onCommand }} state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }} active onClose={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByLabelText('Currency code')).toHaveValue('USD');
  if (field === 'opening') expect(screen.getByLabelText('INR deduction (₹)')).toBeDisabled();
  if (field === 'outstanding') expect(screen.getByText(/rate-only valuation/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'gbp' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  const changes = onCommand.mock.calls[0][0].changes;
  expect((field === 'opening' ? changes.opening : changes.records[0][field]).conversion).toEqual({ currency: 'GBP', rate: null, rateStatus: 'unknown', rateDate: null, fee: null, feeStatus: 'unknown', direction: field === 'opening' ? 'receipt' : field === 'outstanding' ? 'valuation' : 'payment' });
});

it('retains outflow source, fee and date during inline rate correction and full draft export', () => {
  const saved = planningSnapshot();
  saved.facts.records[0].amount = { amountPaise: 401000, status: 'exact', source: { ...source, conversion: { ...source.conversion!, rate: '80', rateStatus: 'exact', fee: '10', feeStatus: 'exact', rateDate: '2026-09-12' } } };
  const target = { recordId: saved.facts.records[0].id, field: 'amount' as const, term: 'rate' as const };
  const draft = fieldDraft(saved, target);
  draft.value = '81';
  const operation = fieldOperation(saved, target, draft);
  expect(operation.changes.records![0].amount!.conversion).toEqual({ ...saved.facts.records[0].amount.source!.conversion, rate: '81', provider: null, fetchedAt: null });
  expect(draftFacts(saved).records[0].amount).toEqual(saved.facts.records[0].amount.source);
  expect(amountLabel(saved.facts.records[0].amount)).toContain('Calculated INR: ₹4,010.00');
  expect(sourceDescription(saved.facts.records[0].amount.source!)).toContain('INR fee: ₹10');
  expect(sourceDescription(saved.facts.records[0].amount.source!)).not.toContain('INR deduction');
});

it.each(['rate', 'fee', 'rateDate'] as const)('clears Frankfurter provenance only for an inline %s rate correction', term => {
  const saved = planningSnapshot();
  const conversion = { ...source.conversion!, rate: '80', rateStatus: 'estimate' as const, provider: 'frankfurter' as const, fetchedAt: '2026-09-12T08:00:00Z', rateDate: '2026-09-11' };
  saved.facts.records[0].amount = { amountPaise: 400000, status: 'estimate', source: { ...source, conversion } };
  const target = { recordId: saved.facts.records[0].id, field: 'amount' as const, term };
  const draft = fieldDraft(saved, target);
  draft.value = term === 'rate' ? '81' : term === 'fee' ? '10' : '2026-09-12'; draft.status = 'exact';
  const operation = fieldOperation(saved, target, draft);
  const submitted = operation.changes.records![0].amount!;
  expect(submitted.conversion).toMatchObject({ [term]: draft.value, provider: term === 'rate' ? null : 'frankfurter', fetchedAt: term === 'rate' ? null : conversion.fetchedAt });
  expect(saved.facts.records[0].amount.source!.conversion).toEqual(conversion);
  const receipt = structuredClone(saved); receipt.facts.records[0].amount.source = structuredClone(submitted);
  expect(fieldSaved(receipt, target, operation)).toBe(true);
  if (term === 'rate') {
    expect(sourceDescription(submitted)).not.toContain('Frankfurter');
    receipt.facts.records[0].amount.source!.conversion = { ...receipt.facts.records[0].amount.source!.conversion!, provider: 'frankfurter' };
    expect(fieldSaved(receipt, target, operation)).toBe(false);
  }
});

it.each(['rate', 'fee'] as const)('preserves original amount and clears provenance only when the %s input is edited', term => {
  const onChange = vi.fn();
  const value: MoneyInput = { ...source, conversion: { ...source.conversion!, rate: '80', rateStatus: 'estimate', fee: '10', feeStatus: 'exact', provider: 'frankfurter', fetchedAt: '2026-09-12T08:00:00Z' } };
  render(<MoneyFields value={value} onChange={onChange} />);
  expect(screen.getByText(/Missing rates are obtained automatically from Frankfurter/)).toBeVisible();
  expect(screen.getByText(/excludes unknown conversion fees/)).toBeVisible();
  fireEvent.change(screen.getByLabelText(term === 'rate' ? 'Rate (INR per 1 USD)' : 'INR fee (₹)'), { target: { value: term === 'rate' ? '81' : '20' } });
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...value, conversion: { ...value.conversion, [term]: term === 'rate' ? '81' : '20', ...(term === 'rate' ? { provider: null, fetchedAt: null } : {}) } });
});