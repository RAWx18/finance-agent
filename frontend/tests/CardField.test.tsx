// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Command, Snapshot } from '../src/api';
import { CardField, ChangedValue } from '../src/CardField';
import { planningSnapshot } from './fixtures';

const onCommand = vi.fn<(operation: Command['operation']) => Promise<Snapshot | undefined>>();
beforeEach(() => { onCommand.mockReset().mockResolvedValue(undefined); });
const target = { field: 'opening' as const };
function field(snapshot: Snapshot, blocked = false) {
  return <CardField snapshot={snapshot} target={target} label="Cash at plan start" blocked={blocked} onCommand={onCommand}>Reported cash</CardField>;
}

it('uses Enter to save and publishes only canonical props after a matching receipt', async () => {
  const saved = planningSnapshot(); const receipt = structuredClone(saved); receipt.revision++; receipt.sequence++;
  receipt.facts.opening = { amountPaise: 60000025, status: 'exact' };
  onCommand.mockResolvedValue(receipt);
  render(field(saved));
  await userEvent.click(screen.getByRole('button', { name: 'Edit Cash at plan start' }));
  const input = screen.getByRole('textbox', { name: 'Cash at plan start' }); expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: '600000.25' } }); await userEvent.keyboard('{Enter}');
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: saved.revision, opening: { amount: '600000.25', status: 'exact' } } });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit Cash at plan start' })).toHaveTextContent('Reported cash');
  expect(screen.getByRole('button', { name: 'Edit Cash at plan start' })).toHaveFocus();
});

