// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../src/api';
import { FinancialContext } from '../src/FinancialContext';
import { MoneyChanges } from '../src/MoneyChanges';
import { MoneyOverview } from '../src/MoneyOverview';
import { MoneyPrint } from '../src/MoneyPrint';
import { RecordRow } from '../src/MoneyRecords';
import { ConflictReview, ResultDetails } from '../src/WorkspaceDetails';
import { choiceSnapshot, planningSnapshot, scenario, settings } from './fixtures';
import { projectWorkspace } from './workspace';

it.each([false, true])('excludes payee enquiries from spending comparisons (mixed: %s)', mixed => {
  const saved = choiceSnapshot();
  saved.workspace!.choices = [...(mixed ? saved.workspace!.choices! : []), {
    id: 'enquire:rent', kind: 'enquire', eventIds: ['rent:2026-09-13'], prerequisiteIds: [], adjustmentAmounts: [], consequenceIds: [],
    affectsFirstGap: false, affectsPeakGap: false, laterOnly: false,
  }];
  render(<MoneyChanges snapshot={saved} settings={settings} active blocked={false} pending={false} onCommand={vi.fn()} />);
  const suggestions = within(screen.getByRole('region', { name: 'Suggested plan changes' }));
  expect(suggestions.queryAllByRole('button', { name: 'Compare' })).toHaveLength(mixed ? 1 : 0);
  if (mixed) expect(suggestions.getByRole('heading', { name: 'Optional purchase' })).toBeVisible();
  else expect(suggestions.getByRole('heading', { name: 'No suggested changes' })).toBeVisible();
});

it.each([false, true])('preserves reserve risk on the overview and print (cash gap: %s)', cashGap => {
  const saved = planningSnapshot();
  saved.facts.reservePaise = 500000;
  saved.plan.reserveShortfallPaise = 200000;
  saved.plan.firstGap = cashGap ? { date: '2026-09-13', amountPaise: 100000 } : null;
  saved.plan.peakGapPaise = cashGap ? 100000 : 0;
  saved.plan.peakGapDate = cashGap ? '2026-09-13' : null;
  saved.plan.projectionPartial = false;
  saved.plan.decisionAssessment!.consequences = [
    ...(cashGap ? [{ id: 'cash:2026-09-13', kind: 'cashExposure' as const, eventIds: ['rent:2026-09-13'], date: '2026-09-13', amountPaise: 100000 }] : []),
    { id: 'reserve:breach', kind: 'reserveBreach', eventIds: [], date: '2026-09-13', amountPaise: 100000 },
  ];
  saved.plan.decisionAssessment!.outcome = { ...saved.plan.decisionAssessment!.outcome!, branch: cashGap ? 'gap' : 'uncertain',
    summary: cashGap ? 'Rent needs ₹1,000 on 13 Sept; the cash buffer is also at risk.' : 'Dated payments fit, but the cash buffer is not protected.' };
  if (!cashGap) { saved.plan.decisionAssessment!.nextActionId = null; saved.workspace!.actions = []; }
  render(<MemoryRouter><MoneyOverview snapshot={saved} blocked={false} onEdit={vi.fn()} onChecks={vi.fn()} onCommand={vi.fn()} /><MoneyPrint snapshot={saved} /></MemoryRouter>);
  const overview = screen.getByRole('region', { name: 'What needs attention' });
  expect(overview).toHaveTextContent('Cash buffer at risk: ₹1,000 below your ₹5,000 buffer · 13 Sept. Largest buffer shortfall: ₹2,000. Separate from payment shortfalls.');
  expect(overview).not.toHaveTextContent('Some details still need checking');
  expect(within(overview).getByRole('heading', { name: saved.plan.decisionAssessment!.outcome.summary })).toBeVisible();
  if (cashGap) expect(within(overview).getByLabelText('First shortfall')).toHaveTextContent('₹1,000First shortfall · 13 Sept');
  else expect(within(overview).queryByLabelText('First shortfall')).not.toBeInTheDocument();
  const printed = document.querySelector('.money-print')!;
  expect(printed.querySelector('.plan-reserve')).toHaveTextContent('Cash buffer at risk: ₹1,000 below your ₹5,000 buffer · 13 Sept. Largest buffer shortfall: ₹2,000. Separate from payment shortfalls.');
  expect(printed.querySelector('.plan-reserve')).not.toHaveTextContent('₹2,000 below your ₹5,000 buffer · 13 Sept');
  expect(printed).not.toHaveTextContent('No gap in the dated figures');
});

