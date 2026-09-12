// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { Command, Snapshot } from './api';
import type { components } from './contracts';
import { Details, Dialog } from './Dialog';
import { dateLabel, decimal, lastDate, money, parseAmount } from './money';
import { PagedList } from './PagedList';

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
  datedOutflow: 'Dated payments', closing: 'Projected closing cash', trough: 'Lowest projected balance',
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
  sumKnownDatedOutflow: 'Known payments with dates within these 30 days. Undated commitments are not included.',
  openingPlusIncludedIncomeMinusIncludedOutflow: 'Opening cash plus included income, less included payments. Closing cash is not spare spending money.',
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
};
export const reasons: Record<string, string> = {
  reportedOpening: 'Reported opening cash', unknownOpening: 'Opening cash is unknown', reported: 'Reported amount',
  requiredOnly: 'Known required payment only', target: 'Selected target, including the minimum',
  acceptedAssumption: 'Saved assumption, not paid', proposedAssumption: 'Proposed assumption, not saved',
  unknownAmount: 'Amount is unknown', conditionalReceipt: 'Receipt is not confirmed enough to count on',
  approximateOutflowDate: 'Payment date is estimated', unknownDate: 'Date is unknown; not in dated balances',
  pastReceipt: 'Receipt is before this plan; not added again', outsideHorizon: 'Outside these 30 days',
  approximateDateOutsideWindow: 'Date is estimated outside these 30 days; it could fall inside the plan',
  afterResultPoint: 'After the point measured by this result; cannot cover that earlier cash gap',
  countedReliableIncome: 'Already counted as reliable income; not counted again as uncertain income',
};

export function incomeChecks(record: Fact): string[] {
  return [record.reliability !== 'reliable' ? record.reliability === 'uncertain' ? 'Receipt is uncertain' : 'Receipt reliability is not confirmed' : null,
    record.amount.status !== 'exact' ? record.amount.amountPaise === null ? 'Amount is unknown' : 'Amount is estimated' : null,
    record.schedule.date === null ? 'Date is unknown' : record.schedule.certainty !== 'exact' ? 'Date is estimated or unconfirmed' : null,
  ].filter((item): item is string => item !== null);
}

function EvidenceRow({ item, snapshot, selected, reason }: { item: Contribution; snapshot: Snapshot; selected: boolean; reason?: string }) {
  const record = snapshot.facts.records.find(record => record.id === item.recordId);
  const checks = record?.kind === 'income' && !item.included ? incomeChecks(record) : [];
  return <li>
    <strong>{record?.label ?? 'Opening cash'}</strong> · {money(item.amountPaise)}{item.date && <> · {dateLabel(item.date)}</>}
    <p>{selected ? 'Included in this result.' : 'Not counted in this result.'} {reasons[reason ?? item.reason] ?? 'Based on the reported item.'}</p>
    {checks.length > 0 && <p>{checks.join(' · ')}.</p>}
    {item.balancePaise != null && <p>Balance after this item: {money(item.balancePaise)}</p>}
  </li>;
}

