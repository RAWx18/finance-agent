// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { MoneyInput, Snapshot } from './api';
import type { components } from './contracts';
import { budgetDescription, dateLabel, moneyError, recurrenceLabels, submittedMoney } from './money';
import { MoneyFields } from './MoneyFields';
import { PagedList } from './PagedList';

type Record = Snapshot['facts']['records'][number];
export type ScheduleDraft = {
  recurrence: Record['schedule']['recurrence']; endDate: string; count: string; amounts: MoneyInput[];
  basis: NonNullable<Record['schedule']['basis']>;
  timing: 'date' | 'dayOfMonth' | 'monthEnd'; day: string;
};

/** Creates an editable draft of a record's schedule and occurrence amounts. */
export function scheduleDraft(schedule: Record['schedule']): ScheduleDraft {
  return { recurrence: schedule.recurrence, endDate: schedule.endDate ?? '', count: schedule.count?.toString() ?? (schedule.amounts?.length ? String(schedule.amounts.length) : ''), amounts: structuredClone(schedule.amounts ?? []),
    basis: schedule.basis ?? 'payment',
    timing: schedule.pattern?.kind ?? 'date', day: schedule.pattern?.day?.toString() ?? '' };
}

/** Prepares ordered amounts for saving, including explicit unknowns and absent conversions. */
export function scheduleAmounts(amounts: MoneyInput[]): MoneyInput[] {
  return amounts.map(amount => ({ ...submittedMoney(amount), ...(!amount.conversion ? { conversion: null } : {}) }));
}

/** Produces the schedule changes represented by an edited draft. */
export function schedulePatch(draft: ScheduleDraft, schedule: Record['schedule']): components['schemas']['SchedulePatch'] {
  const initial = scheduleDraft(schedule);
  return { ...(draft.recurrence !== initial.recurrence ? { recurrence: draft.recurrence } : {}),
    ...(draft.basis !== initial.basis ? { basis: draft.basis } : {}),
    ...(draft.timing !== 'date' && draft.recurrence === 'monthly'
      ? draft.timing !== initial.timing || draft.timing === 'dayOfMonth' && draft.day !== initial.day
        ? { pattern: draft.timing === 'dayOfMonth' ? { kind: draft.timing, day: Number(draft.day) } : { kind: draft.timing, day: null }, date: null, certainty: 'unknown', recurrence: 'monthly' } : {}
      : schedule.pattern ? { pattern: null } : {}),
    ...(draft.endDate !== initial.endDate ? { endDate: draft.endDate || null } : {}),
    // Clearing ordered amounts must not silently discard the occurrence limit inferred from their length.
    ...(draft.count !== initial.count || initial.amounts.length > 0 && !draft.amounts.length ? { count: draft.count ? Number(draft.count) : null } : {}),
    ...(JSON.stringify(draft.amounts) !== JSON.stringify(initial.amounts) ? { amounts: scheduleAmounts(draft.amounts) } : {}),
  };
}

/** Reports the first invalid schedule choice or occurrence amount. */
export function scheduleError(draft: ScheduleDraft, record: Record, limit: number): string | null {
  if (draft.basis === 'allowance' && (!['essential', 'optional'].includes(record.kind) || record.autoDebit || record.controllability === 'committed' || !['daily', 'weekly', 'fortnightly', 'monthly'].includes(draft.recurrence))) return 'Recurring spending forecasts require daily, weekly, fortnightly or monthly uncommitted spending without automatic debit.';
  if (draft.timing !== 'date') {
    if (draft.recurrence !== 'monthly' || draft.count || draft.amounts.length) return 'Monthly timing patterns require monthly recurrence, no occurrence count and one amount for all occurrences.';
    if (draft.timing === 'dayOfMonth' && !/^([1-9]|[12][0-9]|3[01])$/.test(draft.day)) return 'Enter a whole day from 1 to 31.';
  }
  if (draft.timing === 'date' && draft.endDate && record.schedule.date && draft.endDate < record.schedule.date) return 'The inclusive end date must be on or after the start date.';
  if (draft.count && (!/^[1-9][0-9]*$/.test(draft.count) || Number(draft.count) > 1000)) return 'Enter a whole count from 1 to 1000, or leave it open-ended.';
  if (draft.recurrence === 'once' && (draft.amounts.length > 1 || Number(draft.count) > 1)) return 'Choose a repeating schedule for more than one occurrence.';
  if (draft.recurrence === 'monthlyBudget' && (!['essential', 'optional'].includes(record.kind) || draft.amounts.length || record.autoDebit)) return 'Monthly budgets are only for spending with one monthly amount and no automatic debit. Correct those details first.';
  if (draft.amounts.length > 200) return 'Use no more than 200 ordered amounts.';
  if (draft.amounts.length && draft.count && Number(draft.count) !== draft.amounts.length) return 'The occurrence count must match the ordered amount list.';
  for (const [index, amount] of draft.amounts.entries()) {
    const error = moneyError(amount, limit);
    if (error) return `Occurrence ${index + 1}: ${error}`;
  }
  return null;
}

