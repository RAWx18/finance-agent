// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { Command, MoneyInput, Snapshot } from './api';
import type { components } from './contracts';
import { Details, Dialog } from './Dialog';
import { amountLabel, amountStatus, budgetDescription, dateLabel, decimal, lastDate, money, moneyError, moneyInput, sourceDescription, submittedMoney } from './money';
import { PagedList } from './PagedList';
import { MoneyFields } from './MoneyFields';

export type WorkspaceCard = components['schemas']['WorkspaceCard'];
export type WorkspaceResult = components['schemas']['WorkspaceResult'];
export type Fact = Snapshot['facts']['records'][number];
type Conflict = components['schemas']['FactConflict'];
type Contribution = components['schemas']['Contribution'];
export const fieldLabels: Record<string, string> = {
  opening: 'Cash at plan start', amount: 'Amount', target: 'Intended payment', outstanding: 'Outstanding balance',
  'schedule.date': 'Date', reliability: 'Income certainty', controllability: 'Can this spending change?',
  reservePaise: 'Reserve floor', label: 'Name', certainty: 'Date certainty', recurrence: 'Repeats',
};
export const resultLabels: Record<string, string> = {
  opening: 'Opening cash', reliableIncome: 'Income included', uncertainIncome: 'Income not counted on',
  datedOutflow: 'Dated spending & payments', closing: 'Projected closing cash', trough: 'Lowest projected balance',
  firstGap: 'First cash gap', peakGap: 'Largest cash gap', reserveShortfall: 'Reserve shortfall',
};
export const resultStates: Record<WorkspaceResult['state'], string> = {
  known: 'Calculated', estimated: 'Calculated · Estimated', uncertain: 'Calculated · Needs checking',
  missing: 'Unknown', conflicting: 'Conflicting reports', proposed: 'Proposed · not saved',
  accepted: 'Saved assumption', unresolved: 'Needs checking',
};
const rules: Record<string, string> = {
  reportedAvailableOpening: 'The available cash you reported at the start, not credit or future income.',
  sumIncludedDatedReceipts: 'Only dated, reliable receipts with confirmed amounts and dates count towards balances.',
  sumExcludedKnownDatedReceipts: 'Known dated receipts that are not confirmed enough to count towards balances.',
  sumKnownDatedOutflow: 'Dated payments and any estimated daily budget shares within these 30 days. Undated commitments are not included.',
  openingPlusIncludedIncomeMinusIncludedOutflow: 'Opening cash plus included income, less included spending and payments. Closing cash is not spare spending money.',
  minimumOpeningAndEventBalances: 'The lowest balance at the start or after a dated receipt or payment.',
  maximumDeficitOnEarliestNegativeDate: 'The largest deficit on the first day cash goes below zero. Later income cannot cover an earlier deadline.',
  maxZeroMinusTroughNotSumOfGaps: 'The largest cash deficit, not the sum of daily gaps.',
  maxZeroReserveMinusMaxZeroTrough: 'How far the lowest non-negative balance falls below the reserve floor. The reserve is not spending.',
  proposedMinusActiveResult: 'The difference between this proposal and the current picture. No payment is made.',
  'conditionalReconcile:closing': 'Closing cash if the stated receipts arrive as assumed. This income is not confirmed.',
  'conditionalReconcile:firstGap': 'The first cash gap if the stated receipts arrive as assumed. Same-day payments still come first.',
  'conditionalReconcile:peakGap': 'The largest cash gap if the stated receipts arrive as assumed, not the sum of daily gaps.',
};
const assumptions: Record<string, string> = {
  sameDayOutflowBeforeIncome: 'On the same day, payments come before income.', closingIsNotSpendable: 'Closing cash is not spare spending money.',
  unreportedFactsNotZero: 'Unreported amounts are unknown, not zero.', noPaymentExecution: 'These are requirements, not completed payments.',
  proposedAdjustments: 'Includes the proposed changes; they are not saved.', acceptedAdjustments: 'Includes saved planning assumptions, not completed actions.',
  monthlyBudgetEvenDailyForecastActualMonthLength: budgetDescription,
  currencyConversionReportedRateAndFeeOnly: 'INR income uses only your reported original amount, exchange rate and INR deduction. No live rate is fetched.',
  reportedMonthlyPatternEstimatedDatesNoArrears: 'Dates are calculated estimates from your reported monthly pattern. Earlier unpaid payments are not inferred.',
  recurringAllowanceForecastTiming: 'Recurring living costs are forecast per occurrence. Without a supplied start, the first is assumed at the plan start; actual spending dates may differ.',
  undatedPaymentWhatIfNotAccepted: 'What-if only: one eligible payment per undated item, if unpaid and due in this period. Not a maximum or an accepted change.',
};
export const reasons: Record<string, string> = {
  reportedOpening: 'Reported opening cash', unknownOpening: 'Opening cash is unknown', reported: 'Reported amount',
  requiredOnly: 'Known required payment only', target: 'Selected target, including the minimum',
  acceptedAssumption: 'Saved assumption, not paid', proposedAssumption: 'Proposed assumption, not saved',
  spendingForecast: 'Recurring spending forecast, not a payment due',
  unknownAmount: 'Amount is unknown', conditionalReceipt: 'Receipt is not confirmed enough to count on',
  approximateOutflowDate: 'Payment date is estimated', unknownDate: 'Date is unknown; not in dated balances',
  pastReceipt: 'Receipt is before this plan; not added again', outsideHorizon: 'Outside these 30 days',
  approximateDateOutsideWindow: 'Date is estimated outside these 30 days; it could fall inside the plan',
  afterResultPoint: 'After the point measured by this result; cannot cover that earlier cash gap',
  countedReliableIncome: 'Already counted as reliable income; not counted again as uncertain income',
  monthlyBudget: 'Monthly cash budget distributed across calendar days as an estimate',
  currencyConversion: 'INR receipt calculated from the original currency amount, reported rate and INR deduction',
  variableAmounts: 'The amount reported for this occurrence in the ordered schedule',
  undatedWhatIf: 'Included only in the separate undated-payment comparison, not the dated balance',
  unknownOccurrenceAmount: 'Amount or number of occurrences is unknown',
};