export function ResultDetails({ result, snapshot, label = 'Why this result?' }: { result: WorkspaceResult; snapshot: Snapshot; label?: string }) {
  const workspace = snapshot.workspace!;
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

export function ConflictReview({ conflict, snapshot, blocked, onCommand }: {
  conflict: Conflict; snapshot: Snapshot; blocked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const key = `${snapshot.sessionId}:${snapshot.revision}:${snapshot.sequence}:${open}`;
  const [selection, setSelection] = useState({ key, id: '', other: false, value: '', status: 'exact' as 'exact' | 'estimate' });
  if (selection.key !== key) setSelection({ key, id: '', other: false, value: '', status: 'exact' });
  const record = snapshot.facts.records.find(item => item.id === conflict.recordId);
  const label = `${record ? `${record.label} · ` : ''}${fieldLabels[conflict.field]}`;
  const valueLabel = (value: Conflict['values'][number]) => `${conflict.field === 'schedule.date'
    ? value.date ? dateLabel(value.date) : 'Date unknown' : money(value.amountPaise ?? null)} · ${value.status === 'estimate' ? 'Estimated' : 'Reported'}`;
  const selected = selection.key === key ? conflict.values.find(item => item.id === selection.id) : undefined;
  const valid = selection.other ? conflict.field === 'schedule.date'
    ? /^\d{4}-\d{2}-\d{2}$/.test(selection.value) && Number.isFinite(Date.parse(selection.value)) && new Date(selection.value).toISOString().slice(0, 10) === selection.value
    : parseAmount(selection.value, Number.MAX_SAFE_INTEGER) !== null : !!selected;
  return <div className="conflict-row">
    <p><strong>{label}</strong> · Conflicting reports</p>
    <ul>{conflict.values.map((value, index) => <li key={value.id}>Report {index + 1}: {valueLabel(value)}</li>)}</ul>
    <p className="hint">Neither alternative is treated as confirmed. You can also clarify this by voice.</p>
    <button type="button" disabled={blocked} onClick={() => { setError(''); setOpen(true); }}>Resolve {label}</button>
    <Dialog open={open} title={`Resolve ${label}`} onClose={() => { if (!saving) setOpen(false); }} actions={<button className="primary" disabled={blocked || saving || !valid} onClick={async () => {
      if (blocked || saving || !valid) return;
      setSaving(true); setError('');
      const value = selection.other
        ? { id: crypto.randomUUID(), status: selection.status, ...(conflict.field === 'schedule.date' ? { date: selection.value } : { amount: selection.value }) }
        : { id: selected!.id, status: selected!.status, ...(conflict.field === 'schedule.date'
          ? { date: selected!.date } : { amount: selected!.amountPaise == null ? null : decimal(selected!.amountPaise) }) };
      const saved = await onCommand({ type: 'updateFacts', changes: { expectedRevision: snapshot.revision, resolutions: [{ conflictId: conflict.id, value }] } }).catch(() => undefined);
      setSaving(false);
      if (saved) setOpen(false);
      else setError('Resolution not confirmed. Your entry is kept; check the save status before retrying.');
    }}>{selection.other ? 'Confirm entered value' : 'Confirm selected report'}</button>}>
      <fieldset disabled={blocked || saving}><legend>Which report should the plan use?</legend>
        {conflict.values.map((value, index) => <label className="check" key={value.id}><input type="radio" name={`resolve-${conflict.id}`} checked={!selection.other && selected?.id === value.id}
          onChange={() => setSelection({ ...selection, key, id: value.id, other: false })} />Report {index + 1}: {valueLabel(value)}</label>)}
        <label className="check"><input type="radio" name={`resolve-${conflict.id}`} checked={selection.other} onChange={() => setSelection({ ...selection, key, id: '', other: true })} />Neither report — enter the correct value</label>
        {selection.other && <>
          <label>{conflict.field === 'schedule.date' ? 'Correct date' : 'Correct amount (₹)'}<input type={conflict.field === 'schedule.date' ? 'date' : 'text'} inputMode={conflict.field === 'schedule.date' ? undefined : 'decimal'} value={selection.value} onChange={event => setSelection({ ...selection, value: event.target.value })} /></label>
          <label>Value certainty<select value={selection.status} onChange={event => setSelection({ ...selection, status: event.target.value as 'exact' | 'estimate' })}><option value="exact">Confirmed</option><option value="estimate">Estimated</option></select></label>
        </>}
      </fieldset>{error && <p role="alert">{error}</p>}<p>The picture changes only after this is saved. No payment is made.</p>
    </Dialog>
  </div>;
}

export function Correction({ snapshot, record, blocked, onCommand }: {
  snapshot: Snapshot; record?: Fact; blocked: boolean; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(snapshot.revision);
  const [field, setField] = useState(record ? 'amount' : 'opening');
  const [value, setValue] = useState('');
  const [certainty, setCertainty] = useState<'exact' | 'estimate' | 'unknown'>('exact');
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (open || blocked || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body) trigger.current?.focus({ preventScroll: true });
  }, [open, blocked]);
  const fields = record ? ['amount', 'schedule.date', ...(record.kind === 'income' ? ['reliability'] : ['controllability']),
    ...(record.kind === 'debt' ? ['target', 'outstanding'] : []), 'delete'] : ['opening'];
  const disputed = (name: string) => snapshot.facts.conflicts!.some(item => item.recordId === (record?.id ?? null) && item.field === name);
  const disabled = blocked || saving || revision !== snapshot.revision || disputed(field);
  function select(name: string) {
    setField(name); setError('');
    if (name === 'schedule.date') { setValue(record!.schedule.date ?? ''); setCertainty(record!.schedule.certainty); }
    else if (name === 'reliability' || name === 'controllability') setValue(record?.[name] ?? 'unknown');
    else if (name !== 'delete') {
      const amount = record ? record[name as 'amount' | 'target' | 'outstanding'] : snapshot.facts.opening;
      setValue(amount?.amountPaise == null ? '' : decimal(amount.amountPaise)); setCertainty(amount?.status ?? 'unknown');
    }
  }
  return <><button ref={trigger} type="button" className="detail-button" disabled={blocked} onClick={() => {
    setRevision(snapshot.revision); select(fields.find(name => !disputed(name)) ?? fields[0]); setOpen(true);
  }}>Correct {record?.label ?? 'available cash'}</button>
    <Dialog open={open} title={`Correct ${record?.label ?? 'available cash'}`} onClose={() => setOpen(false)} actions={<button type="submit" form={`correct-${record?.id ?? 'cash'}`} className="primary" disabled={disabled}>Save correction</button>}>
      <p>Correct this reported detail here or by voice. Other figures stay unchanged.</p>
      {revision !== snapshot.revision && <p role="alert">Saved figures changed. Close and reopen this correction to check the current values.</p>}
      <form id={`correct-${record?.id ?? 'cash'}`} onSubmit={async event => {
        event.preventDefault(); if (disabled) return;
        const patch: components['schemas']['RecordPatch'] = { id: record?.id, delete: false, distinct: false };
        let opening: components['schemas']['MoneyInput'] | undefined;
        if (field === 'delete') patch.delete = true;
        else if (field === 'schedule.date') patch.schedule = { date: value || null, certainty: value ? certainty === 'unknown' ? 'exact' : certainty : 'unknown' };
        else if (field === 'reliability' || field === 'controllability') Object.assign(patch, { [field]: value });
        else {
          if (certainty !== 'unknown' && parseAmount(value, Number.MAX_SAFE_INTEGER) === null) { setError('Enter a non-negative rupee amount with at most two decimal places.'); return; }
          const amount = { amount: certainty === 'unknown' ? null : value, status: certainty };
          if (field === 'opening') opening = amount; else Object.assign(patch, { [field]: amount });
        }
        setSaving(true); setError('');
        const saved = await onCommand({ type: 'updateFacts', changes: { expectedRevision: revision, ...(opening ? { opening } : { records: [patch] }) } }).catch(() => undefined);
        setSaving(false);
        if (saved) { restoreFocus.current = true; setOpen(false); }
        else setError('Correction not confirmed. Your entry is kept; check the save status before retrying.');
      }}>
        <fieldset disabled={blocked || saving || revision !== snapshot.revision}><legend className="sr-only">Correction</legend>
          <label>Detail<select value={field} onChange={event => select(event.target.value)}>{fields.map(name => <option key={name} value={name} disabled={disputed(name)}>{name === 'delete' ? 'Remove this item' : fieldLabels[name]}</option>)}</select></label>
          {disputed(field) ? <p>Resolve the conflicting reports instead of overwriting this field.</p> : field === 'delete' ? <p>Remove <strong>{record?.label}</strong> from the plan? This removes this exact item, not other items with the same name.</p>
            : field === 'reliability' || field === 'controllability' ? <label>{fieldLabels[field]}<select value={value} onChange={event => setValue(event.target.value)}>
              <option value="unknown">Not confirmed</option>{field === 'reliability' ? <><option value="reliable">Reliable</option><option value="uncertain">Uncertain</option></> : <><option value="controllable">Changeable and not committed</option><option value="committed">Already committed</option></>}
            </select></label> : <>
              <label>{field === 'schedule.date' ? 'Date' : 'Amount (₹)'}<input type={field === 'schedule.date' ? 'date' : 'text'} inputMode={field === 'schedule.date' ? undefined : 'decimal'} value={value} disabled={disputed(field)} onChange={event => {
                setValue(event.target.value); if (field === 'schedule.date') setCertainty(event.target.value ? certainty === 'estimate' ? 'estimate' : 'exact' : 'unknown');
              }} /></label>
              <label>{field === 'schedule.date' ? 'Date certainty' : 'Amount certainty'}<select value={certainty} onChange={event => setCertainty(event.target.value as typeof certainty)}>
                <option value="unknown" disabled={field === 'schedule.date' && !!value}>Unknown</option><option value="exact" disabled={field === 'schedule.date' && !value}>Confirmed</option><option value="estimate" disabled={field === 'schedule.date' && !value}>Estimated</option>
              </select></label>
            </>}
        </fieldset>{error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  </>;
}