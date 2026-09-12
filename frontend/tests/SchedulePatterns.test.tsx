// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { api } from '../src/api';
import type { Command, MoneyInput, Snapshot } from '../src/api';
import { fieldDraft, fieldOperation } from '../src/cardFields';
import { MoneyEdit } from '../src/MoneyEdit';
import type { EditTarget } from '../src/MoneyEdit';
import { scheduleLabel } from '../src/money';
import { scheduleDraft, scheduleError, schedulePatch } from '../src/ScheduleFields';
import { initialState } from '../src/session';
import { planningSnapshot, settings } from './fixtures';

type Schedule = Snapshot['facts']['records'][number]['schedule'];

/** Renders a live-session schedule editor and exposes its command spy. */
function editor(saved: Snapshot, field: EditTarget['field'] = 'recurrence') {
  const onCommand = vi.fn<(operation: Command['operation']) => void>();
  return { ...render(<MoneyEdit target={{ recordId: saved.facts.records[0].id, field }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }}
    active onCommand={onCommand} onClose={vi.fn()} onRetry={vi.fn()} />), onCommand };
}

/** Creates an undated monthly schedule fixture using day 31 or a month-end pattern. */
function patterned(kind: 'dayOfMonth' | 'monthEnd' = 'dayOfMonth'): Snapshot {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule = { date: null, certainty: 'unknown', recurrence: 'monthly', basis: 'payment', count: null, amounts: [],
    pattern: kind === 'dayOfMonth' ? { kind, day: 31 } : { kind, day: null } };
  return saved;
}

it.each([undefined, null])('keeps a monthly schedule with pattern %s undated when opening and saving', async pattern => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule = { date: null, certainty: 'unknown', recurrence: 'monthly', basis: 'payment', pattern };
  const original = structuredClone(saved);
  const { onCommand } = editor(saved);
  expect(screen.getByLabelText('Timing basis')).toHaveValue('date');
  expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  expect(screen.getByText(/Starts on an unknown date/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: {} }] } });
  expect(scheduleLabel(saved.facts.records[0].schedule)).toBe('Monthly');
  expect(saved).toEqual(original);
});

it('changes recurrence to monthly without inferring a date or a monthly day', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].schedule.date = null; saved.facts.records[0].schedule.certainty = 'unknown';
  const { onCommand } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Repeats'), 'monthly');
  expect(screen.getByLabelText('Timing basis')).toHaveValue('date');
  expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { recurrence: 'monthly' } }] } });
  expect(schedulePatch({ ...scheduleDraft(saved.facts.records[0].schedule), recurrence: 'monthly' }, saved.facts.records[0].schedule)).toEqual({ recurrence: 'monthly' });
});

it.each(['date', 'dayOfMonth', 'monthEnd'] as const)('keeps %s source timing untouched in an inclusive end-date correction', async timing => {
  const saved = timing === 'date' ? planningSnapshot() : patterned(timing);
  const original = structuredClone(saved);
  const { onCommand } = editor(saved);
  fireEvent.change(screen.getByLabelText('End date (inclusive, optional)'), { target: { value: '2026-10-15' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { endDate: '2026-10-15' } }] } });
  expect(saved).toEqual(original);
});

it.each(['dayOfMonth', 'monthEnd'] as const)('serializes explicit %s timing and reopens the API response without inventing a source date', async kind => {
  const saved = planningSnapshot(); const original = structuredClone(saved);
  const pattern = kind === 'dayOfMonth' ? { kind, day: 31 } : { kind, day: null };
  const receipt = patterned(kind); receipt.revision = 1; receipt.sequence = 1;
  const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(JSON.stringify(receipt)));
  vi.stubGlobal('fetch', fetch);
  const { onCommand, unmount } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Timing basis'), kind);
  expect(screen.getByLabelText('Repeats')).toHaveValue('monthly');
  expect(screen.getByLabelText('Number of occurrences (optional)')).toBeDisabled();
  expect(screen.getByText(/Saving this pattern replaces any supplied start date/)).toHaveTextContent('generated dates remain estimates');
  if (kind === 'dayOfMonth') {
    expect(screen.getByLabelText('Day of month')).toHaveValue(null);
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '31' } });
  }
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  const operation: Command['operation'] = { type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { recurrence: 'monthly', pattern, date: null, certainty: 'unknown' } }] } };
  expect(onCommand).toHaveBeenCalledExactlyOnceWith(operation);
  const restored = await api.save({ commandId: 'schedule-pattern', expectedRevision: 0, operation: onCommand.mock.calls[0][0] });
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/session/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ commandId: 'schedule-pattern', expectedRevision: 0, operation }) });
  expect(restored.facts.records[0].schedule).toEqual(receipt.facts.records[0].schedule);
  expect(schedulePatch(scheduleDraft(restored.facts.records[0].schedule), restored.facts.records[0].schedule)).toEqual({});
  expect(scheduleLabel(restored.facts.records[0].schedule)).toContain(kind === 'dayOfMonth' ? 'Reported day 31 of each month' : 'Reported month-end pattern');
  expect(scheduleLabel(restored.facts.records[0].schedule)).toContain('generated dates remain estimates');
  unmount(); editor(restored);
  expect(screen.getByLabelText('Timing basis')).toHaveValue(kind);
  if (kind === 'dayOfMonth') expect(screen.getByLabelText('Day of month')).toHaveValue(31);
  expect(saved).toEqual(original);
});

