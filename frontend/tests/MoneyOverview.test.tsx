// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { MoneyOverview } from '../src/MoneyOverview';
import { MoneyChart } from '../src/MoneyChart';
import { PlanComparison } from '../src/ScenarioDetails';
import { financialText } from '../src/money';
import { planningSnapshot, scenario, snapshot } from './fixtures';
import { projectWorkspace } from './workspace';

const controls = { blocked: false, onEdit: vi.fn(), onChecks: vi.fn(), onCommand: vi.fn() };

it('keeps timing exposure distinct in both sides of a proposal comparison', () => {
  const saved = planningSnapshot();
  saved.plan.peakGapPaise = 500000; saved.plan.peakGapDate = '2026-09-16';
  saved.plan.timingRisks = [{ date: '2026-09-16', exposurePaise: 500000, remainingGapPaise: 0 }];
  const original = structuredClone(saved.plan);
  render(<PlanComparison baseline={saved.plan} assumed={saved.plan} reserve={0} label="Compared plan" />);
  expect(screen.getAllByText('Largest timing exposure')).toHaveLength(2);
  expect(screen.queryByText('Largest cash gap')).not.toBeInTheDocument();
  expect(saved.plan).toEqual(original);
});

it('shows server totals with the first and largest shortfalls, not a misleading closing surplus', async () => {
  const saved = planningSnapshot();
  saved.facts.coverage.income = 'reviewed';
  saved.facts.records.push({ ...saved.facts.records[0], id: 'salary', kind: 'income', label: 'Salary', reliability: 'reliable' });
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  const metrics = screen.getByRole('region', { name: 'Money in this plan' });
  expect(metrics).toHaveTextContent('Starting cash₹5,000');
  expect(metrics).toHaveTextContent('Money coming in₹30,000');
  expect(metrics).toHaveTextContent('Money going out₹25,000');
  expect(metrics).toHaveTextContent('Closing forecast₹10,000');
  expect(metrics).toHaveTextContent('Not a spending allowance');
  const attention = screen.getByRole('region', { name: 'What needs attention' });
  expect(within(attention).getByRole('heading')).toHaveTextContent(financialText(saved.plan.decisionAssessment!.outcome!.summary));
  expect(within(attention).getByLabelText('First shortfall')).toHaveTextContent('₹7,000First shortfall · 13 Sept');
  expect(attention).not.toHaveTextContent('payments fit');
  expect(document.querySelector('.money-overview-footnotes')).not.toHaveTextContent(/^0$/);
  await userEvent.click(screen.getByRole('button', { name: 'View calculation' }));
  const details = screen.getByRole('dialog', { name: 'Plan details' });
  expect(within(details).getByText('Largest shortfall').parentElement).toHaveTextContent('₹16,000 · 18 Sept');
  expect(details).toHaveTextContent('The first and largest shortfalls are not amounts to add together.');
});

it.each([
  { receiptDate: '2026-09-16', label: 'Largest timing exposure' },
  { receiptDate: '2026-09-17', label: 'Largest shortfall' },
])('labels the calculation peak as $label with income on $receiptDate', async ({ receiptDate, label }) => {
  const saved = planningSnapshot();
  // Balances are supplied in conservative event order, not calculated by the frontend.
  const events = [
    { id: 'rent', label: 'Rent', kind: 'essential', date: '2026-09-14', amountPaise: 100000, balancePaise: -100000 },
    { id: 'utilities', label: 'Utilities', kind: 'essential', date: '2026-09-16', amountPaise: 400000, balancePaise: -500000 },
    { id: 'salary', label: 'Salary', kind: 'income', date: receiptDate, amountPaise: 500000, balancePaise: 0 },
    { id: 'groceries', label: 'Groceries', kind: 'essential', date: '2026-09-18', amountPaise: 100000, balancePaise: -100000 },
  ] as const;
  saved.facts.opening = { amountPaise: 0, status: 'exact' };
  saved.facts.coverage = { income: 'reviewed', essential: 'reviewed', optional: 'none', debt: 'none' };
  saved.facts.records = events.map(({ id, label, kind, date, amountPaise }) => ({ id, label, kind,
    amount: { amountPaise, status: 'exact' }, schedule: { date, recurrence: 'once', certainty: 'exact', basis: 'payment' }, autoDebit: false,
    ...(kind === 'income' ? { reliability: 'reliable' as const } : { controllability: 'committed' as const }),
  }));
  saved.plan = { ...saved.plan, projectionPartial: false, reliableIncomePaise: 500000, outflowPaise: 600000,
    closingPaise: -100000, troughPaise: -500000, reserveShortfallPaise: 0,
    firstGap: { date: '2026-09-14', amountPaise: 100000 }, peakGapPaise: 500000, peakGapDate: '2026-09-16',
    timingRisks: receiptDate === '2026-09-16' ? [{ date: '2026-09-16', exposurePaise: 500000, remainingGapPaise: 0 }] : [],
    events: events.map(event => ({ ...saved.plan.events[0], ...event, id: `${event.id}:${event.date}`, recordId: event.id, originalDueDate: event.date })),
    decisionAssessment: { consequences: [
      { id: 'cash:2026-09-14', kind: 'cashExposure', eventIds: ['rent:2026-09-14'], date: '2026-09-14', amountPaise: 100000 },
      { id: 'cash:2026-09-16', kind: 'cashExposure', eventIds: ['utilities:2026-09-16'], date: '2026-09-16', amountPaise: 500000 },
      { id: 'cash:2026-09-18', kind: 'cashExposure', eventIds: ['groceries:2026-09-18'], date: '2026-09-18', amountPaise: 100000 },
    ] },
  };
  projectWorkspace(saved);
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: 'View calculation' }));
  const details = screen.getByRole('dialog', { name: 'Plan details' });
  const peak = within(details).getByText(/^Largest /).parentElement;
  expect(peak).toBeVisible();
  expect(peak).toHaveTextContent('₹5,000');
  expect(peak).toHaveTextContent('16 Sept');
  expect(peak).toHaveTextContent(label);
  expect(details).not.toHaveTextContent(label === 'Largest shortfall' ? 'Largest timing exposure' : 'Largest shortfall');
});