/** Describes unresolved receipt, amount, conversion, and timing details for income. */
export function incomeChecks(record: Fact, occurrence?: MoneyInput): string[] {
  const amounts = occurrence ? [occurrence] : record.schedule.amounts?.length ? record.schedule.amounts : [moneyInput(record.amount)];
  return [record.reliability !== 'reliable' ? record.reliability === 'uncertain' ? 'Receipt is uncertain' : 'Receipt reliability is not confirmed' : null,
    amounts.some(amount => amount.status === 'unknown') ? 'Amount is unknown' : amounts.some(amount => amount.status === 'estimate') ? 'Amount is estimated' : null,
    amounts.some(amount => amount.conversion && (amount.conversion.rateStatus === 'unknown' || amount.conversion.rate === null)) ? 'Exchange rate is unknown' : amounts.some(amount => amount.conversion?.rateStatus === 'estimate') ? 'Exchange rate is estimated' : null,
    amounts.some(amount => amount.conversion && (amount.conversion.feeStatus === 'unknown' || amount.conversion.fee === null)) ? 'INR deduction is unknown' : amounts.some(amount => amount.conversion?.feeStatus === 'estimate') ? 'INR deduction is estimated' : null,
    record.schedule.pattern ? 'Calculated date from your monthly pattern, not confirmed' : record.schedule.date === null ? 'Date is unknown' : record.schedule.certainty !== 'exact' ? 'Date is estimated or unconfirmed' : null,
  ].filter((item): item is string => item !== null);
}

