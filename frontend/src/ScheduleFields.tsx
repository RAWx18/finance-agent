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
};

export function scheduleDraft(schedule: Record['schedule']): ScheduleDraft {
  return { recurrence: schedule.recurrence, endDate: schedule.endDate ?? '', count: schedule.count?.toString() ?? (schedule.amounts?.length ? String(schedule.amounts.length) : ''), amounts: structuredClone(schedule.amounts ?? []) };
}

export function scheduleAmounts(amounts: MoneyInput[]): MoneyInput[] {
  return amounts.map(amount => ({ ...submittedMoney(amount), ...(!amount.conversion ? { conversion: null } : {}) }));
}

export function schedulePatch(draft: ScheduleDraft, schedule: Record['schedule']): components['schemas']['SchedulePatch'] {
  const initial = scheduleDraft(schedule);
  return { ...(draft.recurrence !== initial.recurrence ? { recurrence: draft.recurrence } : {}),
    ...(draft.endDate !== initial.endDate ? { endDate: draft.endDate || null } : {}),
    ...(draft.count !== initial.count || initial.amounts.length > 0 && !draft.amounts.length ? { count: draft.count ? Number(draft.count) : null } : {}),
    ...(JSON.stringify(draft.amounts) !== JSON.stringify(initial.amounts) ? { amounts: scheduleAmounts(draft.amounts) } : {}),
  };
}

export function scheduleError(draft: ScheduleDraft, record: Record, limit: number): string | null {
  if (draft.endDate && record.schedule.date && draft.endDate < record.schedule.date) return 'The inclusive end date must be on or after the start date.';
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

export function ScheduleFields({ draft, record, onChange }: { draft: ScheduleDraft; record: Record; onChange: (draft: ScheduleDraft) => void }) {
  const budget = draft.recurrence === 'monthlyBudget';
  return <>
    <p className="hint">Starts {record.schedule.date ? dateLabel(record.schedule.date) : 'on an unknown date'}. Use the Date detail to correct the start. Occurrence dates are generated from this cadence, not entered separately.</p>
    <label>Repeats<select value={draft.recurrence} onChange={event => onChange({ ...draft, recurrence: event.target.value as ScheduleDraft['recurrence'] })}>
      {Object.entries(recurrenceLabels).filter(([value]) => value !== 'monthlyBudget' || ['essential', 'optional'].includes(record.kind)).map(([value, label]) => <option key={value} value={value} disabled={value === 'monthlyBudget' && (!!draft.amounts.length || record.autoDebit)}>{label}</option>)}
    </select></label>
    {budget && <p className="hint">{budgetDescription} Count means calendar months, not daily occurrences.</p>}
    {!budget && ['essential', 'optional'].includes(record.kind) && (!!draft.amounts.length || record.autoDebit) && <p className="hint">To use a monthly budget, first choose one amount for all occurrences and turn off automatic debit.</p>}
    <label>End date (inclusive, optional)<input type="date" value={draft.endDate} min={record.schedule.date ?? undefined} onChange={event => onChange({ ...draft, endDate: event.target.value })} /></label>
    <label>{budget ? 'Number of calendar months (optional)' : 'Number of occurrences (optional)'}<input type="number" min={1} max={1000} step={1} value={draft.count} disabled={!!draft.amounts.length} onChange={event => onChange({ ...draft, count: event.target.value })} /></label>
    <p className="hint">Leave end and count blank for an ongoing schedule. If both are supplied, the earlier limit applies. An ordered amount list defines its own finite count.</p>
  </>;
}

export function RecordAmountFields({ record, amount, draft, clearTarget, onAmount, onSchedule, onClearTarget }: {
  record: Record; amount: MoneyInput; draft: ScheduleDraft; clearTarget: boolean;
  onAmount: (amount: MoneyInput) => void; onSchedule: (draft: ScheduleDraft) => void; onClearTarget: (clear: boolean) => void;
}) {
  const variable = !!draft.amounts.length;
  return <>
    <label>Amount pattern<select value={variable ? 'variable' : 'same'} onChange={event => onSchedule({ ...draft,
      amounts: event.target.value === 'variable' ? [structuredClone(amount)] : [],
      ...(event.target.value === 'variable' ? { count: '1' } : {}),
    })}><option value="same">Same amount each occurrence</option><option value="variable" disabled={draft.recurrence === 'monthlyBudget'}>Varies by occurrence</option></select></label>
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