it.each(['reported', 'accepted'] as const)('labels a later peak as timing exposure in the %s calculation details without applying a preview', async basis => {
  const saved = planningSnapshot(); saved.preview = scenario();
  if (basis === 'accepted') saved.accepted = scenario('accepted');
  const plan = saved.accepted?.plan ?? saved.plan;
  plan.firstGap = { date: '2026-09-14', amountPaise: 100000 };
  plan.peakGapPaise = 500000; plan.peakGapDate = '2026-09-16';
  plan.timingRisks = [{ date: '2026-09-16', exposurePaise: 500000, remainingGapPaise: 0 }];
  const original = structuredClone(saved);
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  expect(within(screen.getByRole('region', { name: 'What needs attention' })).getByLabelText('First shortfall')).toHaveTextContent('₹1,000First shortfall · 14 Sept');
  await userEvent.click(screen.getByRole('button', { name: 'View calculation' }));
  const details = screen.getByRole('dialog', { name: 'Plan details' });
  expect(saved).toEqual(original);
  expect(within(details).getByText('Largest timing exposure').parentElement).toHaveTextContent('₹5,000 · 16 Sept');
  expect(details).toHaveTextContent(/before same-day income/i);
  expect(details).toHaveTextContent(/No remaining gap after included income/i);
  expect(within(details).queryByText('Largest shortfall')).not.toBeInTheDocument();
});

it('shows formatted qualifications once beside closing rather than repeating them in attention', () => {
  const saved = planningSnapshot();
  saved.facts.records[0].amount.status = 'estimate';
  saved.plan.events[0].amountStatus = 'estimate';
  saved.workspace!.results!.find(result => result.id === 'closing')!.state = 'estimated';
  for (const result of saved.workspace!.results!.filter(result => ['closing', 'firstGap'].includes(result.id))) {
    result.qualifications = ['Uses estimated Rent (INR 12000.00) on 2026-09-13.'];
  }
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  const closing = document.querySelector('.money-metric-closing') as HTMLElement;
  expect(closing).toHaveTextContent('Closing forecast₹10,000');
  expect(within(closing).getByText('Uses estimated Rent (₹12,000) on 13 Sept 2026.')).toBeVisible();
  expect(closing).toHaveTextContent('Includes estimates · Not a spending allowance');
  expect(screen.getAllByText('Uses estimated Rent (₹12,000) on 13 Sept 2026.')).toHaveLength(1);
  expect(screen.getAllByText(/Not a spending allowance/)).toHaveLength(1);
  const attention = screen.getByRole('region', { name: 'What needs attention' });
  expect(attention).not.toHaveTextContent(/Uses estimated Rent|Not a spending allowance/);
  expect(within(attention).getByLabelText('First shortfall')).toHaveTextContent('₹7,000');
  expect(attention).toHaveTextContent('Next step Contact the provider before the due date.');
});

