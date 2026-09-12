// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../src/api';
import { FinancialContext } from '../src/FinancialContext';
import { FinalPlan } from '../src/FinalPlan';
import { ExchangeValues, MoneySources } from '../src/MoneyValues';
import { ResultDetails } from '../src/WorkspaceDetails';
import { MoneyEvent } from '../src/MoneyUpcoming';
import { PlanningPossibilities } from '../src/PlanningPossibilities';
import { RecordRow } from '../src/MoneyRecords';
import { planningSnapshot, scenario } from './fixtures';

/** Supplies distinct historical and current rates and amounts without calculating FX. */
function exchangeSnapshot(): Snapshot {
  const saved = planningSnapshot();
  saved.facts.records[0].amount = { amountPaise: 400000, status: 'estimate', source: { amount: '50', status: 'exact',
    conversion: { currency: 'USD', rate: '80', rateStatus: 'estimate', rateDate: '2026-09-10', provider: 'frankfurter', fetchedAt: '2026-09-11T08:00:00Z', fee: null, feeStatus: 'unknown', direction: 'payment' } } };
  saved.plan.events[0] = { ...saved.plan.events[0], amountPaise: 420000, amountStatus: 'estimate', source: { ...saved.facts.records[0].amount.source!,
    conversion: { ...saved.facts.records[0].amount.source!.conversion!, rate: '84', rateDate: '2026-09-11', fetchedAt: '2026-09-13T08:00:00Z' } } };
  saved.plan.planningFacts = structuredClone(saved.facts);
  saved.plan.planningFacts.records[0].amount = { amountPaise: 420000, status: 'estimate', source: structuredClone(saved.plan.events[0].source) };
  saved.plan.exchangeCheckedOn = '2026-09-13';
  saved.plan.exchangeRates = { USD: { base: 'USD', quote: 'INR', rate: '84', date: '2026-09-11', fetchedAt: '2026-09-13T08:00:00Z' } };
  saved.workspace!.cards = [{ id: 'timeline', template: 'timeline', title: 'Commitments', section: 'timeline', state: 'estimated', recordIds: ['rent'], eventIds: [saved.plan.events[0].id] }];
  return saved;
}

it.each([false, true])('uses current record planningFacts for FX, retaining capture and fees in Details (accepted %s)', async accepted => {
  const saved = exchangeSnapshot();
  if (accepted) {
    saved.accepted = { ...scenario('accepted'), plan: structuredClone(saved.plan) };
    saved.accepted.plan.planningFacts.records[0].amount.amountPaise = 440000;
    saved.accepted.plan.events[0].amountPaise = 430000;
    saved.accepted.plan.events[0].amountBasis = 'assumed';
  }
  saved.preview = { ...scenario('preview'), plan: structuredClone(saved.plan) };
  saved.preview.plan.planningFacts.records[0].amount.amountPaise = 990000;
  const original = structuredClone(saved); const onEdit = vi.fn();
  render(<RecordRow record={saved.facts.records[0]} snapshot={saved} blocked={false} onEdit={onEdit} onCommand={vi.fn()} />);
  const amount = screen.getByRole('button', { name: 'Edit Rent amount' });
  expect(amount).toHaveTextContent(accepted ? '₹4,400.00' : '₹4,200.00');
  expect(screen.getByText('USD 50 · INR estimate')).toBeVisible();
  expect(screen.getByText('Estimated', { exact: true })).toBeVisible();
  expect(screen.getByText('Conversion fees unknown · not included')).toBeVisible();
  expect(screen.getByText('Captured INR: ₹4,000.00')).not.toBeVisible();
  expect(screen.queryByText(/₹9,900/)).not.toBeInTheDocument();
  await userEvent.click(amount);
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ recordId: 'rent', field: 'amount' });
  await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  const details = screen.getByRole('dialog', { name: 'Details for Rent' });
  expect(within(details).getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(within(details).getByText(/Today’s approximate INR:/)).toHaveTextContent(accepted ? '₹4,400.00' : '₹4,200.00');
  expect(within(details).getByText(/fees are not assumed to be zero/)).toBeVisible();
  expect(within(details).getByText(/Captured conversion/)).not.toBeVisible();
  await userEvent.click(within(details).getByText('Exchange rate details', { selector: 'summary' }));
  expect(within(details).getByText(/Captured conversion/)).toHaveTextContent('₹80 per 1 USD');
  expect(within(details).getByText(/Planning conversion/)).toHaveTextContent('₹84 per 1 USD');
  expect(within(details).getByText(/Planning rate retrieved/)).toHaveTextContent('13 Sept 2026');
  if (accepted) expect(within(details).getByText(/Accepted occurrence amount:/)).toHaveTextContent('₹4,300.00');
  expect(saved).toEqual(original);
});