/** Provides recurrence, timing-pattern, and finite-schedule inputs for a record. */
export function ScheduleFields({ draft, record, onChange }: { draft: ScheduleDraft; record: Record; onChange: (draft: ScheduleDraft) => void }) {
  const budget = draft.recurrence === 'monthlyBudget';
  const allowance = draft.basis === 'allowance';
  const pattern = draft.timing !== 'date';
  const finite = !!draft.count || !!draft.amounts.length;
  return <>
    {pattern ? <p className="hint">Reported monthly timing only; generated dates remain estimates. Saving this pattern replaces any supplied start date. Use the Date detail to supply a known date instead.</p>
      : <p className="hint">Starts {record.schedule.date ? dateLabel(record.schedule.date) : 'on an unknown date'}. Use the Date detail to correct the start. Occurrence dates are generated from this cadence, not entered separately.</p>}
    <label>Repeats<select value={draft.recurrence} onChange={event => onChange({ ...draft, recurrence: event.target.value as ScheduleDraft['recurrence'],
      ...(event.target.value !== 'monthly' ? { timing: 'date', day: '' } : {}),
      ...(['once', 'monthlyBudget'].includes(event.target.value) ? { basis: 'payment' } : {}),
    })}>
      {Object.entries(recurrenceLabels).filter(([value]) => value !== 'monthlyBudget' || ['essential', 'optional'].includes(record.kind)).map(([value, label]) => <option key={value} value={value} disabled={value === 'monthlyBudget' && (!!draft.amounts.length || record.autoDebit)}>{label}</option>)}
    </select></label>
    {['essential', 'optional'].includes(record.kind) && <label>Schedule basis<select value={draft.basis} onChange={event => onChange({ ...draft, basis: event.target.value as ScheduleDraft['basis'] })}>
      <option value="payment">Reported payments</option>
      <option value="allowance" disabled={record.autoDebit || record.controllability === 'committed' || !['daily', 'weekly', 'fortnightly', 'monthly'].includes(draft.recurrence)}>Recurring spending forecast</option>
    </select></label>}
    {allowance && <p className="hint">The reported amount is forecast in full each occurrence, not spread across days or treated as a bill. {record.schedule.date || pattern ? 'Timing follows the reported start or pattern.' : finite ? 'A finite count or varying amounts needs a known start date; no dates are invented.' : 'With no start date, forecast timing begins at the saved plan’s start; the reported date remains unknown.'} Monthly forecasts from a start date use the last day in shorter months. These are not payment due dates or overdue bills.</p>}
    <label>Timing basis<select value={draft.timing} onChange={event => onChange({ ...draft, timing: event.target.value as ScheduleDraft['timing'], day: '',
      ...(event.target.value !== 'date' ? { recurrence: 'monthly' } : {}),
    })}>
      <option value="date">Date</option>
      {!finite && <><option value="dayOfMonth">Monthly day</option><option value="monthEnd">Month-end pattern</option></>}
    </select></label>
    {draft.timing === 'dayOfMonth' && <label>Day of month<input type="number" min={1} max={31} step={1} value={draft.day} onChange={event => onChange({ ...draft, day: event.target.value })} /></label>}
    {finite && <p className="hint">Monthly timing patterns cannot use an occurrence count or varying amounts. Clear the count and, if needed, switch to one amount in the Amount detail first.</p>}
    {pattern && <p className="hint">The occurrence count is unavailable with a monthly timing pattern. To use a finite count, choose Date as the timing basis. To vary amounts, save that timing choice before editing Amount.</p>}
    {budget && <p className="hint">{budgetDescription} Count means calendar months, not daily occurrences.</p>}
    {!budget && ['essential', 'optional'].includes(record.kind) && (!!draft.amounts.length || record.autoDebit) && <p className="hint">To use a monthly budget, first choose one amount for all occurrences and turn off automatic debit.</p>}
    <label>End date (inclusive, optional)<input type="date" value={draft.endDate} min={!pattern && record.schedule.date || undefined} onChange={event => onChange({ ...draft, endDate: event.target.value })} /></label>
    <label>{budget ? 'Number of calendar months (optional)' : 'Number of occurrences (optional)'}<input type="number" min={1} max={1000} step={1} value={draft.count} disabled={!!draft.amounts.length || pattern} onChange={event => onChange({ ...draft, count: event.target.value })} /></label>
    <p className="hint">Leave end and count blank for an ongoing schedule. If both are supplied, the earlier limit applies. An ordered amount list defines its own finite count.</p>
  </>;
}