it('preserves same-day low balances in the graph before a later receipt', () => {
  const saved = planningSnapshot();
  saved.facts.opening.amountPaise = 0;
  saved.facts.records[0].amount.amountPaise = 600000;
  saved.facts.records[0].schedule.date = '2026-09-20';
  saved.facts.records.push(
    { ...saved.facts.records[0], id: 'salary', label: 'Salary', kind: 'income', amount: { amountPaise: 1000000, status: 'exact' }, reliability: 'reliable' },
    { ...saved.facts.records[0], id: 'bonus', label: 'Bonus', kind: 'income', amount: { amountPaise: 200000, status: 'exact' }, reliability: 'uncertain' },
  );
  saved.plan.firstGap = { date: '2026-09-20', amountPaise: 600000 };
  saved.plan.peakGapPaise = 600000; saved.plan.peakGapDate = '2026-09-20'; saved.plan.closingPaise = 400000;
  saved.plan.troughPaise = -600000; saved.plan.reliableIncomePaise = 1000000; saved.plan.uncertainIncomePaise = 200000; saved.plan.outflowPaise = 600000;
  saved.plan.events = [{ ...saved.plan.events[0], date: '2026-09-20', originalDueDate: '2026-09-20', amountPaise: 600000, balancePaise: -600000 },
    { ...saved.plan.events[0], id: 'salary', recordId: 'salary', label: 'Salary', kind: 'income', date: '2026-09-20', originalDueDate: '2026-09-20', amountPaise: 1000000, balancePaise: 400000 },
    { ...saved.plan.events[0], id: 'bonus', recordId: 'bonus', label: 'Bonus', kind: 'income', date: '2026-09-20', originalDueDate: '2026-09-20', amountPaise: 200000, included: false, balancePaise: 400000 }];
  saved.plan.timingRisks = [];
  const { rerender } = render(<MoneyChart snapshot={saved} />);
  expect(screen.getByRole('img')).toHaveAccessibleDescription(/First shortfall ₹6,000.00.*Projected closing cash ₹4,000.00/);
  const path = document.querySelector('.money-chart-line')!.getAttribute('d')!;
  expect(path).toContain('V 174.00');
  expect(path.indexOf('V 174.00')).toBeLessThan(path.indexOf('V 16.00'));
  expect(document.querySelector('.money-chart-marker')).toBeInTheDocument();
  expect(path).not.toMatch(/NaN|Infinity/);
  const areas = [...document.querySelectorAll('.money-chart-area')].map(area => area.getAttribute('d'));
  const timing = structuredClone(saved);
  timing.plan.timingRisks = [{ date: '2026-09-20', exposurePaise: 600000, remainingGapPaise: 0 }];
  timing.workspace!.results!.find(result => result.id === 'closing')!.qualifications = ['Excludes Bonus (INR 2000.00): receipt not assured.'];
  rerender(<MoneyChart snapshot={timing} />);
  expect(screen.getByRole('img')).toHaveAccessibleDescription(/Timing exposure ₹6,000\.00 on 20 Sept 2026 if payments leave before same-day income\. ₹0\.00 remains unfunded after included income\./);
  expect(screen.getByRole('img')).toHaveAccessibleDescription(/Largest conservative gap ₹6,000\.00.*Projected closing cash ₹4,000\.00/);
  expect(screen.getByRole('img')).toHaveAccessibleDescription(/Excludes Bonus \(INR 2000\.00\): receipt not assured\./);
  expect(screen.getByRole('img')).not.toHaveAccessibleDescription(/First shortfall/);
  expect(screen.getByText('Funding / timing risk')).toBeVisible();
  expect(document.querySelector('.money-chart-marker')).toHaveTextContent('Timing exposure: ₹6,000.00 · 20 Sept 2026');
  expect([...document.querySelectorAll('.money-chart-line')].map(line => line.getAttribute('d'))).toEqual([path, path]);
  expect([...document.querySelectorAll('.money-chart-area')].map(area => area.getAttribute('d'))).toEqual(areas);
  expect(timing.plan.events).toEqual(saved.plan.events);
});