it.each(['undefined', 'rejected', 'unchanged', 'wrongValue', 'wrongSession'] as const)('keeps the draft after a %s receipt', async outcome => {
  const saved = planningSnapshot(); const receipt = structuredClone(saved);
  if (outcome !== 'unchanged') { receipt.revision++; receipt.sequence++; }
  receipt.facts.opening.amountPaise = outcome === 'wrongValue' ? 100 : 60000000;
  if (outcome === 'wrongSession') receipt.sessionId = 'another-session';
  if (outcome === 'rejected') onCommand.mockRejectedValue(new Error('private server details'));
  else onCommand.mockResolvedValue(outcome === 'undefined' ? undefined : receipt);
  render(field(saved)); await userEvent.click(screen.getByRole('button', { name: 'Edit Cash at plan start' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '600000' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  expect(screen.getByRole('textbox')).toHaveValue('600000'); expect(screen.getByRole('alert')).toHaveTextContent('Save not confirmed');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private server');
  await userEvent.keyboard('{Escape}'); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit Cash at plan start' })).toHaveFocus();
});

it('rejects a receipt older than a background snapshot and does not discard the entry', async () => {
  const saved = planningSnapshot(); let finish!: (saved: Snapshot) => void;
  onCommand.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(field(saved));
  await userEvent.click(screen.getByRole('button', { name: 'Edit Cash at plan start' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '600000' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  expect(screen.getByRole('button', { name: 'Cancel Cash at plan start' })).toBeDisabled();
  const background = structuredClone(saved); background.revision = 2; background.sequence = 3;
  rerender(field(background));
  const receipt = structuredClone(saved); receipt.revision = 1; receipt.sequence = 2; receipt.facts.opening.amountPaise = 60000000;
  await act(async () => finish(receipt));
  expect(screen.getByRole('textbox')).toHaveValue('600000');
  expect(screen.getByRole('button', { name: 'Save Cash at plan start' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel Cash at plan start' })).toBeEnabled();
});

it('requires an explicit Unknown action; an empty amount does not silently clear a fact', async () => {
  render(field(planningSnapshot())); await userEvent.click(screen.getByRole('button', { name: 'Edit Cash at plan start' }));
  await userEvent.clear(screen.getByRole('textbox')); await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  expect(onCommand).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('Enter a non-negative rupee amount');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Cash at plan start certainty' }), 'unknown');
  await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: 0, opening: { amount: null, status: 'unknown' } } });
});

it('saves an estimated zero without treating it as unknown', async () => {
  render(field(planningSnapshot())); await userEvent.click(screen.getByRole('button', { name: 'Edit Cash at plan start' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '0' } });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Cash at plan start certainty' }), 'estimate');
  await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  expect(onCommand).toHaveBeenCalledWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: 0, opening: { amount: '0', status: 'estimate' } } });
});

it('keeps Cancel available when writes lock and restores keyboard focus', async () => {
  const saved = planningSnapshot(); const { rerender } = render(field(saved));
  await userEvent.click(screen.getByRole('button', { name: 'Edit Cash at plan start' }));
  rerender(field(saved, true)); expect(screen.getByRole('button', { name: 'Save Cash at plan start' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel Cash at plan start' }));
  expect(screen.getByRole('button', { name: 'Edit Cash at plan start' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Edit Cash at plan start' })).toHaveAttribute('aria-disabled', 'true');
});

it.each(['opening', 'schedule.date'] as const)('resolves %s with the exact conflict and selected report identity', async fieldName => {
  const saved = planningSnapshot();
  saved.facts = { ...saved.facts, conflicts: [{ id: 'dispute', recordId: fieldName === 'opening' ? null : 'rent', field: fieldName, values: fieldName === 'opening'
    ? [{ id: 'first', amountPaise: 500000, status: 'exact' }, { id: 'second', amountPaise: 600000, status: 'estimate' }]
    : [{ id: 'first', date: '2026-09-13', status: 'exact' }, { id: 'second', date: '2026-09-18', status: 'estimate' }] }] };
  render(<CardField snapshot={saved} target={{ field: fieldName, ...(fieldName === 'opening' ? {} : { recordId: 'rent' }) }} label="Disputed figure" blocked={false} onCommand={onCommand}>Conflicting</CardField>);
  await userEvent.click(screen.getByRole('button', { name: 'Resolve Disputed figure' }));
  expect(screen.getByRole('button', { name: 'Save Disputed figure' })).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Resolve Disputed figure' }), 'second');
  expect(onCommand).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole('button', { name: 'Save Disputed figure' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: 0, resolutions: [{ conflictId: 'dispute', value: { id: 'second', status: 'estimate', ...(fieldName === 'opening' ? { amount: '6000.00' } : { date: '2026-09-18' }) } }] } });
  expect(screen.getByRole('form')).toBeVisible();
});

it('uses a fresh value identity for a custom conflict correction', async () => {
  const saved = planningSnapshot(); saved.facts = { ...saved.facts, conflicts: [{ id: 'dispute', field: 'opening', values: [{ id: 'first', amountPaise: 500000, status: 'exact' }, { id: 'second', amountPaise: 600000, status: 'exact' }] }] };
  render(field(saved)); await userEvent.click(screen.getByRole('button', { name: 'Resolve Cash at plan start' }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Resolve Cash at plan start' }), 'custom');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '6500' } }); await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  const operation = onCommand.mock.calls[0][0]; expect(operation.type).toBe('updateFacts');
  if (operation.type !== 'updateFacts') throw new Error('Expected a source correction');
  expect(operation.changes.resolutions?.[0].conflictId).toBe('dispute');
  expect(operation.changes.resolutions?.[0].value).toMatchObject({ amount: '6500', status: 'exact' });
  expect(['first', 'second']).not.toContain(operation.changes.resolutions?.[0].value.id);
});

it('highlights a changed value only, not its mount or unrelated updates', () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  try {
    const { rerender } = render(<ChangedValue value="₹5,000" />); expect(animate).not.toHaveBeenCalled();
    rerender(<ChangedValue value="₹5,000" />); expect(animate).not.toHaveBeenCalled();
    rerender(<ChangedValue value="₹6,000" />); expect(animate).toHaveBeenCalledOnce();
  } finally { Reflect.deleteProperty(HTMLElement.prototype, 'animate'); }
});