it('shows only accepted occurrence amounts beside unchanged reported facts', () => {
  const saved = choiceSnapshot('cardMinimum');
  const record = saved.facts.records.find(item => item.kind === 'debt')!;
  const event = saved.plan.events.find(item => item.recordId === record.id)!;
  saved.accepted = scenario('accepted');
  saved.accepted.plan.events = [{ ...event, amountPaise: 250000, amountBasis: 'assumed' }];
  saved.preview = scenario('preview');
  saved.preview.plan.events = [{ ...event, amountPaise: 225000, amountBasis: 'assumed' }];
  const { rerender } = render(<RecordRow record={record} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('listitem')).toHaveTextContent('Intended · includes minimum₹4,000.00');
  expect(screen.getByRole('listitem')).toHaveTextContent('Current plan: ₹2,500.00 on 26 Sept 2026 · Saved assumption, not paid');
  expect(screen.getByRole('listitem')).not.toHaveTextContent('₹2,250.00');
  rerender(<RecordRow record={record} snapshot={{ ...saved, accepted: null }} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('listitem')).not.toHaveTextContent('Current plan:');
  expect(record.target!.amountPaise).toBe(400000);
});

it('keeps estimated minimum-only and automatic-debit qualifiers in the live timeline', () => {
  const saved = choiceSnapshot('cardMinimum');
  const card = saved.facts.records.find(item => item.kind === 'debt')!;
  card.amount.status = 'estimate'; card.target = { amountPaise: null, status: 'unknown' }; card.autoDebit = true;
  saved.plan.events = saved.plan.events.filter(item => item.recordId === card.id).map(item => ({ ...item, amountPaise: card.amount.amountPaise, amountBasis: 'requiredOnly', amountStatus: 'estimate', requiredPaise: card.amount.amountPaise, requiredStatus: 'estimate', autoDebit: true }));
  render(<FinancialContext snapshot={projectWorkspace(saved)} locked={false} stale={false} proposalActive onCommand={vi.fn().mockResolvedValue(saved)} />);
  const row = within(screen.getByRole('article', { name: 'Commitments & income' })).getByRole('listitem', { name: card.label });
  expect(within(row).getByRole('button', { name: `Edit ${card.label} required amount` })).toHaveTextContent('Est.');
  expect(within(row).getByRole('button', { name: `Edit ${card.label} target` })).toHaveTextContent('Unknown');
  expect(row.querySelector('.card-record-amount')).toHaveTextContent('Minimum payment−₹2,000');
  expect(row.querySelector('.card-secondary')).toHaveTextContent('Intended paymentUnknown');
  expect(row).toHaveTextContent('Auto-debit');
});