it.each(['', '0', '32', '-1', '1.5', '1e1', '01', ' 1', '31.0'])('rejects invalid monthly day %j without coercing it', day => {
  const record = patterned().facts.records[0];
  expect(scheduleError({ ...scheduleDraft(record.schedule), day }, record, settings.maxMoneyPaise)).toBe('Enter a whole day from 1 to 31.');
});

it.each(['', '0', '32', '1.5'])('does not send an editor correction for invalid monthly day %j', async day => {
  const { onCommand } = editor(planningSnapshot());
  await userEvent.selectOptions(screen.getByLabelText('Timing basis'), 'dayOfMonth');
  fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: day } });
  fireEvent.submit(screen.getByLabelText('Repeats').closest('form')!);
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole day from 1 to 31.');
});

it.each(['1', '31'])('accepts boundary day %s and explicitly replaces the pattern', day => {
  const record = patterned('monthEnd').facts.records[0];
  const draft = { ...scheduleDraft(record.schedule), timing: 'dayOfMonth' as const, day };
  expect(scheduleError(draft, record, settings.maxMoneyPaise)).toBeNull();
  expect(schedulePatch(draft, record.schedule)).toEqual({ pattern: { kind: 'dayOfMonth', day: Number(day) }, date: null, certainty: 'unknown', recurrence: 'monthly' });
});

it('updates a reported day and does not keep the day when explicitly selecting month end', async () => {
  const saved = patterned(); const { onCommand } = editor(saved);
  fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '15' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { pattern: { kind: 'dayOfMonth', day: 15 }, date: null, certainty: 'unknown', recurrence: 'monthly' } }] } });
  await userEvent.selectOptions(screen.getByLabelText('Timing basis'), 'monthEnd');
  expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { pattern: { kind: 'monthEnd', day: null }, date: null, certainty: 'unknown', recurrence: 'monthly' } }] } });
});

it('does not retain the source start-date bound after an explicit pattern selection', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].schedule.date = '2026-10-31';
  const { onCommand } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Timing basis'), 'monthEnd');
  expect(screen.getByLabelText('End date (inclusive, optional)')).not.toHaveAttribute('min');
  fireEvent.change(screen.getByLabelText('End date (inclusive, optional)'), { target: { value: '2026-09-30' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0, records: [
    { id: 'rent', delete: false, distinct: false, schedule: { recurrence: 'monthly', pattern: { kind: 'monthEnd', day: null }, date: null, certainty: 'unknown', endDate: '2026-09-30' } },
  ] } });
});

it.each(['once', 'daily', 'weekly', 'fortnightly', 'monthlyBudget'] as const)('clears a pattern explicitly when recurrence changes to %s', async recurrence => {
  const saved = patterned(); const { onCommand } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Repeats'), recurrence);
  expect(screen.getByLabelText('Timing basis')).toHaveValue('date');
  expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { recurrence, pattern: null } }] } });
});