it('plots only included events and accepted balances, never preview or raw amounts', () => {
  const saved = planningSnapshot();
  saved.accepted = scenario('saved'); saved.preview = scenario('preview');
  saved.accepted.plan.closingPaise = 123400;
  saved.accepted.plan.events = [{ ...saved.plan.events[0], amountPaise: 1, balancePaise: 123400 },
    { ...saved.plan.events[0], id: 'excluded', kind: 'income', included: false, balancePaise: 88888888 }];
  saved.preview.plan.closingPaise = 99999999;
  saved.preview.plan.events = [{ ...saved.plan.events[0], balancePaise: 99999999 }];
  const original = structuredClone(saved);
  render(<MoneyChart snapshot={saved} />);
  expect(screen.getByRole('img')).toHaveAccessibleDescription(/Projected closing cash ₹1,234.00/);
  expect(screen.getByRole('img')).not.toHaveAccessibleDescription(/999|888/);
  expect(document.querySelector('.money-chart-line')!.getAttribute('d')).not.toMatch(/NaN|Infinity/);
  expect(saved).toEqual(original);
});

it('keeps unknown cash and missing amounts distinct from zero without a fabricated chart', () => {
  const saved = snapshot();
  saved.facts.records = [{ ...planningSnapshot().facts.records[0], amount: { amountPaise: null, status: 'unknown' } }];
  saved.plan.budgetBasis.unresolvedAmounts = [{ recordId: 'rent', reason: 'missingAmount', amount: { amountPaise: null, status: 'unknown' }, recurrence: 'once' }];
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Money in this plan' })).toHaveTextContent('Money going outUnknown');
  expect(screen.getByRole('region', { name: 'Money in this plan' })).not.toHaveTextContent('₹0');
  expect(screen.getByRole('button', { name: 'Add starting cash' })).toBeVisible();
});

it('groups repeated budget occurrences without combining different records or recomputing amounts', () => {
  const saved = planningSnapshot();
  saved.plan.events = Array.from({ length: 30 }, (_, index) => ({ ...saved.plan.events[0], id: `budget:${index}`, recordId: 'budget', label: 'Living budget', amountBasis: 'budget' as const, amountPaise: 10000 }));
  saved.plan.events.splice(2, 0, { ...saved.plan.events[0], id: 'other', recordId: 'other', label: 'Living budget', amountPaise: 12345 });
  saved.facts.records = [{ ...saved.facts.records[0], id: 'budget', label: 'Living budget', schedule: { date: '2026-09-13', recurrence: 'monthlyBudget', certainty: 'exact', basis: 'payment' } },
    { ...saved.facts.records[0], id: 'other', label: 'Living budget' }];
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  const rows = within(screen.getByRole('region', { name: 'Next money and payments' })).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Daily budget'); expect(rows[0]).toHaveTextContent('−₹100');
  expect(rows[1]).toHaveTextContent('−₹123.45');
});

it('keeps a reserve breach distinct from missing details and cash shortage', () => {
  const saved = planningSnapshot();
  saved.facts.reservePaise = 500000; saved.plan.firstGap = null; saved.plan.peakGapPaise = 0;
  saved.plan.reserveShortfallPaise = 200000; saved.plan.closingPaise = 300000;
  saved.plan.peakGapDate = null; saved.plan.troughPaise = 300000; saved.plan.projectionPartial = false;
  saved.plan.decisionAssessment!.consequences = [{ id: 'reserve', kind: 'reserveBreach', date: '2026-09-13', amountPaise: 200000, eventIds: [] }];
  saved.plan.decisionAssessment!.outcome = { ...saved.plan.decisionAssessment!.outcome!, branch: 'uncertain', summary: 'Dated payments fit, but the cash buffer is not protected.' };
  saved.plan.decisionAssessment!.nextActionId = null;
  saved.workspace!.actions = [];
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  const attention = screen.getByRole('region', { name: 'What needs attention' });
  expect(within(attention).getByRole('heading')).toHaveTextContent(financialText(saved.plan.decisionAssessment!.outcome.summary));
  expect(attention).toHaveTextContent('Cash buffer at risk: ₹2,000 below your ₹5,000 buffer · 13 Sept. Separate from payment shortfalls.');
  expect(within(attention).queryByLabelText('First shortfall')).not.toBeInTheDocument();
  expect(attention).not.toHaveTextContent('details still need');
  expect(attention).toHaveAttribute('data-tone', 'risk');
});

it('keeps supported actions and precise explanations one click away', async () => {
  const saved = planningSnapshot();
  render(<MemoryRouter><MoneyOverview {...controls} snapshot={saved} /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: 'Discuss payment options' }));
  expect(screen.getByRole('dialog', { name: 'Your next step' })).toHaveTextContent('Contact the provider before the due date.');
  await userEvent.click(screen.getByRole('button', { name: 'I can’t confirm or take this step now' }));
  expect(controls.onCommand).toHaveBeenCalledWith({ type: 'respondToAction', actionId: 'contact:rent:2026-09-13', response: 'unavailable' });
});