/** Explains a contribution's amount, qualifications, and inclusion in a calculated result. */
function EvidenceRow({ item, snapshot, selected, reason }: { item: Contribution; snapshot: Snapshot; selected: boolean; reason?: string }) {
  const record = snapshot.facts.records.find(record => record.id === item.recordId);
  const event = (snapshot.accepted?.plan ?? snapshot.plan).events.find(event => event.id === item.eventId);
  const checks = record?.kind === 'income' && !item.included ? incomeChecks(record, event ? moneyInput({ amountPaise: event.amountPaise, status: event.amountStatus, source: event.source }) : undefined) : [];
  return <li>
    <strong>{record?.label ?? 'Opening cash'}</strong> · {!event && record?.schedule.amounts?.length ? 'Varies by occurrence' : money(item.amountPaise)}{item.date && <> · {dateLabel(item.date)}</>}
    {event?.source?.conversion && <p>{sourceDescription(event.source)}</p>}
    {event && <p>{amountStatus[event.amountStatus]} amount for this occurrence.</p>}
    {event?.dateAssumption && <p>{event.dateAssumption}</p>}
    {event?.amountBasis === 'budget' && <p>Estimated daily budget share · not a payment due.</p>}
    <p>{selected ? 'Included in this result.' : 'Not counted in this result.'} {reasons[reason ?? item.reason] ?? 'Based on the reported item.'}</p>
    {checks.length > 0 && <p>{checks.join(' · ')}.</p>}
    {item.balancePaise != null && <p>Balance after this item: {money(item.balancePaise)}</p>}
  </li>;
}

/** Presents a result's calculation basis, contributing figures, unresolved checks, and assumptions. */
export function ResultDetails({ result, snapshot, label = 'Why this result?' }: { result: WorkspaceResult; snapshot: Snapshot; label?: string }) {
  const workspace = snapshot.workspace!;
  // Inclusion is result-specific: a receipt can support closing cash yet arrive too late for an earlier gap.
  const included = workspace.contributions!.filter(item => result.contributionIds.includes(item.id));
  const excluded = workspace.contributions!.filter(item => result.excludedIds.includes(item.id));
  const questions = workspace.issues?.filter(item => result.issueIds.includes(item.id)) ?? [];
  return <Details label={label} title={`Why: ${resultLabels[result.id] ?? 'Proposed result'}`} wide>
    <p className="hint">{resultStates[result.state]} · {resultLabels[result.id] ?? 'Proposed result'}</p>
    <p className="result-value">{money(result.amountPaise)}{result.date && <> · {dateLabel(result.date === result.untilDateExclusive ? lastDate(result.date) : result.date)}</>}</p>
    <p>{rules[result.rule] ?? 'A conditional projection using the reported timing and stated assumptions.'}</p>
    <p className="hint">{dateLabel(result.fromDate)} – {dateLabel(lastDate(result.untilDateExclusive))}</p>
    <h3>What contributes</h3>
    {included.length ? <PagedList label="Included figures" className="evidence-list">{included.map(item => <EvidenceRow key={item.id} item={item} snapshot={snapshot} selected />)}</PagedList> : <p>No confirmed contributions to this result yet.</p>}
    {excluded.length > 0 && <><h3>Not counted in this result</h3><PagedList label="Excluded figures" className="evidence-list">{excluded.map(item => <EvidenceRow key={item.id} item={item} snapshot={snapshot} selected={false} reason={result.excludedReasons?.[item.id]} />)}</PagedList></>}
    {questions.length > 0 && <><h3>Still needs checking</h3><PagedList label="Unresolved details" className="evidence-list">{questions.map(item => <li key={item.id}><p>{item.question}</p><p>{item.reason}</p></li>)}</PagedList></>}
    <h3>Assumptions</h3><ul>{result.assumptions.map((item, index) => <li key={item}>{assumptions[item] ?? `Conditional receipt ${index + 1}: arrival must be confirmed.`}</li>)}</ul>
  </Details>;
}