it('clears a pattern without supplying a date and allows an explicitly entered finite count', async () => {
  const saved = patterned(); const { onCommand } = editor(saved);
  await userEvent.selectOptions(screen.getByLabelText('Timing basis'), 'date');
  expect(screen.getByLabelText('Number of occurrences (optional)')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Number of occurrences (optional)'), { target: { value: '3' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { pattern: null, count: 3 } }] } });
});

it('offers pattern timing only after an existing count is explicitly cleared', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].schedule = { ...saved.facts.records[0].schedule, recurrence: 'monthly', count: 3 };
  const { onCommand } = editor(saved);
  expect(screen.queryByRole('option', { name: 'Monthly day' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Month-end pattern' })).not.toBeInTheDocument();
  expect(screen.getByText(/Monthly timing patterns cannot use an occurrence count or varying amounts/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Number of occurrences (optional)'), { target: { value: '' } });
  await userEvent.selectOptions(screen.getByLabelText('Timing basis'), 'monthEnd');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0, records: [
    { id: 'rent', delete: false, distinct: false, schedule: { pattern: { kind: 'monthEnd', day: null }, date: null, certainty: 'unknown', recurrence: 'monthly', count: null } },
  ] } });
});

it('preserves finite variable FX source inputs and blocks conflicting timing options', async () => {
  const source: MoneyInput = { amount: '125.50', status: 'estimate', conversion: { currency: 'USD', rate: '83.12345678', rateStatus: 'estimate', rateDate: '2026-09-10', fee: '0', feeStatus: 'exact' } };
  const saved = planningSnapshot(); saved.facts.records[0].kind = 'income';
  saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.facts.records[0].schedule = { date: '2026-08-31', certainty: 'estimate', recurrence: 'monthly', basis: 'payment', count: null, amounts: [source, { amount: '500', status: 'exact', conversion: null }] };
  const original = structuredClone(saved); const { onCommand } = editor(saved);
  expect(screen.queryByRole('option', { name: 'Monthly day' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Month-end pattern' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Number of occurrences (optional)')).toBeDisabled();
  expect(screen.getByLabelText('Number of occurrences (optional)')).toHaveValue(2);
  fireEvent.change(screen.getByLabelText('End date (inclusive, optional)'), { target: { value: '2026-10-31' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { endDate: '2026-10-31' } }] } });
  expect(saved).toEqual(original);
});

it('blocks varying amounts while preserving a reported pattern during an ordinary amount correction', async () => {
  const saved = patterned(); const { onCommand } = editor(saved, 'amount');
  expect(screen.getByRole('option', { name: 'Varies by occurrence' })).toBeDisabled();
  expect(screen.getByText(/Varying amounts cannot use a monthly timing pattern/)).toHaveTextContent('Repeats detail');
  await userEvent.selectOptions(screen.getByLabelText('Amount pattern'), 'variable');
  expect(screen.getByLabelText('Amount pattern')).toHaveValue('same');
  fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '12500' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, amount: { amount: '12500', status: 'exact' } }] } });
});

it.each([{ count: '2' }, { amounts: [{ amount: '5', status: 'exact' as const }] }, { recurrence: 'weekly' as const }])('rejects conflicting pattern draft %j', conflict => {
  const record = patterned().facts.records[0];
  expect(scheduleError({ ...scheduleDraft(record.schedule), ...conflict }, record, settings.maxMoneyPaise)).toContain('monthly recurrence, no occurrence count and one amount');
});

it('edits the absent source date rather than a generated occurrence and sends an explicit date correction', async () => {
  const saved = patterned(); const original = structuredClone(saved);
  const { onCommand } = editor(saved, 'schedule.date');
  expect(saved.plan.events[0].date).toBe('2026-09-13');
  expect(screen.getByLabelText('Date')).toHaveValue('');
  expect(screen.getByLabelText('Date certainty')).toHaveValue('unknown');
  expect(screen.getByText(/saving this Date detail replaces the pattern/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-30' } });
  expect(screen.getByLabelText('Date certainty')).toHaveValue('exact');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { date: '2026-09-30', certainty: 'exact' } }] } });
  const target = { recordId: 'rent', field: 'schedule.date' as const }; const draft = fieldDraft(saved, target);
  expect(draft.value).toBe(''); expect(draft.status).toBe('unknown');
  expect(fieldOperation(saved, target, { ...draft, value: '2026-09-30', status: 'exact' }).changes.records).toEqual([
    { id: 'rent', delete: false, distinct: false, schedule: { date: '2026-09-30', certainty: 'exact', pattern: null } },
  ]);
  expect(saved).toEqual(original);
});

it('keeps labels unchanged for dated finite and variable schedules without a pattern', () => {
  const schedule: Schedule = { date: '2026-09-13', certainty: 'exact', recurrence: 'monthly', basis: 'payment', endDate: '2026-10-31', count: 2,
    amounts: [{ amount: '500', status: 'exact' }, { amount: '600', status: 'estimate' }] };
  expect(scheduleLabel(schedule)).toBe('Monthly · Through 31 Oct 2026 (inclusive) · 2 occurrences · 2 ordered amounts · varies by occurrence');
  expect(schedulePatch(scheduleDraft(schedule), schedule)).toEqual({});
});