/** Supports a shared amount or ordered occurrence amounts with applicable debt and schedule choices. */
export function RecordAmountFields({ record, amount, draft, clearTarget, onAmount, onSchedule, onClearTarget }: {
  record: Record; amount: MoneyInput; draft: ScheduleDraft; clearTarget: boolean;
  onAmount: (amount: MoneyInput) => void; onSchedule: (draft: ScheduleDraft) => void; onClearTarget: (clear: boolean) => void;
}) {
  const variable = !!draft.amounts.length;
  return <>
    <label>Amount pattern<select value={variable ? 'variable' : 'same'} onChange={event => onSchedule({ ...draft,
      amounts: event.target.value === 'variable' ? [structuredClone(amount)] : [],
      ...(event.target.value === 'variable' ? { count: '1' } : {}),
    })}><option value="same">Same amount each occurrence</option><option value="variable" disabled={draft.recurrence === 'monthlyBudget' || draft.timing !== 'date'}>Varies by occurrence</option></select></label>
    {draft.timing !== 'date' && <p className="hint">Varying amounts cannot use a monthly timing pattern. Choose Date as the timing basis in the Repeats detail and save first.</p>}
    {variable ? <>
      <p className="hint">These ordered amounts replace the single amount; they are not added to it. The start date and cadence determine each occurrence.</p>
      {record.kind === 'debt' && <p className="hint">Each amount is a required payment, not an intended total or outstanding balance.</p>}
      {record.kind === 'debt' && record.target && <label className="check"><input type="checkbox" checked={clearTarget} onChange={event => onClearTarget(event.target.checked)} />Clear the single intended payment to use varying required payments</label>}
      <PagedList label="Ordered occurrence amounts" className="amount-sequence" pageSize={5} ordered printable={false}>{draft.amounts.map((value, index) => <li key={index}>
        <fieldset><legend>Occurrence {index + 1}</legend><MoneyFields value={value} income={record.kind === 'income'} onChange={amount => onSchedule({ ...draft, amounts: draft.amounts.map((item, position) => position === index ? amount! : item) })} />
          <button type="button" disabled={draft.amounts.length === 1} aria-label={`Remove occurrence ${index + 1}`} onClick={() => onSchedule({ ...draft, amounts: draft.amounts.filter((_, position) => position !== index), count: String(draft.amounts.length - 1) })}>Remove</button>
        </fieldset>
      </li>)}</PagedList>
      <button type="button" disabled={draft.amounts.length >= 200} onClick={() => onSchedule({ ...draft, amounts: [...draft.amounts, { amount: null, status: 'unknown', conversion: null }], count: String(draft.amounts.length + 1) })}>Add occurrence amount</button>
      <ScheduleFields {...{ record, draft }} onChange={onSchedule} />
    </> : <>
      <MoneyFields value={amount} income={record.kind === 'income'} onChange={value => onAmount(value!)} />
      {draft.recurrence === 'monthlyBudget' && <p className="hint">Amount per calendar month. {budgetDescription}</p>}
    </>}
  </>;
}