/** Supports resolving conflicting reports with a selected report or a corrected value. */
export function ConflictReview({ conflict, snapshot, blocked, onCommand }: {
  conflict: Conflict; snapshot: Snapshot; blocked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const key = `${snapshot.sessionId}:${snapshot.revision}:${snapshot.sequence}:${open}`;
  const [selection, setSelection] = useState({ key, id: '', other: false, value: '', status: 'exact' as 'exact' | 'estimate' });
  const [amount, setAmount] = useState<MoneyInput>({ amount: '', status: 'exact' });
  if (selection.key !== key) setSelection({ key, id: '', other: false, value: '', status: 'exact' });
  const record = snapshot.facts.records.find(item => item.id === conflict.recordId);
  const label = `${record ? `${record.label} · ` : ''}${fieldLabels[conflict.field]}`;
  /** Describes a conflicting amount or date and its reporting certainty. */
  const valueLabel = (value: Conflict['values'][number]) => `${conflict.field === 'schedule.date'
    ? value.date ? dateLabel(value.date) : 'Date unknown' : amountLabel({ amountPaise: value.amountPaise ?? null, status: value.status, source: value.source })} · ${value.status === 'estimate' ? 'Estimated' : 'Reported'}`;
  const selected = selection.key === key ? conflict.values.find(item => item.id === selection.id) : undefined;
  const valid = selection.other ? conflict.field === 'schedule.date'
    ? /^\d{4}-\d{2}-\d{2}$/.test(selection.value) && Number.isFinite(Date.parse(selection.value)) && new Date(selection.value).toISOString().slice(0, 10) === selection.value
    : amount.status !== 'unknown' && !moneyError(amount, Number.MAX_SAFE_INTEGER) : !!selected;
  return <div className="conflict-row">
    <p><strong>{label}</strong> · Conflicting reports</p>
    <ul>{conflict.values.map((value, index) => <li key={value.id}>Report {index + 1}: {valueLabel(value)}{value.source?.conversion && <p className="hint">{sourceDescription(value.source)}</p>}</li>)}</ul>
    <p className="hint">Neither alternative is treated as confirmed. You can also clarify this by voice.</p>
    <button type="button" disabled={blocked} onClick={() => { setError(''); setOpen(true); }}>Resolve {label}</button>
    <Dialog open={open} title={`Resolve ${label}`} onClose={() => { if (!saving) setOpen(false); }} actions={<button className="primary" disabled={blocked || saving || !valid} onClick={async () => {
      if (blocked || saving || !valid) return;
      setSaving(true); setError('');
      const source = selection.other ? submittedMoney(amount) : selected?.source ?? { amount: selected?.amountPaise == null ? null : decimal(selected.amountPaise), status: selected!.status };
      const value: components['schemas']['ConflictValueInput'] = conflict.field === 'schedule.date'
        ? { id: selection.other ? crypto.randomUUID() : selected!.id, status: selection.other ? selection.status : selected!.status, date: selection.other ? selection.value : selected!.date }
        : { ...source, id: selection.other ? crypto.randomUUID() : selected!.id, status: source.status === 'estimate' ? 'estimate' : 'exact' };
      const saved = await onCommand({ type: 'updateFacts', changes: { expectedRevision: snapshot.revision, resolutions: [{ conflictId: conflict.id, value }] } }).catch(() => undefined);
      setSaving(false);
      if (saved) setOpen(false);
      else setError('Resolution not confirmed. Your entry is kept; check the save status before retrying.');
    }}>{selection.other ? 'Confirm entered value' : 'Confirm selected report'}</button>}>
      <fieldset className="money-edit-fields" disabled={blocked || saving}><legend>Which report should the plan use?</legend>
        {conflict.values.map((value, index) => <label className="check" key={value.id}><input type="radio" name={`resolve-${conflict.id}`} checked={!selection.other && selected?.id === value.id}
          onChange={() => setSelection({ ...selection, key, id: value.id, other: false })} />Report {index + 1}: {valueLabel(value)}</label>)}
        <label className="check"><input type="radio" name={`resolve-${conflict.id}`} checked={selection.other} onChange={() => {
          const source = selected?.source ?? conflict.values.find(value => value.source?.conversion)?.source;
          setAmount({ ...(source ? structuredClone(source) : {}), amount: '', status: source?.status === 'estimate' ? 'estimate' : 'exact' });
          setSelection({ ...selection, key, id: '', other: true });
        }} />Neither report — enter the correct value</label>
        {selection.other && <>
          {conflict.field === 'schedule.date' ? <>
            <label>Correct date<input type="date" value={selection.value} onChange={event => setSelection({ ...selection, value: event.target.value })} /></label>
            <label>Value certainty<select value={selection.status} onChange={event => setSelection({ ...selection, status: event.target.value as 'exact' | 'estimate' })}><option value="exact">Confirmed</option><option value="estimate">Estimated</option></select></label>
          </> : <MoneyFields value={amount} income={record?.kind === 'income' && conflict.field === 'amount'} allowUnknown={false} label="Correct amount (₹)" certaintyLabel="Value certainty" onChange={value => setAmount(value!)} />}
        </>}
      </fieldset>{error && <p role="alert">{error}</p>}<p>The picture changes only after this is saved. No payment is made.</p>
    </Dialog>
  </div>;
}