it('keeps a pending inline cash edit open and prevents another submission', async () => {
  const saved = planningSnapshot();
  const receipt = structuredClone(saved); receipt.revision++; receipt.sequence++; receipt.facts.opening.amountPaise = 600000;
  let confirm!: (value: Snapshot) => void;
  const onCommand = vi.fn(() => new Promise<Snapshot>(resolve => { confirm = resolve; }));
  render(<FinancialContext snapshot={saved} locked={false} stale={false} proposalActive onCommand={onCommand} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit Cash at plan start' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Cash at plan start' }), { target: { value: '6000' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  expect(screen.getByRole('form', { name: 'Edit Cash at plan start' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save Cash at plan start' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save Cash at plan start' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: saved.revision, opening: { amount: '6000', status: 'exact' } } });
  await act(async () => { confirm(receipt); });
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit Cash at plan start' })).toHaveFocus();
});

it.each(['amount', 'schedule.date'] as const)('resolves %s with another reported value and preserves estimate certainty after rejection', async field => {
  const saved = planningSnapshot();
  const conflict = { id: `conflict:rent:${field}`, recordId: 'rent', field, values: field === 'amount'
    ? [{ id: 'a', amountPaise: 1200000, status: 'exact' as const }, { id: 'b', amountPaise: 1250000, status: 'exact' as const }]
    : [{ id: 'a', date: '2026-09-13', status: 'exact' as const }, { id: 'b', date: '2026-09-15', status: 'exact' as const }] };
  const onCommand = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(saved);
  render(<ConflictReview snapshot={saved} conflict={conflict} blocked={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole('button', { name: /^Resolve Rent/ }));
  await userEvent.click(screen.getByRole('radio', { name: 'Neither report — enter the correct value' }));
  expect(screen.getByRole('button', { name: 'Confirm entered value' })).toBeDisabled();
  const input = screen.getByLabelText(field === 'amount' ? 'Correct amount (₹)' : 'Correct date');
  if (field === 'amount') {
    await userEvent.type(input, '-1');
    expect(screen.getByRole('button', { name: 'Confirm entered value' })).toBeDisabled();
    await userEvent.clear(input); await userEvent.type(input, '12250');
  } else {
    fireEvent.change(input, { target: { value: '2026-09-14' } });
  }
  await userEvent.selectOptions(screen.getByLabelText('Value certainty'), 'estimate');
  await userEvent.click(screen.getByRole('button', { name: 'Confirm entered value' }));
  expect(input).toHaveValue(field === 'amount' ? '12250' : '2026-09-14');
  expect(screen.getByRole('alert')).toHaveTextContent('Your entry is kept');
  await userEvent.click(screen.getByRole('button', { name: 'Confirm entered value' }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: 'updateFacts', changes: { expectedRevision: saved.revision,
    resolutions: [{ conflictId: conflict.id, value: { id: expect.any(String), status: 'estimate', ...(field === 'amount' ? { amount: '12250' } : { date: '2026-09-14' }) } }],
  } });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('resets third-value confirmation when the saved revision changes', async () => {
  const saved = planningSnapshot();
  const conflict = { id: 'conflict:rent:amount', recordId: 'rent', field: 'amount' as const,
    values: [{ id: 'a', amountPaise: 1200000, status: 'exact' as const }, { id: 'b', amountPaise: 1250000, status: 'exact' as const }] };
  const onCommand = vi.fn();
  const { rerender } = render(<ConflictReview snapshot={saved} conflict={conflict} blocked={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole('button', { name: /^Resolve Rent/ }));
  await userEvent.click(screen.getByRole('radio', { name: 'Neither report — enter the correct value' }));
  await userEvent.type(screen.getByLabelText('Correct amount (₹)'), '12250');
  rerender(<ConflictReview snapshot={{ ...saved, revision: saved.revision + 1 }} conflict={conflict} blocked={false} onCommand={onCommand} />);
  expect(screen.getByRole('button', { name: 'Confirm selected report' })).toBeDisabled();
  expect(onCommand).not.toHaveBeenCalled();
});

it('labels estimated calculations in the live card and its explanation', async () => {
  const saved = planningSnapshot();
  const result = saved.workspace!.results!.find(item => item.id === 'closing')!;
  result.state = 'estimated';
  saved.plan.projectionPartial = true;
  result.qualifications = ['Uses estimated Rent (INR 12000.00).'];
  saved.facts.records[0].amount.status = 'estimate'; saved.plan.events[0].amountStatus = 'estimate';
  const { unmount } = render(<FinancialContext snapshot={saved} locked={false} stale={false} proposalActive onCommand={vi.fn().mockResolvedValue(saved)} />);
  const status = screen.getByRole('region', { name: 'Financial status' });
  expect(within(status).getByLabelText('Projected closing cash')).toHaveTextContent('Includes estimates');
  expect(status).toHaveTextContent('Dates and remaining costs can change this picture. Not a spending allowance.');
  expect(status).not.toHaveTextContent('Uses estimated Rent (INR 12000.00).');
  unmount();
  render(<ResultDetails snapshot={saved} result={result} />);
  await userEvent.click(screen.getByRole('button', { name: 'Why this result?' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Calculated · Estimated · Projected closing cash');
});