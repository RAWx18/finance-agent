// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Snapshot } from '../src/api';
import type { components } from '../src/contracts';
import { changeNotes, FinancialContext } from '../src/FinancialContext';
import { cardDate } from '../src/cardFields';
import { planningSnapshot, scenario, snapshot } from './fixtures';
import { projectWorkspace } from './workspace';

const controls = { locked: false, proposalActive: true, onCommand: vi.fn<(operation: Command['operation']) => Promise<Snapshot | undefined>>(), stale: false };
beforeEach(() => { controls.onCommand.mockReset().mockResolvedValue(undefined); });
/** Creates a reliable monthly salary record for companion presentation fixtures. */
const salary = (): Snapshot['facts']['records'][number] => ({ id: 'salary', label: 'Salary', kind: 'income', amount: { status: 'exact', amountPaise: 2500000 }, schedule: { date: '2026-09-25', recurrence: 'monthly', certainty: 'exact', basis: 'payment' }, reliability: 'reliable', autoDebit: false });

// Membership is supplied explicitly; financial calculations and ranking belong to the server.
/** Assigns test-selected companion cards to a snapshot without calculating financial metrics. */
function companion(saved: Snapshot): Snapshot {
  const cards: components['schemas']['WorkspaceCard'][] = [];
  /** Appends a card skeleton for the companion fixture's explicit membership. */
  const add = (template: 'cash' | 'timeline' | 'questions' | 'proposal', title: string, section: components['schemas']['WorkspaceCard']['section']) => {
    const card: components['schemas']['WorkspaceCard'] = { id: template, template, title, section, state: 'known', recordIds: [], eventIds: [], resultIds: [], issueIds: [], rows: [], dependencies: [] };
    cards.push(card); return card;
  };
  add('cash', 'Cash & timing', 'facts').resultIds = ['opening', 'firstGap', 'closing', 'reserveShortfall'];
  if (saved.facts.records.length) {
    const card = add('timeline', 'Next & commitments', 'timeline');
    card.recordIds = saved.facts.records.map(record => record.id);
    card.eventIds = (saved.accepted?.plan ?? saved.plan).events.map(event => event.id);
  }
  if (saved.workspace?.issues?.length) add('questions', 'Important uncertainty', 'issues').issueIds = [saved.workspace.issues[0].id];
  if (saved.preview || saved.accepted || saved.invalidatedAssumptions?.length) add('proposal', 'Plan changes', 'decisions');
  saved.workspace!.cards = cards;
  return saved;
}
/** Builds a rent-and-salary fixture with explicit companion card membership. */
const picture = () => { const saved = planningSnapshot(); saved.facts.records.push(salary()); return companion(saved); };