it('does not substitute captured INR or event money when a compact record current FX valuation is unavailable', async () => {
  const saved = exchangeSnapshot();
  const current = saved.plan.planningFacts.records[0].amount;
  current.amountPaise = null; current.status = 'unknown';
  current.source!.conversion = { ...current.source!.conversion!, rate: null, rateStatus: 'unknown', rateDate: null, fetchedAt: null };
  saved.plan.exchangeRates = {};
  render(<RecordRow record={saved.facts.records[0]} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  const amount = screen.getByRole('button', { name: 'Edit Rent amount' });
  expect(amount).toHaveTextContent('Unknown'); expect(amount).not.toHaveTextContent(/₹4,000|₹4,200|₹0.00/);
  expect(screen.getByText('USD 50 · INR estimate')).toBeVisible();
  expect(screen.getByText('INR estimate unavailable')).toBeVisible();
  expect(screen.getByText('Captured INR: ₹4,000.00')).not.toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  const details = screen.getByRole('dialog');
  expect(within(details).getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(within(details).getByText(/Today’s approximate INR:/)).toHaveTextContent('Unknown');
  expect(within(details).getByText(/Automatic retry is next day/)).toBeVisible();
  expect(within(details).queryByRole('button', { name: /retry|refresh|fetch/i })).not.toBeInTheDocument();
});

it('shows captured and current INR separately with folded reference dates and provenance', async () => {
  const saved = exchangeSnapshot();
  const original = structuredClone(saved);
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  expect(within(row).getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('USD 50');
  expect(within(row).getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(within(row).getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00');
  expect(within(row).getByText(/excludes unknown conversion fees/)).toBeVisible();
  expect(row).not.toHaveTextContent(/Net INR|INR cost/);
  const capture = within(row).getByText(/Captured conversion/);
  expect(capture).not.toBeVisible();
  await userEvent.click(within(row).getByText('Exchange rate details', { selector: 'summary' }));
  expect(capture).toBeVisible();
  expect(capture).toHaveTextContent('₹80 per 1 USD · Frankfurter reference estimate · as of 10 Sept 2026');
  expect(within(row).getByText(/Planning conversion/)).toHaveTextContent('₹84 per 1 USD · Frankfurter reference estimate · as of 11 Sept 2026');
  expect(within(row).getByText(/Captured rate retrieved/)).toHaveTextContent('11 Sept 2026');
  expect(within(row).getByText(/Planning rate retrieved/)).toHaveTextContent('13 Sept 2026');
  expect(within(row).getByText(/Exchange checked on/)).toHaveTextContent('13 Sept 2026');
  expect(within(row).getByText(/not actual bank rates or net quotes/)).toBeVisible();
  expect(saved).toEqual(original);
});

it('keeps history and original currency when today’s provider rate is unavailable without offering a fetch', () => {
  const saved = exchangeSnapshot();
  saved.plan.exchangeRates = {};
  saved.plan.events[0].amountPaise = null;
  saved.plan.events[0].amountStatus = 'unknown';
  saved.plan.events[0].source!.conversion = { ...saved.plan.events[0].source!.conversion!, rate: null, rateStatus: 'unknown', rateDate: null, fetchedAt: null };
  saved.plan.planningFacts.records[0].amount = { amountPaise: null, status: 'unknown', source: structuredClone(saved.plan.events[0].source) };
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  expect(row).toHaveTextContent('USD 50');
  expect(within(row).getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(within(row).getByText(/Today’s approximate INR:/)).toHaveTextContent('Unknown');
  expect(within(row).getByText(/Exchange rate unavailable; conversion needs retry/)).toBeVisible();
  expect(row).toHaveTextContent('Automatic retry is next day');
  expect(within(row).queryByRole('button', { name: /retry|fetch|refresh/i })).not.toBeInTheDocument();
  expect(row).not.toHaveTextContent('₹4,200');
});

it('uses accepted planning values rather than base or preview values', () => {
  const saved = exchangeSnapshot();
  saved.accepted = { ...scenario('accepted'), plan: structuredClone(saved.plan) };
  saved.accepted.plan.events[0].amountPaise = 430000;
  saved.accepted.plan.events[0].amountBasis = 'assumed';
  saved.accepted.plan.planningFacts.records[0].amount.amountPaise = 440000;
  saved.preview = { ...scenario(), plan: structuredClone(saved.plan) };
  saved.preview.plan.events[0].amountPaise = 990000;
  render(<MoneySources record={saved.facts.records[0]} snapshot={saved} />);
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,400.00');
  expect(screen.getByText(/Accepted occurrence amount:/)).toHaveTextContent('₹4,300.00');
  expect(screen.getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(screen.queryByText(/₹9,900/)).not.toBeInTheDocument();
});

it('uses normalized current INR for undated amounts without deriving it from a rate map', () => {
  const saved = exchangeSnapshot(); saved.plan.events = [];
  render(<MoneySources record={saved.facts.records[0]} snapshot={saved} />);
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00');
  expect(screen.queryByText(/No dated occurrence available/)).not.toBeInTheDocument();
  expect(screen.getByText('Captured INR: ₹4,000.00')).toBeVisible();
});

it('uses supplied daily-budget INR and reference metadata without inventing a provider failure', async () => {
  const saved = exchangeSnapshot();
  saved.plan.events[0] = { ...saved.plan.events[0], source: null, amountBasis: 'budget', amountPaise: 14000 };
  saved.facts.records[0].schedule.recurrence = 'monthlyBudget';
  render(<MoneySources record={saved.facts.records[0]} snapshot={saved} />);
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00 · Full monthly amount');
  expect(screen.getByText(/Daily forecast share:/)).toHaveTextContent('₹140.00');
  expect(screen.queryByText(/Exchange rate unavailable/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('Exchange rate details', { selector: 'summary' }));
  expect(screen.getByText(/Planning conversion/)).toHaveTextContent('₹84 per 1 USD');
});

it.each(['known fee', 'valuation'] as const)('does not claim excluded unknown fees for %s', kind => {
  const saved = exchangeSnapshot();
  const source = saved.facts.records[0].amount.source!;
  if (kind === 'known fee') source.conversion = { ...source.conversion!, fee: '0', feeStatus: 'exact' };
  else source.conversion = { ...source.conversion!, direction: 'valuation' };
  saved.plan.events[0].source = structuredClone(source);
  render(<ExchangeValues source={source} capturedPaise={400000} currentMoney={{ amountPaise: 420000, status: 'estimate', source }} event={saved.plan.events[0]} plan={saved.plan} />);
  expect(screen.queryByText(/excludes unknown conversion fees/)).not.toBeInTheDocument();
});

it('keeps a reported exact user quote unchanged without Frankfurter branding', () => {
  const saved = exchangeSnapshot();
  saved.facts.records[0].amount = { amountPaise: 401000, status: 'exact', source: { ...saved.facts.records[0].amount.source!,
    conversion: { ...saved.facts.records[0].amount.source!.conversion!, rate: '80', rateStatus: 'exact', fee: '10', feeStatus: 'exact', provider: null, fetchedAt: null } } };
  saved.plan.events[0].source = structuredClone(saved.facts.records[0].amount.source);
  saved.plan.planningFacts.records[0].amount = structuredClone(saved.facts.records[0].amount);
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  expect(within(row).getByText(/Current INR:/)).toHaveTextContent('₹4,010.00 · Reported');
  expect(within(row).getByText(/Captured INR:/)).toHaveTextContent('₹4,010.00');
  expect(row).not.toHaveTextContent(/Frankfurter|Today’s approximate INR|excludes unknown conversion fees/);
});

it('uses the occurrence index without presenting current INR as a historical capture', () => {
  const saved = exchangeSnapshot();
  saved.facts.records[0].schedule.amounts = [structuredClone(saved.facts.records[0].amount.source!)];
  saved.facts.records[0].amount = { amountPaise: null, status: 'unknown' };
  saved.plan.occurrenceAmounts = { rent: [structuredClone(saved.plan.planningFacts.records[0].amount)] };
  render(<MoneySources record={saved.facts.records[0]} snapshot={saved} />);
  expect(screen.getByText(/Captured INR:/)).toHaveTextContent('Not supplied for this occurrence');
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00');
});

it('separates captured and planning values in result evidence even for scalar schedule index zero', async () => {
  const saved = exchangeSnapshot();
  saved.workspace!.contributions![0].eventId = saved.plan.events[0].id;
  saved.workspace!.contributions![0].recordId = 'rent';
  const result = saved.workspace!.results![0];
  result.contributionIds = [saved.workspace!.contributions![0].id]; result.excludedIds = [];
  render(<ResultDetails snapshot={saved} result={result} />);
  await userEvent.click(screen.getByRole('button', { name: 'Why this result?' }));
  expect(screen.getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00');
  expect(screen.getByText(/excludes unknown conversion fees/)).toBeVisible();
});

it.each([true, false])('keeps final-plan qualifications visible and conversion figures folded when rate availability is %s', async available => {
  const saved = exchangeSnapshot();
  if (!available) {
    saved.plan.events[0].amountPaise = null;
    saved.plan.events[0].source!.conversion = { ...saved.plan.events[0].source!.conversion!, rate: null, rateStatus: 'unknown', rateDate: null, fetchedAt: null };
    saved.plan.planningFacts.records[0].amount = { amountPaise: null, status: 'unknown', source: structuredClone(saved.plan.events[0].source) };
  }
  render(<FinalPlan snapshot={saved} onEdit={vi.fn()} />);
  expect(screen.getAllByText(/excludes unknown conversion fees/).some(element => !element.closest('details'))).toBe(true);
  if (!available) expect(screen.getAllByText(/Exchange rate unavailable; conversion needs retry/).some(element => !element.closest('details'))).toBe(true);
  expect(screen.getByText('Captured INR: ₹4,000.00')).not.toBeVisible();
  await userEvent.click(screen.getByText('What this depends on', { selector: 'summary' }));
  expect(screen.getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent(available ? '₹4,200.00' : 'Unknown');
});

it.each(['income', 'essential', 'optional', 'debt'] as const)('shows current and captured INR for foreign %s without a dated event', kind => {
  const saved = exchangeSnapshot();
  saved.facts.records[0].kind = kind;
  saved.plan.events = [];
  render(<MoneySources record={saved.facts.records[0]} snapshot={saved} />);
  expect(screen.getByText(/Captured INR:/)).toHaveTextContent('₹4,000.00');
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00');
});

it.each(['cards', 'evidence', 'final'] as const)('shows current opening and retained capture in %s even when the current rate fails', async surface => {
  const saved = exchangeSnapshot();
  saved.facts.opening = structuredClone(saved.facts.records[0].amount);
  saved.facts.opening.source!.conversion = { ...saved.facts.opening.source!.conversion!, direction: 'receipt' };
  saved.plan.planningFacts.opening = { amountPaise: null, status: 'unknown', source: { ...saved.facts.opening.source!,
    conversion: { ...saved.facts.opening.source!.conversion!, rate: null, rateStatus: 'unknown', rateDate: null, fetchedAt: null } } };
  saved.facts.records = []; saved.plan.planningFacts.records = []; saved.plan.events = [];
  saved.workspace!.cards = [{ id: 'cash', template: 'cash', title: 'Cash & timing', section: 'facts', state: 'unresolved', resultIds: ['opening'] }];
  const result = saved.workspace!.results![0];
  result.contributionIds = ['opening']; result.excludedIds = [];
  render(surface === 'cards' ? <FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />
    : surface === 'evidence' ? <ResultDetails snapshot={saved} result={result} /> : <FinalPlan snapshot={saved} onEdit={vi.fn()} />);
  if (surface === 'evidence') await userEvent.click(screen.getByRole('button', { name: 'Why this result?' }));
  if (surface === 'final') {
    expect(screen.getAllByText(/Exchange rate unavailable/).some(element => !element.closest('details'))).toBe(true);
    await userEvent.click(screen.getByText('What this depends on', { selector: 'summary' }));
  }
  expect(screen.getByText(/Captured INR:/)).toHaveTextContent('₹4,000.00');
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('Unknown');
  expect(screen.queryByText(/No dated occurrence available/)).not.toBeInTheDocument();
});

it('shows a successful current opening independently of capture and every event', () => {
  const saved = exchangeSnapshot();
  saved.facts.opening = structuredClone(saved.facts.records[0].amount);
  saved.plan.planningFacts.opening = structuredClone(saved.plan.planningFacts.records[0].amount);
  saved.workspace!.cards = [{ id: 'cash', template: 'cash', title: 'Cash & timing', section: 'facts', state: 'estimated' }];
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />);
  expect(screen.getByText(/Captured INR:/)).toHaveTextContent('₹4,000.00');
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00');
});

it.each([8400000, null])('shows independent minimum and current outstanding %s beside a chosen target', async amountPaise => {
  const saved = exchangeSnapshot();
  const record = saved.facts.records[0]; const current = saved.plan.planningFacts.records[0];
  record.kind = 'debt'; record.debtType = 'card';
  record.target = { ...structuredClone(record.amount), amountPaise: 600000, source: { ...structuredClone(record.amount.source!), amount: '75' } };
  record.outstanding = { ...structuredClone(record.amount), amountPaise: 8000000, source: { ...structuredClone(record.amount.source!), amount: '1000' } };
  record.outstanding.source!.conversion = { ...record.outstanding.source!.conversion!, direction: 'valuation' };
  current.target = { ...structuredClone(current.amount), amountPaise: 630000, source: { ...structuredClone(current.amount.source!), amount: '75' } };
  current.outstanding = { ...structuredClone(current.amount), amountPaise, status: amountPaise === null ? 'unknown' : 'estimate', source: { ...structuredClone(current.amount.source!), amount: '1000' } };
  current.outstanding.source!.conversion = { ...current.outstanding.source!.conversion!, direction: 'valuation', rate: amountPaise === null ? null : '84', rateStatus: amountPaise === null ? 'unknown' : 'estimate' };
  saved.plan.events[0].amountPaise = 630000;
  render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  expect(row.querySelector('.card-record-amount')).toHaveTextContent('Intended payment');
  expect(row.querySelector('.card-record-amount')).toHaveTextContent('Today’s approximate INR: ₹6,300.00');
  expect(row.querySelector('.card-secondary')).toHaveTextContent('Captured INR: ₹4,000.00');
  expect(row.querySelector('.card-secondary')).toHaveTextContent('Today’s approximate INR: ₹4,200.00');
  await userEvent.click(within(row).getByText('Details', { selector: 'summary' }));
  const outstanding = within(row).getByText('Outstanding', { selector: '.card-caption' }).parentElement!;
  expect(outstanding).toHaveTextContent('Captured INR: ₹80,000.00');
  expect(outstanding).toHaveTextContent(amountPaise === null ? 'Today’s approximate INR: Unknown' : 'Today’s approximate INR: ₹84,000.00');
  if (amountPaise === null) expect(outstanding).toHaveTextContent('Exchange rate unavailable');
  expect(outstanding).not.toHaveTextContent('excludes unknown conversion fees');
});

it.each([true, false])('counts the minimum source without replacing the target for requiredFloor (dated %s)', async dated => {
  const saved = exchangeSnapshot();
  const record = saved.facts.records[0]; const current = saved.plan.planningFacts.records[0];
  record.kind = 'debt'; record.debtType = 'card';
  record.target = { amountPaise: 410000, status: 'exact' };
  current.target = structuredClone(record.target);
  saved.plan.events[0].amountBasis = 'requiredFloor';
  const event = structuredClone(saved.plan.events[0]);
  if (!dated) {
    record.schedule.date = null; saved.plan.events = [];
    saved.plan.undatedImpact = { items: [{ recordId: record.id, label: record.label, amountPaise: 420000, status: 'estimate', recurrence: 'once', amountBasis: 'requiredFloor', requiredPaise: 420000, targetPaise: 410000, assumption: 'If unpaid and due in this period.' }], outflowPaise: 420000, closingPaise: 80000, status: 'estimate', unknownRecordIds: [], qualification: 'What-if only.' };
  }
  const original = structuredClone(saved);
  const view = render(<FinancialContext snapshot={saved} stale={false} locked={false} onCommand={vi.fn()} proposalActive={false} />);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  expect(row.querySelector('.card-record-amount')).toHaveTextContent('Minimum payment');
  expect(within(row).getByText(/Captured INR:/)).toHaveTextContent('₹4,000.00');
  expect(within(row).getByText(/Today’s approximate INR:/)).toHaveTextContent('₹4,200.00');
  expect(row).toHaveTextContent('The minimum is counted; your target is retained');
  expect(within(row).getByRole('button', { name: 'Edit Rent target' })).toHaveTextContent('₹4,100');
  view.rerender(dated ? <ul><MoneyEvent event={event} snapshot={saved} /></ul> : <PlanningPossibilities snapshot={saved} />);
  if (dated) {
    expect(screen.getByText('Minimum exceeds target')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Details for Rent on/ }));
  }
  expect(screen.getByText(dated ? /The minimum is counted/ : /Current minimum counted; chosen target retained/)).toBeVisible();
  expect(saved).toEqual(original);
});

it('keeps original occurrence indexing when earlier terms have no event', () => {
  const saved = exchangeSnapshot(); const record = saved.facts.records[0];
  record.schedule.amounts = [structuredClone(record.amount.source!), { ...structuredClone(record.amount.source!), amount: '75' }];
  record.amount = { amountPaise: null, status: 'unknown' };
  saved.plan.events[0].scheduleIndex = 1; saved.plan.events[0].amountPaise = 630000;
  saved.plan.occurrenceAmounts = { rent: [structuredClone(saved.plan.planningFacts.records[0].amount), { ...structuredClone(saved.plan.planningFacts.records[0].amount), amountPaise: 630000 }] };
  render(<MoneySources record={record} snapshot={saved} />);
  const rows = within(screen.getByRole('list', { name: 'Rent ordered amounts' })).getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('Today’s approximate INR: ₹4,200.00');
  expect(rows[1]).toHaveTextContent('Today’s approximate INR: ₹6,300.00');
  expect(rows.every(row => row.textContent.includes('Captured INR: Not supplied for this occurrence'))).toBe(true);
});

it('does not manufacture current INR from event money or reference rates without a Money projection', () => {
  const saved = exchangeSnapshot();
  render(<ExchangeValues source={saved.facts.records[0].amount.source!} capturedPaise={400000} event={saved.plan.events[0]} plan={saved.plan} />);
  expect(screen.getByText(/Today’s approximate INR:/)).toHaveTextContent('Unknown');
  expect(screen.getByText(/Current INR not supplied by the server/)).toBeVisible();
});

it('folds scalar conversion once for thirty daily events and retains undated and opening conversions', async () => {
  const saved = exchangeSnapshot();
  saved.facts.opening = structuredClone(saved.facts.records[0].amount);
  saved.plan.planningFacts.opening = structuredClone(saved.plan.planningFacts.records[0].amount);
  saved.facts.records.push({ ...structuredClone(saved.facts.records[0]), id: 'undated', label: 'Undated fee', schedule: { date: null, certainty: 'unknown', recurrence: 'once', basis: 'payment' } });
  saved.plan.planningFacts.records.push({ ...structuredClone(saved.plan.planningFacts.records[0]), id: 'undated' });
  saved.plan.events = Array.from({ length: 30 }, (_, index) => ({ ...saved.plan.events[0], id: `rent:${index}`, amountBasis: 'budget', amountPaise: 14000, source: null }));
  saved.facts.records[0].schedule.recurrence = 'monthlyBudget';
  render(<FinalPlan snapshot={saved} onEdit={vi.fn()} />);
  await userEvent.click(screen.getByText('What this depends on', { selector: 'summary' }));
  expect(screen.getAllByText(/Captured INR:/)).toHaveLength(3);
  expect(screen.getAllByText('Exchange rate details', { selector: 'summary' })).toHaveLength(3);
  expect(screen.getByText('Undated fee · Undated')).toBeVisible();
  expect(screen.getByText(/Daily forecast share:/)).toHaveTextContent('₹140.00');
  expect(screen.getAllByText(/Today’s approximate INR:/).every(element => element.textContent.includes('₹4,200.00'))).toBe(true);
});

it.each(['payment', 'cost'] as const)('shows current and captured provider %s independently of event money', async field => {
  const saved = exchangeSnapshot();
  saved.facts.providerResponses = [{ eventId: saved.plan.events[0].id, status: 'reportedTerms', reportedOn: '2026-09-13', dependencyKey: 'quote', [field]: { ...structuredClone(saved.facts.records[0].amount), amountPaise: 8000 } }];
  saved.plan.planningFacts.providerResponses = [{ ...structuredClone(saved.facts.providerResponses[0]), [field]: { ...structuredClone(saved.plan.planningFacts.records[0].amount), amountPaise: 8400 } }];
  render(<ul><RecordRow record={saved.facts.records[0]} snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} /></ul>);
  await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Captured INR: ₹80.00')).toBeVisible();
  const terms = within(dialog).getByText(`Reported terms · ${field === 'payment' ? 'Payment' : 'Cost'}`).parentElement!;
  expect(within(terms).getByText(/Today’s approximate INR:/)).toHaveTextContent('₹84.00');
  expect(within(terms).getByText('Captured INR: ₹80.00')).toBeVisible();
  expect(within(dialog).getByText('Captured INR: ₹4,000.00')).toBeVisible();
  expect(dialog).toHaveTextContent('Original obligations remain; these terms are not verified');
});