describe('financial companion', () => {
  it.each([null, snapshot()])('starts with one quiet line and no invented figures', saved => {
    const { container } = render(<FinancialContext {...controls} snapshot={saved} />);
    expect(screen.getByText('Figures appear as you talk')).toBeVisible();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/₹|coverage|What cash|No figures yet/);
  });

  it('adds and removes only canonical server cards as facts arrive', () => {
    const saved = picture(); saved.workspace!.cards = [];
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    rerender(<FinancialContext {...controls} snapshot={companion(structuredClone(saved))} />);
    expect(screen.getByRole('article', { name: 'Commitments & income' })).toHaveTextContent('Salary');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    saved.workspace!.cards = [{ id: 'cash', template: 'cash', title: 'Cash & timing', section: 'facts', state: 'known', resultIds: ['opening'] }];
    rerender(<FinancialContext {...controls} snapshot={{ ...saved }} />);
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    expect(screen.queryByText(/Why this result|Your outlook|What you’ve shared/)).not.toBeInTheDocument();
  });

  it('keeps the supplied priority order, four rows and one deduplicated material issue', async () => {
    const saved = picture();
    saved.facts.records.push(...Array.from({ length: 4 }, (_, index) => ({ ...salary(), id: `extra${index}`, label: `Receipt ${index}` })));
    saved.workspace!.issues = [{ id: 'uncertain-extra', kind: 'uncertain', field: 'reliability', recordIds: ['extra3'], priority: 1, changes: [], blocks: [], question: 'Is Receipt 3 confirmed?', reason: 'Receipt 3 is not assured and cannot fund the earlier payment.' }];
    companion(saved);
    const order = ['salary', 'rent', 'extra1', 'extra0', 'extra3', 'extra2'];
    saved.workspace!.cards!.find(card => card.id === 'timeline')!.recordIds = order;
    render(<FinancialContext {...controls} snapshot={saved} />);
    const list = screen.getByRole('list', { name: 'Next commitments' });
    expect(within(list).getAllByRole('listitem').map(row => row.getAttribute('aria-label'))).toEqual(['Salary', 'Rent', 'Receipt 1', 'Receipt 0']);
    const uncertainty = screen.getByRole('article', { name: 'Important uncertainty' });
    expect(uncertainty).toHaveTextContent('Receipt 3 · Receipt');
    expect(screen.queryByText('Is Receipt 3 confirmed?')).not.toBeInTheDocument();
    const reason = within(uncertainty).getByText('Receipt 3 is not assured and cannot fund the earlier payment.');
    expect(reason).not.toBeVisible();
    await userEvent.click(within(uncertainty).getByText('Why this matters', { selector: 'summary' }));
    expect(reason).toBeVisible();
    const salaryRow = within(list).getByRole('listitem', { name: 'Salary' });
    screen.getByRole('button', { name: 'Show 2 more' }).focus(); await userEvent.keyboard('{Enter}');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(within(list).getByRole('listitem', { name: 'Salary' })).toBe(salaryRow);
    expect(screen.queryByRole('article', { name: 'Important uncertainty' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer commitments' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows cash basis and the first shortfall once, without spendable or completed claims', () => {
    const saved = picture(); saved.anchorDate = '2026-09-12'; saved.facts.opening.amountPaise = 60000000;
    saved.plan.firstGap = { date: '2026-09-13', amountPaise: 800000 };
    saved.workspace!.results!.find(result => result.id === 'firstGap')!.amountPaise = 800000;
    render(<FinancialContext {...controls} snapshot={saved} />);
    const cash = screen.getByRole('article', { name: 'Cash & timing' });
    expect(cash).toHaveTextContent('₹6,00,000'); expect(cash).not.toHaveTextContent('₹6,00,000.00');
    expect(cash).toHaveTextContent(`As of ${cardDate(saved.anchorDate)} · Reported, not a bank feed`);
    expect(screen.getAllByLabelText('First shortfall')).toHaveLength(1);
    const summary = screen.getByRole('region', { name: 'Financial status' });
    expect(within(summary).getByRole('heading')).toHaveTextContent('Projected end');
    expect(within(cash).getByLabelText('First shortfall')).toHaveTextContent('₹8,000First shortfall · 13 Sept');
    expect(screen.queryByText(saved.plan.decisionAssessment!.outcome!.summary)).not.toBeInTheDocument();
    expect(screen.queryByText(saved.plan.decisionAssessment!.outcome!.nextStep)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Projected closing cash')).toHaveLength(1);
    expect(within(screen.getByLabelText('Projected closing cash')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('First shortfall')).queryByRole('button')).not.toBeInTheDocument();
    expect(cash).not.toHaveTextContent(/available to spend|paid|Keep aside/);
  });

  it.each(['reported', 'accepted'] as const)('labels a later peak as timing exposure in the %s cash card without applying a preview', basis => {
    const saved = picture(); saved.preview = scenario();
    if (basis === 'accepted') saved.accepted = scenario('accepted');
    const plan = saved.accepted?.plan ?? saved.plan;
    plan.firstGap = { date: '2026-09-14', amountPaise: 100000 };
    plan.peakGapPaise = 500000; plan.peakGapDate = '2026-09-16';
    plan.timingRisks = [{ date: '2026-09-16', exposurePaise: 500000, remainingGapPaise: 0 }];
    const original = structuredClone(saved);
    render(<FinancialContext {...controls} snapshot={saved} />);
    const cash = screen.getByRole('article', { name: 'Cash & timing' });
    expect(saved).toEqual(original);
    expect(controls.onCommand).not.toHaveBeenCalled();
    expect(within(cash).getByLabelText('First shortfall')).toHaveTextContent('₹1,000First shortfall · 14 Sept');
    expect(cash).toHaveTextContent('Largest timing exposure · ₹5,000 · 16 Sept');
    expect(cash).toHaveTextContent(/before same-day income/i);
    expect(cash).toHaveTextContent(/No remaining gap after included income/i);
    expect(cash).not.toHaveTextContent('Largest shortfall');
  });

  it('distinguishes zero, unknown and estimated sources without global decimal formatting changes', () => {
    const saved = picture(); saved.facts.records[0].amount = { amountPaise: 0, status: 'exact' };
    saved.facts.records[1].amount = { amountPaise: 2500025, status: 'estimate' };
    saved.facts.records[1].schedule = { ...saved.facts.records[1].schedule, date: null, certainty: 'unknown' };
    render(<FinancialContext {...controls} snapshot={saved} />);
    expect(screen.getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('₹0');
    expect(screen.getByRole('button', { name: 'Edit Salary amount' })).toHaveTextContent('₹25,000.25');
    expect(screen.getByRole('button', { name: 'Edit Salary amount' })).toHaveTextContent('Est.');
    expect(screen.getByRole('button', { name: 'Edit Salary series start' })).toHaveTextContent('Arrival date unknown');
  });

  it('keeps a calculated pattern date separate from source edits and amount certainty', async () => {
    const saved = picture();
    saved.facts.records[0].amount.status = 'estimate';
    saved.facts.records[0].schedule = { date: null, certainty: 'unknown', recurrence: 'monthly', basis: 'payment', pattern: { kind: 'dayOfMonth', day: 13 } };
    saved.plan.events[0].dateAssumption = 'Calculated from monthly day 13 pattern';
    saved.plan.events[0].amountStatus = 'estimate';
    const original = structuredClone(saved);
    const receipt = structuredClone(saved); receipt.revision++; receipt.sequence++;
    receipt.facts.records[0].amount.amountPaise = 1250000; receipt.plan.events[0].amountPaise = 1250000;
    controls.onCommand.mockResolvedValueOnce(receipt);
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    const date = screen.getByRole('button', { name: 'Edit Rent series start' });
    expect(date).toHaveTextContent('Assumed 13 SeptCalculated');
    expect(date).not.toHaveTextContent(/Unknown|Due|Reported/);
    expect(screen.getByRole('listitem', { name: 'Rent' })).toHaveTextContent('From your monthly day 13 pattern. Editing timing replaces or removes the pattern for the whole series, not one occurrence.');
    expect(screen.getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('−₹12,000Est.');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Rent amount' }));
    expect(screen.getByLabelText('Rent amount certainty')).toHaveValue('estimate');
    fireEvent.change(screen.getByRole('textbox', { name: 'Rent amount' }), { target: { value: '12500' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save Rent amount' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: 0,
      records: [{ id: 'rent', delete: false, distinct: false, amount: { amount: '12500', status: 'estimate' } }] } });
    rerender(<FinancialContext {...controls} snapshot={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Rent series start' }));
    expect(screen.getByRole('button', { name: 'Save Rent series start' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Rent series start timing change'), 'replace');
    const input = screen.getByLabelText('Rent series start', { selector: 'input' });
    expect(screen.getByLabelText('Rent series start certainty')).toHaveValue('exact');
    expect(input).toHaveValue(''); expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: '2026-09-18' } });
    const corrected = structuredClone(receipt); corrected.revision++; corrected.sequence++;
    corrected.facts.records[0].schedule.date = '2026-09-18'; corrected.facts.records[0].schedule.certainty = 'exact';
    corrected.facts.records[0].schedule.pattern = null;
    corrected.plan.events[0] = { ...corrected.plan.events[0], date: '2026-09-18', originalDueDate: '2026-09-18', dateAssumption: null };
    controls.onCommand.mockResolvedValueOnce(corrected);
    await userEvent.click(screen.getByRole('button', { name: 'Save Rent series start' }));
    expect(controls.onCommand).toHaveBeenCalledTimes(2);
    expect(controls.onCommand).toHaveBeenNthCalledWith(2, { type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: receipt.revision,
      records: [{ id: 'rent', delete: false, distinct: false, schedule: { date: '2026-09-18', certainty: 'exact', pattern: null } }] } });
    rerender(<FinancialContext {...controls} snapshot={corrected} />);
    expect(screen.getByRole('button', { name: 'Edit Rent series start' })).toHaveTextContent('Due 18 Sept');
    expect(screen.getByRole('button', { name: 'Edit Rent series start' })).not.toHaveTextContent(/Assumed|Calculated|13 Sept/);
    expect(screen.getByRole('button', { name: 'Edit Rent amount' })).toHaveTextContent('−₹12,500Est.');
    expect(corrected.facts.records[0].amount).toEqual(receipt.facts.records[0].amount);
    expect(receipt.facts.records[0].schedule.date).toBeNull();
    expect(saved).toEqual(original);
  });

  it.each(['amount', 'date', 'name'] as const)('sends only the inline %s correction with human provenance', async field => {
    const saved = picture(); const receipt = structuredClone(saved); receipt.revision++; receipt.sequence++;
    if (field === 'amount') receipt.facts.records[0].amount.amountPaise = 1230025;
    else if (field === 'date') receipt.facts.records[0].schedule.date = '2026-09-18';
    else receipt.facts.records[0].label = 'Home rent';
    controls.onCommand.mockResolvedValue(receipt);
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('button', { name: `Edit Rent ${field}` }));
    const input = screen.getByLabelText(`Rent ${field}`, { selector: 'input' });
    fireEvent.change(input, { target: { value: field === 'amount' ? '12300.25' : field === 'date' ? '2026-09-18' : 'Home rent' } });
    await userEvent.click(screen.getByRole('button', { name: `Save Rent ${field}` }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: 0, records: [{ id: 'rent', delete: false, distinct: false,
      ...(field === 'amount' ? { amount: { amount: '12300.25', status: 'exact' } } : field === 'date' ? { schedule: { date: '2026-09-18', certainty: 'exact' } } : { label: 'Home rent' }),
    }] } });
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Edit Rent ${field}` })).toHaveFocus();
    expect(screen.getByRole('listitem', { name: 'Rent' })).toBeVisible();
    rerender(<FinancialContext {...controls} snapshot={receipt} />);
    expect(screen.getByRole('listitem', { name: field === 'name' ? 'Home rent' : 'Rent' })).toBeVisible();
  });

  it('keeps editing and scroll stable on background updates and blocks a stale draft', async () => {
    const saved = picture(); const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    const row = screen.getByRole('listitem', { name: 'Salary' });
    const scroll = screen.getByRole('region', { name: 'Financial picture details' }); scroll.scrollTop = 150;
    await userEvent.click(screen.getByRole('button', { name: 'Edit Salary amount' }));
    const input = screen.getByLabelText('Salary amount', { selector: 'input' });
    fireEvent.change(input, { target: { value: '31000.25' } }); input.focus();
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, sequence: 1 }} />);
    expect(input).toHaveValue('31000.25'); expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Save Salary amount' })).toBeEnabled();
    rerender(<FinancialContext {...controls} snapshot={{ ...saved, revision: 1, sequence: 2 }} />);
    expect(input).toHaveValue('31000.25'); expect(screen.getByRole('button', { name: 'Save Salary amount' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Saved figures changed');
    expect(row).toBe(screen.getByRole('listitem', { name: 'Salary' })); expect(scroll.scrollTop).toBe(150);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Salary amount' }));
    expect(screen.getByRole('button', { name: 'Edit Salary amount' })).toHaveFocus(); expect(controls.onCommand).not.toHaveBeenCalled();
  });

  it('shows a monthly source budget once, with a series start instead of daily due rows', async () => {
    const saved = picture(); const record = saved.facts.records[0]; record.schedule.recurrence = 'monthlyBudget'; record.schedule.date = '2026-08-01';
    render(<FinancialContext {...controls} snapshot={saved} />);
    const row = screen.getByRole('listitem', { name: 'Rent' });
    expect(row).toHaveTextContent('₹12,000/month'); expect(row).toHaveTextContent('Daily forecast · not a payment due');
    expect(within(row).getByRole('button', { name: 'Edit Rent series start' })).toHaveTextContent(`Starts ${cardDate('2026-08-01')}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Edit Rent series start' }));
    expect(screen.getByLabelText('Rent series start', { selector: 'input' })).toHaveValue('2026-08-01');
  });

  it('leads with the known debt requirement and keeps the target and balance editable', async () => {
    const saved = picture(); saved.facts.records[0] = { ...saved.facts.records[0], kind: 'debt', debtType: 'card', target: { amountPaise: null, status: 'unknown' }, outstanding: { amountPaise: 8000000, status: 'exact' } };
    render(<FinancialContext {...controls} snapshot={saved} />);
    expect(screen.getByRole('button', { name: 'Edit Rent target' })).toHaveTextContent('Unknown');
    expect(screen.getByRole('button', { name: 'Edit Rent required amount' })).toHaveTextContent('₹12,000');
    const row = screen.getByRole('listitem', { name: 'Rent' });
    expect(row.querySelector('.card-record-amount')).toHaveTextContent('Minimum payment−₹12,000');
    expect(row).not.toHaveTextContent('includes minimum');
    await userEvent.click(within(row).getByText('Details', { selector: 'summary' }));
    expect(screen.getByRole('button', { name: 'Edit Rent outstanding' })).toHaveTextContent('₹80,000');
    expect(row).toHaveTextContent('Intended payment');
  });

  it('uses the selected event scheduleIndex for an inline foreign occurrence correction', async () => {
    const saved = picture();
    const conversion = { currency: 'USD', rate: '83.5', rateStatus: 'estimate' as const, rateDate: '2026-09-12', fee: '50.25', feeStatus: 'exact' as const };
    saved.facts.records[1].schedule.amounts = [{ amount: '100', status: 'exact', conversion }, { amount: '200.25', status: 'estimate', conversion }];
    saved.facts.records[1].amount = { amountPaise: null, status: 'unknown' };
    saved.plan.events.push({ ...saved.plan.events[0], id: 'salary:second', recordId: 'salary', kind: 'income', label: 'Salary', amountPaise: 1667063, amountStatus: 'estimate', scheduleIndex: 1, date: '2026-09-25', source: saved.facts.records[1].schedule.amounts[1] });
    companion(saved); saved.workspace!.cards!.find(card => card.id === 'timeline')!.eventIds = ['rent:2026-09-13', 'salary:second'];
    render(<FinancialContext {...controls} snapshot={saved} />);
    const row = screen.getByRole('listitem', { name: 'Salary' });
    expect(row).toHaveTextContent('USD 200.25'); expect(row).toHaveTextContent('Occurrence 2 of 2');
    expect(screen.getByLabelText('Salary calculated net INR')).toHaveTextContent('₹16,670.63');
    expect(within(screen.getByLabelText('Salary calculated net INR')).queryByRole('button')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit Salary occurrence 2 amount' }));
    const input = screen.getByRole('textbox', { name: 'Salary occurrence 2 amount (USD)' }); expect(input).toHaveValue('200.25');
    fireEvent.change(input, { target: { value: '225.75' } }); await userEvent.click(screen.getByRole('button', { name: 'Save Salary occurrence 2 amount' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: 0, records: [{ id: 'salary', delete: false, distinct: false, schedule: { amounts: [saved.facts.records[1].schedule.amounts[0], { amount: '225.75', status: 'estimate', conversion }] } }] } });
    expect(screen.getByLabelText('Salary calculated net INR')).toHaveTextContent('₹16,670.63');
  });

  it('keeps an absent loan intention editable without replacing the known requirement', async () => {
    const saved = picture(); saved.facts.records[0] = { ...saved.facts.records[0], kind: 'debt', debtType: 'loan', target: null };
    render(<FinancialContext {...controls} snapshot={saved} />);
    const row = screen.getByRole('listitem', { name: 'Rent' });
    expect(row.querySelector('.card-record-amount')).toHaveTextContent('Required payment−₹12,000');
    expect(row).not.toHaveTextContent('Minimum');
    await userEvent.click(within(row).getByRole('button', { name: 'Edit Rent target' }));
    await userEvent.selectOptions(screen.getByLabelText('Rent target certainty'), 'exact');
    await userEvent.type(screen.getByRole('textbox', { name: 'Rent target' }), '15000');
    await userEvent.click(screen.getByRole('button', { name: 'Save Rent target' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', source: 'humanCardEdit', changes: { expectedRevision: 0,
      records: [{ id: 'rent', delete: false, distinct: false, target: { amount: '15000', status: 'exact' } }] } });
    expect(screen.getByRole('button', { name: 'Edit Rent required amount' })).toHaveTextContent('₹12,000');
  });

  it('preserves later payment risk and pairs a reserve date with its own amount, not the maximum', () => {
    const saved = picture();
    saved.facts.reservePaise = 500000;
    saved.plan.reserveShortfallPaise = 200000;
    saved.workspace!.results!.find(result => result.id === 'reserveShortfall')!.amountPaise = 200000;
    saved.plan.timingRisks = [{ date: saved.plan.firstGap!.date, exposurePaise: saved.plan.firstGap!.amountPaise, remainingGapPaise: 0 }];
    saved.plan.decisionAssessment!.consequences!.push(
      { id: 'later', kind: 'cashExposure', amountPaise: 50000, date: '2026-09-20', eventIds: [] },
      { id: 'reserve', kind: 'reserveBreach', amountPaise: 100000, date: '2026-09-14', eventIds: [] },
    );
    render(<FinancialContext {...controls} snapshot={saved} />);
    const cash = screen.getByRole('article', { name: 'Cash & timing' });
    expect(within(cash).getByLabelText('Timing risk')).toHaveTextContent('₹7,000');
    expect(cash).toHaveTextContent('Later payment risk · ₹500 · 20 Sept');
    expect(cash).toHaveTextContent('Largest shortfall · ₹16,000 · 18 Sept');
    expect(cash).toHaveTextContent('Buffer at risk · ₹1,000 below reserve · 14 Sept. Largest buffer shortfall: ₹2,000.');
    expect(cash).not.toHaveTextContent('₹2,000 below reserve · 14 Sept');
  });

  it.each([0, 200000])('qualifies a later peak timing exposure with %i paise remaining without changing the first funding gap', remainingGapPaise => {
    const saved = picture();
    saved.plan.firstGap = { date: '2026-09-14', amountPaise: 100000 };
    saved.plan.peakGapPaise = 500000; saved.plan.peakGapDate = '2026-09-16';
    saved.plan.timingRisks = [{ date: '2026-09-16', exposurePaise: 500000, remainingGapPaise }];
    render(<FinancialContext {...controls} snapshot={saved} />);
    const cash = screen.getByRole('article', { name: 'Cash & timing' });
    expect(within(cash).getByLabelText('First shortfall')).toHaveTextContent('₹1,000First shortfall · 14 Sept');
    expect(within(cash).queryByLabelText('Timing risk')).not.toBeInTheDocument();
    const peak = within(cash).getByText(/^Largest timing exposure/);
    expect(peak).toHaveTextContent('Largest timing exposure · ₹5,000 · 16 Sept · Needed before same-day income.');
    expect(peak).toHaveTextContent(remainingGapPaise > 0 ? '₹2,000 still unfunded after included income.' : 'No remaining gap after included income; payment timing is not guaranteed.');
    expect(peak).not.toHaveTextContent('₹5,000 still unfunded');
  });

  it('keeps genuine peak and later funding-risk labels unchanged when only the first gap is a timing risk', () => {
    const saved = picture();
    saved.plan.timingRisks = [{ date: saved.plan.firstGap!.date, exposurePaise: saved.plan.firstGap!.amountPaise, remainingGapPaise: 0 }];
    saved.plan.decisionAssessment!.consequences!.push({ id: 'later', kind: 'cashExposure', amountPaise: 1600000, date: '2026-09-18', eventIds: [] });
    render(<FinancialContext {...controls} snapshot={saved} />);
    const cash = screen.getByRole('article', { name: 'Cash & timing' });
    expect(within(cash).getByLabelText('Timing risk')).toHaveTextContent('₹7,000Timing risk · 13 Sept');
    expect(within(cash).getByText(/^Largest shortfall/).textContent).toBe('Largest shortfall · ₹16,000 · 18 Sept');
    expect(within(cash).getByText(/^Later payment risk/).textContent).toBe('Later payment risk · ₹16,000 · 18 Sept');
    expect(cash).not.toHaveTextContent('Needed before same-day income');
  });

  it('refreshes peak and later timing qualifications from corrected accepted plans, including residual changes', () => {
    const saved = picture(); saved.accepted = scenario('accepted');
    saved.accepted.plan.firstGap = { date: '2026-09-14', amountPaise: 100000 };
    saved.accepted.plan.peakGapPaise = 500000; saved.accepted.plan.peakGapDate = '2026-09-16';
    saved.accepted.plan.timingRisks = [
      { date: '2026-09-14', exposurePaise: 100000, remainingGapPaise: 0 },
      { date: '2026-09-16', exposurePaise: 500000, remainingGapPaise: 0 },
    ];
    saved.accepted.plan.decisionAssessment!.consequences = [{ id: 'later', kind: 'cashExposure', amountPaise: 500000, date: '2026-09-16', eventIds: [] }];
    saved.workspace!.results!.find(result => result.id === 'firstGap')!.state = 'estimated';
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} stale />);
    const cash = screen.getByRole('article', { name: 'Cash & timing' });
    expect(screen.getByRole('status')).toHaveTextContent('Updates paused · showing saved figures');
    expect(within(cash).getByRole('button', { name: 'Edit Cash at plan start' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(cash).getByLabelText('Timing risk')).toHaveTextContent('₹1,000Timing risk · 14 Sept');
    expect(cash).toHaveTextContent('Includes estimates');
    expect(cash).not.toHaveTextContent('₹16,000');
    const peak = within(cash).getByText(/^Largest timing exposure/);
    const later = within(cash).getByText(/^Later payment risk/);
    expect(peak).toHaveTextContent('Largest timing exposure · ₹5,000 · 16 Sept · Needed before same-day income. No remaining gap after included income; payment timing is not guaranteed.');
    expect(later).toHaveTextContent('Later payment risk · ₹5,000 · Needed before same-day income · 16 Sept. No remaining gap after included income; payment timing is not guaranteed.');
    const receipt = structuredClone(saved); receipt.revision++; receipt.sequence++;
    receipt.accepted!.plan.timingRisks![1].remainingGapPaise = 200000;
    rerender(<FinancialContext {...controls} snapshot={receipt} />);
    expect(peak).toHaveTextContent('₹2,000 still unfunded after included income.');
    expect(later).toHaveTextContent('₹2,000 still unfunded after included income.');
    expect(later).not.toHaveTextContent('No remaining gap');
    const corrected = structuredClone(receipt); corrected.revision++; corrected.sequence++;
    corrected.accepted!.plan.timingRisks = [corrected.accepted!.plan.timingRisks![0]];
    rerender(<FinancialContext {...controls} snapshot={corrected} />);
    expect(peak.textContent).toBe('Largest shortfall · ₹5,000 · 16 Sept');
    expect(later.textContent).toBe('Later payment risk · ₹5,000 · 16 Sept');
    expect(cash).not.toHaveTextContent(/Needed before same-day income|₹2,000 still unfunded/);
    expect(within(cash).getByLabelText('Timing risk')).toHaveTextContent('₹1,000Timing risk · 14 Sept');
    expect(controls.onCommand).not.toHaveBeenCalled();
  });

  it.each([
    { receiptDate: '2026-09-16', label: 'Largest timing exposure' },
    { receiptDate: '2026-09-17', label: 'Largest shortfall' },
  ])('labels the cash-card peak as $label with income on $receiptDate', ({ receiptDate, label }) => {
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
    render(<FinancialContext {...controls} snapshot={companion(saved)} />);
    const cash = screen.getByRole('article', { name: 'Cash & timing' });
    expect(within(cash).getByLabelText('First shortfall')).toHaveTextContent('₹1,000First shortfall · 14 Sept');
    expect(screen.getByLabelText('Projected closing cash')).toHaveTextContent('-₹1,000');
    const peak = within(cash).getByText(/^Largest /);
    expect(peak).toBeVisible();
    expect(peak).toHaveTextContent('₹5,000');
    expect(peak).toHaveTextContent('16 Sept');
    expect(peak).toHaveTextContent(label);
    expect(cash).not.toHaveTextContent(label === 'Largest shortfall' ? 'Largest timing exposure' : 'Largest shortfall');
  });

  it('preserves MoneyPage changeNotes formatting and the earlier-gap qualification', () => {
    const saved = picture();
    const change: components['schemas']['WorkspaceChange'] = { id: 'change', revision: 1, items: [{ id: 'closing', state: 'updated', fields: [{ reference: 'workspace.results.closing.amountPaise', before: 1000000, after: 1500000 }] }] };
    expect(changeNotes(saved, change)).toEqual(['The earlier cash gap amount and date are unchanged.', 'Projected closing cash: ₹10,000.00 → ₹15,000.00']);
  });
});

describe('compact plan changes', () => {
  it('requires every change and removal to be visible before unconditional whole-proposal consent', async () => {
    const saved = picture(); saved.preview = scenario(); saved.accepted = scenario('accepted');
    saved.accepted.adjustments[0] = { ...saved.accepted.adjustments[0], eventId: 'removed', label: 'Prior purchase' };
    saved.preview.adjustments = Array.from({ length: 3 }, (_, index) => ({ ...saved.preview!.adjustments[0], eventId: `change${index}`, label: `Purchase ${index}` }));
    saved.preview.removedAssumptionIds = ['removed']; companion(saved);
    render(<FinancialContext {...controls} snapshot={saved} />);
    const proposal = screen.getByRole('article', { name: 'Plan changes' });
    expect(within(proposal).getAllByRole('listitem')).toHaveLength(2); expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more changes' }));
    expect(proposal).toHaveTextContent('Purchase 2'); expect(proposal).toHaveTextContent('Prior purchase'); expect(proposal).toHaveTextContent('Remove saved assumption');
    expect(screen.getByRole('checkbox')).toHaveAccessibleName(/unconditionally—not dependent on uncertain income or payee agreement/);
    await userEvent.click(screen.getByRole('checkbox')); await userEvent.click(screen.getByRole('button', { name: 'Accept planning assumptions' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'acceptPreview', previewId: saved.preview.id, confirmed: true, consentScope: 'unconditional' });
    expect(proposal).toHaveTextContent('First shortfall · Calculated'); expect(proposal).not.toHaveTextContent('Projected closing cash');
    expect(screen.getByRole('alert')).toHaveTextContent('Decision not confirmed');
  });

  it.each(['sequence', 'revision', 'stale', 'locked', 'proposalActive'] as const)('invalidates consent after %s changes', async field => {
    const saved = picture(); saved.preview = scenario(); companion(saved);
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('checkbox')); expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
    const changed = structuredClone(saved); if (field === 'revision' || field === 'sequence') changed[field]++;
    rerender(<FinancialContext {...controls} snapshot={changed} {...(field === 'locked' || field === 'stale' ? { [field]: true } : field === 'proposalActive' ? { proposalActive: false } : {})} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
    rerender(<FinancialContext {...controls} snapshot={saved} />); expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it.each(['rejectPreview', 'discardPreview'] as const)('keeps %s distinct and displays only the authoritative decision state', async type => {
    const saved = picture(); saved.preview = scenario(); companion(saved);
    const { rerender } = render(<FinancialContext {...controls} snapshot={saved} />);
    await userEvent.click(screen.getByRole('button', { name: type === 'rejectPreview' ? 'Reject preview' : 'Close preview' }));
    expect(controls.onCommand).toHaveBeenCalledExactlyOnceWith({ type, previewId: saved.preview.id });
    expect(screen.getByRole('article', { name: 'Plan changes' })).toBeVisible();
    const receipt = structuredClone(saved); receipt.preview = null;
    receipt.workspace!.change = { id: 'receipt', revision: 0, items: [{ id: 'preview', state: type === 'rejectPreview' ? 'rejected' : 'discarded' }] };
    rerender(<FinancialContext {...controls} snapshot={companion(receipt)} />);
    expect(screen.queryByRole('article', { name: 'Plan changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(type === 'rejectPreview' ? 'refusal saved' : 'not a refusal');
  });

  it('merges saved and invalidated assumptions into one card without source edit buttons', () => {
    const saved = picture(); saved.accepted = scenario('accepted'); saved.invalidatedAssumptions = [{ eventId: 'rent:2026-09-13', reason: 'Amount changed.' }]; companion(saved);
    render(<FinancialContext {...controls} snapshot={saved} />);
    const proposal = screen.getByRole('article', { name: 'Plan changes' });
    expect(proposal).toHaveTextContent('Saved assumptions · not paid'); expect(proposal).toHaveTextContent('Needs fresh consent');
    expect(within(proposal).queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument(); expect(within(proposal).queryByRole('checkbox')).not.toBeInTheDocument();
  });
});