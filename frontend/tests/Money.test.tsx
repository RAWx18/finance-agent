// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api';
import type { Snapshot } from '../src/api';
import { MoneyOverview } from '../src/MoneyOverview';
import { MoneyChecks } from '../src/MoneyChecks';
import { MoneyEvent, MoneyUpcoming } from '../src/MoneyUpcoming';
import { MoneyRecords } from '../src/MoneyRecords';
import { MoneyPrint } from '../src/MoneyPrint';
import { MoneyChanges } from '../src/MoneyChanges';
import { MoneyEdit } from '../src/MoneyEdit';
import { PagedList } from '../src/PagedList';
import { initialState } from '../src/session';
import { changeNotes } from '../src/FinancialContext';
import { moneyRoutes } from '../src/moneyRoutes';
import { returnPath } from '../src/Login';
import { appRouter, mockAuth } from './appSupport';
import { choiceSnapshot, planningSnapshot, scenario, settings, snapshot, Stream } from './fixtures';
import { projectWorkspace } from './workspace';

beforeEach(() => {
  mockAuth(); Stream.instances = []; vi.stubGlobal('EventSource', Stream);
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', cleanupConfirmed: true, message: null });
  vi.spyOn(api, 'startCall'); vi.spyOn(api, 'start');
  vi.spyOn(api, 'current').mockResolvedValue(planningSnapshot());
  vi.spyOn(api, 'save').mockResolvedValue({ ...planningSnapshot(), revision: 1, sequence: 1 });
  vi.spyOn(api, 'options').mockResolvedValue({ revision: 0, today: settings.today, options: [] });
});

/** Opens a Money route with a supplied snapshot and delivers its live-update fixture. */
async function open(path = '/money', saved = planningSnapshot()) {
  vi.mocked(api.current).mockResolvedValue(saved);
  const router = appRouter(path); render(<RouterProvider router={router} />);
  await waitFor(() => expect(Stream.instances).toHaveLength(1));
  act(() => Stream.instances[0].emit('snapshot', saved));
  await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' })).not.toHaveAttribute('aria-disabled', 'true'));
  return router;
}

it('bounds shared lists and keeps keyboard-operable paging', async () => {
  const user = userEvent.setup();
  render(<PagedList label="Test items" className="items">{Array.from({ length: 25 }, (_, index) => <li key={index}>Item {index + 1}</li>)}</PagedList>);
  const list = screen.getByRole('list', { name: 'Test items' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(20);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  screen.getByRole('button', { name: 'Next' }).focus();
  await user.keyboard('{Enter}');
  expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  expect(list).toHaveTextContent('Item 21');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('renders labels as text, signed saved balances and excluded income in current upcoming events', () => {
  const saved = planningSnapshot();
  saved.facts.records = [{ ...saved.facts.records[0], id: 'income', kind: 'income', label: '<img src=x onerror=alert(1)>',
    amount: { amountPaise: 10000, status: 'estimate' }, reliability: 'uncertain' }];
  saved.plan.events = [{ ...saved.plan.events[0], id: 'income:2026-09-20', recordId: 'income', kind: 'income',
    label: saved.facts.records[0].label, date: '2026-09-20', originalDueDate: '2026-09-20', amountPaise: 10000, amountStatus: 'estimate', included: false, balancePaise: -100 }];
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  const event = screen.getByRole('listitem', { name: saved.facts.records[0].label });
  expect(event).toHaveTextContent('+₹100.00');
  expect(event).toHaveTextContent('Calculated-₹1.00');
  expect(event).toHaveTextContent('Estimated');
  expect(event).toHaveTextContent('Not counted in balances');
  expect(screen.getByRole('region', { name: 'Upcoming money and payments' })).toHaveTextContent('Same-day payments come before income');
});

it.each(Object.entries(moneyRoutes))('opens exact route %s without microphone, writes or fetching choices', async (path, title) => {
  await open(path);
  expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
  expect(document.title).toBe(`${title} · Cash flow`);
  expect(returnPath(path)).toBe(path);
  expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
  expect(api.options).not.toHaveBeenCalled();
});

it.each(['/figures', '/money/bills', '/money/debts/private-id', '/money/unknown', '/money/'])('rejects non-whitelisted route %s and login redirects', async path => {
  render(<RouterProvider router={appRouter(path)} />);
  await screen.findByRole('heading', { name: 'Page not found' });
  expect(returnPath(path)).toBe('/app'); expect(api.current).not.toHaveBeenCalled();
});

it('leads with the early gap even with a positive closing result and gives one selected action', async () => {
  await open();
  const attention = screen.getByRole('region', { name: 'What needs attention' });
  expect(within(attention).getByText('₹7,000', { selector: 'strong' })).toBeVisible();
  expect(attention).toHaveTextContent('First shortfall · 13 Sept');
  expect(attention).toHaveTextContent('Discuss payment options');
  await userEvent.click(within(attention).getByRole('button', { name: 'Discuss payment options' }));
  expect(screen.getByRole('dialog', { name: 'Your next step' })).toHaveTextContent('Contact the provider before the due date.');
  await userEvent.click(screen.getByRole('button', { name: 'Close your next step' }));
  expect(screen.getByRole('region', { name: 'Money in this plan' })).toHaveTextContent('Closing forecast₹10,000');
  await userEvent.click(screen.getByRole('button', { name: 'View calculation' }));
  const detail = screen.getByRole('dialog', { name: 'Plan details' });
  expect(detail).toHaveTextContent('₹10,000'); expect(detail).toHaveTextContent('₹16,000');
  expect(detail).toHaveTextContent('not amounts to add together');
});

it('shows cash at the original plan date, included income and distinct upcoming records', async () => {
  const saved = planningSnapshot();
  saved.plan.events = Array.from({ length: 8 }, (_, index) => ({ ...saved.plan.events[0], id: `rent-${index}` }));
  await open('/money', projectWorkspace(saved));
  const cash = screen.getByRole('region', { name: 'Money in this plan' });
  expect(cash).toHaveTextContent('Starting cash₹5,00011 Sept');
  expect(cash).toHaveTextContent('Money coming in');
  expect(within(screen.getByRole('region', { name: 'Next money and payments' })).getAllByRole('listitem')).toHaveLength(1);
  expect(cash).not.toHaveTextContent(/today|Current balance|verified/);
});

it('keeps all ordinary views on the accepted plan, never the preview', async () => {
  const saved = planningSnapshot(); saved.accepted = scenario('accepted'); saved.preview = scenario('preview');
  saved.accepted.plan.firstGap = { date: '2026-09-14', amountPaise: 345600 };
  saved.accepted.plan.events[0].balancePaise = -345600;
  saved.preview.plan.firstGap = null; saved.preview.plan.closingPaise = 9999900;
  const router = await open('/money', projectWorkspace(saved));
  expect(screen.getByRole('region', { name: 'What needs attention' })).toHaveTextContent('₹3,456');
  await act(async () => { await router.navigate('/money/upcoming'); });
  expect(screen.getByRole('region', { name: 'Upcoming money and payments' })).toHaveTextContent('-₹3,456.00');
  expect(screen.getByRole('region', { name: 'Upcoming money and payments' })).not.toHaveTextContent('₹99,999.00');
});

it('removes the clear plan signal when live updates are lost and restores it only on a snapshot', async () => {
  const saved = planningSnapshot();
  saved.plan.firstGap = null; saved.plan.peakGapPaise = 0; saved.plan.reserveShortfallPaise = 0;
  saved.plan.projectionPartial = false; saved.plan.budgetBasis.datedProjectionComplete = true;
  saved.plan.decisionAssessment!.outcome!.branch = 'fits';
  saved.plan.decisionAssessment!.outcome!.readiness = 'ready';
  await open('/money', saved);
  const summary = screen.getByRole('region', { name: 'What needs attention' });
  expect(summary).toHaveAttribute('data-tone', 'clear');
  act(() => Stream.instances[0].onerror?.());
  expect(screen.getByText('Updates paused · showing your saved plan')).toBeVisible();
  expect(summary).toHaveAttribute('data-tone', 'neutral');
  expect(screen.getByRole('button', { name: 'Correct starting cash' })).toBeDisabled();
  act(() => Stream.instances[0].onopen?.());
  expect(summary).toHaveAttribute('data-tone', 'neutral');
  act(() => Stream.instances[0].emit('snapshot', saved));
  expect(summary).toHaveAttribute('data-tone', 'clear');
  expect(api.save).not.toHaveBeenCalled();
});

it('separates required, intended-including-minimum and outstanding debt; absence is not unknown or zero', async () => {
  const saved = planningSnapshot();
  saved.facts.records = [{ ...saved.facts.records[0], id: 'card', kind: 'debt', debtType: 'card', label: 'Card', amount: { status: 'exact', amountPaise: 50000 }, target: { status: 'estimate', amountPaise: 1000000 }, outstanding: { status: 'exact', amountPaise: 2500000 } },
    { ...saved.facts.records[0], id: 'loan', kind: 'debt', label: 'Loan', amount: { status: 'unknown', amountPaise: null }, target: null, outstanding: { status: 'unknown', amountPaise: null } }];
  await open('/money/debts', projectWorkspace(saved));
  const card = screen.getByRole('listitem', { name: 'Card' });
  expect(card).toHaveTextContent('Required / minimum₹500.00Reported');
  expect(card).toHaveTextContent('Intended · includes minimum₹10,000.00Estimated');
  expect(card).toHaveTextContent('Outstanding balance₹25,000.00Reported');
  const loan = screen.getByRole('listitem', { name: 'Loan' });
  expect(loan).toHaveTextContent('Not supplied'); expect(loan).toHaveTextContent('Unknown'); expect(loan).not.toHaveTextContent('₹0.00');
  expect(screen.queryByText(/Total debt|₹25,000.00.*₹10,500/)).not.toBeInTheDocument();
});

it('searches long names, filters essential versus other spending and bounds 105 records', async () => {
  const saved = planningSnapshot();
  saved.facts.records = Array.from({ length: 105 }, (_, index) => ({ ...saved.facts.records[0], id: `item-${index}`, label: `Household item ${index} ${index === 104 ? 'distinguishing nickname' : ''}`, kind: index === 104 ? 'optional' as const : 'essential' as const }));
  await open('/money/spending', projectWorkspace(saved));
  expect(within(screen.getByRole('list', { name: 'Money items' })).getAllByRole('listitem')).toHaveLength(8);
  expect(screen.getByText('105 of 105 items')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Page 2 of 14')).toBeVisible();
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search item names' }), 'nickname');
  expect(screen.getByText('1 of 105 items')).toBeVisible();
  expect(screen.getByRole('listitem', { name: /distinguishing nickname/ })).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText('Filter items'), 'essential');
  expect(screen.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  await userEvent.clear(screen.getByRole('searchbox')); await userEvent.selectOptions(screen.getByLabelText('Filter items'), 'optional');
  expect(screen.getByText('1 of 105 items')).toBeVisible();
});

it('preserves the identity, all unrelated fields and decision state in a focused correction', async () => {
  await open('/money/spending');
  await userEvent.click(screen.getByRole('button', { name: 'Edit Rent' }));
  const dialog = screen.getByRole('dialog', { name: 'Correct Rent' });
  await userEvent.clear(within(dialog).getByLabelText('Amount (₹)')); await userEvent.type(within(dialog).getByLabelText('Amount (₹)'), '12500.10');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save correction' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({ expectedRevision: 0, operation: { type: 'updateFacts', changes: { expectedRevision: 0, records: [{ id: 'rent', delete: false, distinct: false, amount: { amount: '12500.10', status: 'exact' } }] } } });
  expect(Object.keys(vi.mocked(api.save).mock.calls[0][0].operation)).toEqual(['type', 'changes']);
  expect(dialog).toHaveTextContent('Saved. Your plan and its calculations use this correction.');
});

it.each([
  ['target', 'unknown'], ['target', 'absent'], ['outstanding', 'unknown'], ['outstanding', 'absent'],
] as const)('saves explicit %s %s without inventing zero or changing the minimum', async (field, status) => {
  const saved = planningSnapshot(); saved.facts.records[0].kind = 'debt';
  saved.facts.records[0][field] = status === 'unknown' ? null : { status: 'unknown', amountPaise: null };
  const original = structuredClone(saved);
  const onCommand = vi.fn();
  render(<MoneyEdit target={{ recordId: 'rent', field }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  expect(screen.getByLabelText('Amount certainty')).toHaveValue(status === 'unknown' ? 'absent' : 'unknown');
  await userEvent.selectOptions(screen.getByLabelText('Amount certainty'), status);
  expect(screen.getByLabelText('Amount (₹)')).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, [field]: status === 'absent' ? null : { amount: null, status: 'unknown' } }],
  } });
  expect(saved).toEqual(original);
});

it.each([
  ['estimate', '2026-09-22', 'estimate'], ['estimate', '', 'unknown'],
  ['exact', '', 'unknown'], ['unknown', '2026-09-24', 'exact'],
] as const)('preserves date certainty from %s to %s as %s in a focused patch', async (certainty, date, status) => {
  const saved = planningSnapshot();
  saved.facts.records[0].schedule = { date: certainty === 'unknown' ? null : '2026-09-20', recurrence: 'monthly', certainty, basis: 'payment' };
  const original = structuredClone(saved);
  const onCommand = vi.fn();
  render(<MoneyEdit target={{ recordId: 'rent', field: 'schedule.date' }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  expect(screen.getByLabelText('Date certainty')).toHaveValue(certainty);
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
  expect(screen.getByLabelText('Date certainty')).toHaveValue(status);
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { date: date || null, certainty: status } }],
  } });
  expect(saved).toEqual(original);
});

it('changes recurrence without replacing the unknown date, income reliability or reviewed coverage', async () => {
  const saved = planningSnapshot();
  saved.facts.records[0] = { ...saved.facts.records[0], kind: 'income', reliability: 'uncertain',
    amount: { amountPaise: null, status: 'unknown' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once', basis: 'payment' } };
  saved.facts.coverage.income = 'reviewed';
  const original = structuredClone(saved);
  const onCommand = vi.fn();
  render(<MoneyEdit target={{ recordId: 'rent', field: 'recurrence' }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  await userEvent.selectOptions(screen.getByLabelText('Repeats'), 'fortnightly');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [{ id: 'rent', delete: false, distinct: false, schedule: { recurrence: 'fortnightly' } }],
  } });
  expect(saved).toEqual(original);
});

it.each(['estimate', 'unknown', 'exact'] as const)('keeps %s opening money distinct from implicit zero', async status => {
  const saved = planningSnapshot(); saved.facts.opening.status = 'estimate';
  const onCommand = vi.fn();
  render(<MoneyEdit target={{ field: 'opening' }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  expect(screen.getByLabelText('Amount certainty')).toHaveValue('estimate');
  if (status !== 'unknown') fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: status === 'exact' ? '0' : '123.45' } });
  await userEvent.selectOptions(screen.getByLabelText('Amount certainty'), status);
  if (status === 'unknown') expect(screen.getByLabelText('Amount (₹)')).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    opening: { amount: status === 'unknown' ? null : status === 'exact' ? '0' : '123.45', status },
  } });
});

it.each(['123.45', '123.46', '1.234'])('validates %s against the configured money limit and exact precision', async value => {
  const saved = planningSnapshot();
  const onCommand = vi.fn();
  render(<MoneyEdit target={{ field: 'opening' }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings: { ...settings, maxMoneyPaise: 12345 } }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  if (value === '123.45') expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: {
    expectedRevision: 0, opening: { amount: value, status: 'exact' },
  } });
  else {
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('non-negative rupee amount with up to two decimal places');
  }
});

it.each([true, false])('requires category coverage consistent with item presence: %s', async present => {
  const saved = present ? planningSnapshot() : snapshot();
  const onCommand = vi.fn();
  render(<MoneyEdit target={{ kind: 'essential', field: 'coverage' }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  const coverage = screen.getByLabelText('Review category');
  expect(within(coverage).getByRole('option', { name: present ? 'None reported' : 'Reviewed all items' })).toBeDisabled();
  await userEvent.selectOptions(coverage, present ? 'none' : 'reviewed');
  expect(coverage).not.toHaveValue(present ? 'none' : 'reviewed');
  expect(onCommand).not.toHaveBeenCalled();
  await userEvent.selectOptions(coverage, present ? 'reviewed' : 'none');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    coverage: { essential: present ? 'reviewed' : 'none' },
  } });
});

it.each(['label', 'add'] as const)('rejects a blank %s name and submits only the intended item fields', async field => {
  const saved = planningSnapshot();
  const onCommand = vi.fn();
  render(<MoneyEdit target={field === 'add' ? { kind: 'essential', field } : { recordId: 'rent', field }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Item name'), { target: { value: '  ' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a name');
  expect(onCommand).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Item name'), { target: { value: ' Home rent ' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'updateFacts', changes: { expectedRevision: 0,
    records: [field === 'add' ? { kind: 'essential', label: 'Home rent', delete: false, distinct: true }
      : { id: 'rent', label: 'Home rent', delete: false, distinct: false }],
  } });
});

it('requires exact item removal confirmation without deleting similarly named records', async () => {
  await open('/money/spending');
  await userEvent.click(screen.getByRole('button', { name: 'Remove Rent' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove Rent?' });
  expect(api.save).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove this item' }));
  expect(vi.mocked(api.save).mock.calls[0][0].operation).toMatchObject({ type: 'updateFacts', changes: { records: [{ id: 'rent', delete: true, distinct: false }] } });
});

it('corrects the cash buffer without replacing starting cash or financial facts', async () => {
  await open();
  await userEvent.click(screen.getByRole('button', { name: 'Set a cash buffer' }));
  const dialog = screen.getByRole('dialog', { name: 'Cash to keep aside' });
  expect(dialog).toHaveTextContent('not another expense or extra money');
  expect(screen.queryByLabelText('Amount certainty')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '750.25' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'updateFacts', changes: { expectedRevision: 0, reserve: '750.25' } });
});

it('keeps exactness distinct from provenance in income corrections', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].kind = 'income';
  await open('/money/income', projectWorkspace(saved));
  await userEvent.click(screen.getByRole('button', { name: 'Edit Rent' }));
  expect(screen.getByRole('option', { name: 'Exact amount' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Estimated amount' })).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toHaveTextContent('Only exact amounts and conversion assumptions with exact dates and reliable receipts count');
});

it('bounds item creation using the configured limit without sending a mutation', async () => {
  const saved = planningSnapshot(); const onCommand = vi.fn();
  render(<MoneyEdit target={{ kind: 'essential', field: 'add' }} snapshot={saved}
    state={{ ...initialState, phase: 'ready', connection: 'live', snapshot: saved, settings: { ...settings, maxRecords: 1 } }}
    active onClose={vi.fn()} onCommand={onCommand} onRetry={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Another bill' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(screen.getByRole('alert')).toHaveTextContent('reached its item limit'); expect(onCommand).not.toHaveBeenCalled();
});

it('names the corrected debt field and prioritizes a changed first gap', () => {
  const saved = planningSnapshot(); saved.facts.records[0].kind = 'debt';
  const notes = changeNotes(saved, { id: 'effect', revision: 1, items: [{ id: 'debt-correction', state: 'updated', cardIds: [], recordIds: ['rent'], resultIds: [], fields: [
    { reference: 'facts.records.rent.target.amountPaise', before: 400000, after: 450025 },
    { reference: 'facts.records.rent.outstanding.amountPaise', before: 2000000, after: 2500075 },
    { reference: 'workspace.results.firstGap.amountPaise', before: 700000, after: 900000 },
  ] }] });
  expect(notes[0]).toBe('First cash gap: ₹7,000.00 → ₹9,000.00');
  expect(notes).toContain('Rent · intended payment: ₹4,000.00 → ₹4,500.25');
  expect(notes).toContain('Rent · outstanding balance: ₹20,000.00 → ₹25,000.75');
});

it('does not claim a superseded correction is the active value', async () => {
  const saved = planningSnapshot(); const state = { ...initialState, phase: 'ready' as const, connection: 'live' as const, snapshot: saved, settings };
  const props = { target: { field: 'opening' as const }, snapshot: saved, state, active: true, onClose: vi.fn(), onCommand: vi.fn(), onRetry: vi.fn() };
  const view = render(<MoneyEdit {...props} />);
  fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '100' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  view.rerender(<MoneyEdit {...props} snapshot={{ ...saved, revision: 2, sequence: 2 }} state={{ ...state, message: 'The action was confirmed, but later changes superseded it.' }} />);
  expect(screen.getByRole('status')).toHaveTextContent('Later changes superseded it');
  expect(screen.getByRole('status')).not.toHaveTextContent('calculations use this correction');
});

it('serializes amount conflict resolutions as decimal strings, not read-side paise', async () => {
  const saved = planningSnapshot();
  Object.assign(saved.facts, { conflicts: [{ id: 'dispute', recordId: 'rent', field: 'amount', values: [{ id: 'a', amountPaise: 1200000, status: 'exact' }, { id: 'b', amountPaise: 1250050, status: 'estimate' }] }] });
  await open('/money/spending', projectWorkspace(saved));
  await userEvent.click(screen.getByRole('button', { name: 'Details for Rent' }));
  await userEvent.click(screen.getByRole('button', { name: 'Resolve Rent · Amount' }));
  await userEvent.click(screen.getByRole('radio', { name: 'Report 2: ₹12,500.50 · Estimated' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirm selected report' }));
  expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'updateFacts', changes: { expectedRevision: 0, resolutions: [{ conflictId: 'dispute', value: { id: 'b', status: 'estimate', amount: '12500.50' } }] } });
});

it('keeps a stale correction for reference and requires closing and reopening, not overwriting', async () => {
  await open('/money');
  await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
  await userEvent.clear(screen.getByLabelText('Amount (₹)')); await userEvent.type(screen.getByLabelText('Amount (₹)'), '99');
  const saved = planningSnapshot(); saved.revision = 2; saved.sequence = 2; saved.facts.opening.amountPaise = 20000;
  act(() => Stream.instances[0].emit('snapshot', saved));
  expect(screen.getByLabelText('Amount (₹)')).toHaveValue('99'); expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Close and reopen');
  await userEvent.click(screen.getByRole('button', { name: /Close correct cash/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Discard correction' }));
  await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
  expect(screen.getByLabelText('Amount (₹)')).toHaveValue('200.00'); expect(api.save).not.toHaveBeenCalled();
});

it('retries an uncertain correction using the identical UUID and body', async () => {
  vi.mocked(api.save).mockRejectedValueOnce(new TypeError('offline'));
  await open(); await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
  await userEvent.clear(screen.getByLabelText('Amount (₹)')); await userEvent.type(screen.getByLabelText('Amount (₹)'), '123.45');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  const retry = await screen.findByRole('button', { name: 'Retry same save' });
  expect(screen.getByLabelText('Amount (₹)')).toBeDisabled();
  const command = vi.mocked(api.save).mock.calls[0][0];
  await userEvent.click(retry); await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.save).mock.calls[1][0]).toBe(command);
});

it('blocks leaving a correction until discarded and resets proposal consent', async () => {
  const saved = planningSnapshot(); saved.preview = scenario(); const router = await open('/money/changes', projectWorkspace(saved));
  await userEvent.click(screen.getByRole('checkbox')); expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeEnabled();
  await act(async () => { await router.navigate('/money'); });
  await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
  await userEvent.clear(screen.getByLabelText('Amount (₹)')); await userEvent.type(screen.getByLabelText('Amount (₹)'), '20');
  await act(async () => { await router.navigate('/app'); });
  expect(router.state.location.pathname).toBe('/money');
  await userEvent.click(screen.getByRole('button', { name: /Close correct cash/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Discard correction' }));
  await act(async () => { await router.navigate('/money/changes'); });
  expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Accept planning assumptions' })).toBeDisabled();
});

it('propagates correction snapshots, rejects older SSE and preserves browser back/forward', async () => {
  const router = await open('/money');
  await act(async () => { await router.navigate('/money/spending'); });
  const saved = planningSnapshot(); saved.sequence = 2; saved.revision = 1; saved.facts.records[0].label = 'Home rent';
  act(() => Stream.instances[0].emit('snapshot', saved)); act(() => Stream.instances[0].emit('snapshot', planningSnapshot()));
  expect(screen.getByRole('heading', { name: 'Home rent' })).toBeVisible();
  await act(async () => { await router.navigate(-1); }); expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Money');
  await act(async () => { await router.navigate(1); }); expect(screen.getByRole('heading', { name: 'Home rent' })).toBeVisible();
  expect(Stream.instances).toHaveLength(1); expect(api.startCall).not.toHaveBeenCalled();
});

it('shows unknown opening and undated items without fabricated zero balances', async () => {
  const saved = snapshot(); saved.facts.records = [{ ...planningSnapshot().facts.records[0], amount: { amountPaise: null, status: 'unknown' }, schedule: { date: null, certainty: 'unknown', recurrence: 'once', basis: 'payment' } }];
  saved.plan.budgetBasis = { datedProjectionComplete: false, unresolvedAmounts: [{ recordId: 'rent', reason: 'missingDate', amount: { amountPaise: null, status: 'unknown' }, recurrence: 'once' }] };
  await open('/money', projectWorkspace(saved));
  const cash = screen.getByRole('region', { name: 'Money in this plan' });
  expect(cash).toHaveTextContent('Starting cashUnknown11 Sept');
  const attention = screen.getByRole('region', { name: 'What needs attention' });
  for (const value of within(attention).queryAllByText('₹0.00', { exact: true })) expect(value).not.toBeVisible();
  expect(within(attention).getByRole('heading', { name: saved.plan.decisionAssessment!.outcome!.summary })).toBeVisible();
  expect(screen.getByRole('button', { name: '1 item needs a date' })).toBeVisible();
});

it('distinguishes loading, empty and failed reads, with no automatic data creation', async () => {
  vi.mocked(api.current).mockRejectedValue(new ApiError(404, { code: 'notFound', message: 'empty' }));
  const router = appRouter('/money'); render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'No plan yet' });
  expect(api.start).not.toHaveBeenCalled(); expect(api.startCall).not.toHaveBeenCalled();
});

// Supplied eligible actions model the server filter; questions require their matching action.
/** Projects a cloned fixture with test-selected actions and their matching questions and choices. */
function moneyProjection(source: Snapshot, eligibleIds?: string[]): Snapshot {
  const saved = projectWorkspace(structuredClone(source));
  const assessment = (saved.accepted?.plan ?? saved.plan).decisionAssessment;
  const actions = (assessment?.actions ?? []).filter(action => !eligibleIds || eligibleIds.includes(action.id));
  const questions = (assessment?.uncertainties ?? []).flatMap(issue => {
    const action = actions.find(action => action.id === `clarify:${issue.id}` || action.kind === 'confirmReceipt' && issue.id === `${action.recordIds[0]}:receipt`);
    return action ? [{ id: issue.id, actionId: action.id, fields: [issue.field], recordIds: issue.recordIds,
      why: issue.reason, resolves: [issue.id], changes: issue.changes, blocks: issue.blocks, beforeDate: issue.beforeDate ?? null, priority: issue.priority }] : [];
  });
  return { ...saved, workspace: { ...saved.workspace, actions, questions,
    choices: (assessment?.choices ?? []).filter(choice => actions.some(action => action.choiceId === choice.id)) } };
}

it('does not resurface a filtered refusal or unavailable question through raw outcome text', () => {
  const source = choiceSnapshot();
  const saved = moneyProjection({ ...source, plan: { ...source.plan, decisionAssessment: {
    ...source.plan.decisionAssessment, outcome: { ...source.plan.decisionAssessment!.outcome!, nextStep: 'Compare the refused purchase again.' },
  } } }, []);
  const onChecks = vi.fn();
  const view = render(<MemoryRouter><MoneyOverview snapshot={saved} blocked={false} onEdit={vi.fn()} onChecks={onChecks} onCommand={vi.fn()} /></MemoryRouter>);
  const attention = screen.getByRole('region', { name: 'What needs attention' });
  expect(within(attention).queryByRole('heading', { name: 'Next step' })).not.toBeInTheDocument();
  expect(attention).not.toHaveTextContent('Compare the refused purchase again.');
  expect(screen.queryByRole('button', { name: 'Compare change' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '1 detail to review' })).toBeVisible();
  view.rerender(<MoneyChecks snapshot={saved} open blocked={false} onClose={vi.fn()} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Needs your check' })).toHaveTextContent(source.plan.decisionAssessment!.uncertainties![0].question);
});

it('chooses an eligible workspace action when the raw selected choice was refused', async () => {
  const saved = moneyProjection(choiceSnapshot(), ['contact:rent:2026-09-13']);
  render(<MemoryRouter><MoneyOverview snapshot={saved} blocked={false} onEdit={vi.fn()} onChecks={vi.fn()} onCommand={vi.fn()} /></MemoryRouter>);
  expect(screen.getByRole('region', { name: 'What needs attention' })).toHaveTextContent('Discuss payment options');
  await userEvent.click(screen.getByRole('button', { name: 'Discuss payment options' }));
  expect(screen.getByRole('dialog', { name: 'Your next step' })).toHaveTextContent('Contact the provider before the due date.');
  expect(screen.queryByRole('button', { name: 'Compare change' })).not.toBeInTheDocument();
});

it.each(['schedule.date', 'schedule', 'reliability', 'controllability', 'target', 'outstanding'] as const)('opens the actual %s issue field and retains non-askable workspace checks', async field => {
  const source = planningSnapshot();
  const issue = { ...source.plan.decisionAssessment!.uncertainties![0], id: `check:${field}`, field, question: `Check ${field}`, recordIds: ['rent'] };
  const saved = moneyProjection({ ...source, plan: { ...source.plan, decisionAssessment: { ...source.plan.decisionAssessment, uncertainties: [], actions: [] } } });
  const onEdit = vi.fn();
  render(<MoneyChecks snapshot={{ ...saved, workspace: { ...saved.workspace, issues: [issue] } }} open blocked={false} onClose={vi.fn()} onEdit={onEdit} onCommand={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Needs your check' })).toHaveTextContent(`Check ${field}`);
  await userEvent.click(screen.getByRole('button', { name: 'Edit Rent' }));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ recordId: 'rent', field: field === 'schedule' ? 'schedule.date' : field });
});

it.each([
  ['reported', 'exact', 'estimate', 'Estimated', 'Intended payment · includes minimum'],
  ['reported', 'estimate', 'exact', 'Reported', 'Intended payment · includes minimum'],
  ['requiredOnly', 'estimate', 'unknown', 'Estimated', 'Required / minimum only'],
  ['assumed', 'estimate', 'exact', 'Saved assumption', 'not paid'],
] as const)('labels %s amounts using their own basis (%s minimum, %s target)', (basis, minimumStatus, targetStatus, status, label) => {
  const source = choiceSnapshot('cardMinimum');
  const record = source.facts.records[1];
  const event = { ...source.plan.events[1], amountBasis: basis, amountPaise: basis === 'requiredOnly' || basis === 'assumed' ? 200000 : 400000,
    amountStatus: basis === 'requiredOnly' ? minimumStatus : targetStatus, requiredPaise: 200000, requiredStatus: minimumStatus };
  const saved = moneyProjection({ ...source, facts: { ...source.facts, records: [{ ...record,
    amount: { status: minimumStatus, amountPaise: 200000 }, target: { status: targetStatus, amountPaise: targetStatus === 'unknown' ? null : 400000 } }] },
    accepted: basis === 'assumed' ? { ...scenario('saved'), adjustments: [{ ...scenario().adjustments[0], eventId: event.id, recordId: record.id, kind: 'card', amountPaise: 200000, minimumPaise: 200000 }], plan: { ...source.plan, events: [event] } } : null,
    plan: { ...source.plan, events: [event] } });
  render(<ul><MoneyEvent event={event} snapshot={saved} /></ul>);
  const row = screen.getByRole('listitem', { name: 'Card payment' });
  expect(row).toHaveTextContent(label);
  expect(row.querySelector('.money-event-value > span')).toHaveTextContent(status);
  expect(row.querySelector('.money-event-value > strong')).toHaveTextContent(basis === 'requiredOnly' || basis === 'assumed' ? '₹2,000.00' : '₹4,000.00');
  expect(row).toHaveTextContent('Calculated'); expect(row).not.toHaveTextContent('verified');
});

it('shows matching amount and schedule conflicts in events and all printed debt facts', () => {
  const source = choiceSnapshot('cardMinimum');
  const record = source.facts.records[1];
  const saved = moneyProjection({ ...source, facts: { ...source.facts,
    opening: { status: 'estimate', amountPaise: 500000 },
    records: [{ ...record, amount: { status: 'unknown', amountPaise: null }, outstanding: { status: 'estimate', amountPaise: 999900 } }],
    conflicts: [{ id: 'target-conflict', recordId: record.id, field: 'target', values: [] }, { id: 'date-conflict', recordId: record.id, field: 'schedule.date', values: [] }],
  } });
  const view = render(<><ul><MoneyEvent event={source.plan.events[1]} snapshot={saved} /></ul><MoneyPrint snapshot={saved} /></>);
  const row = screen.getByRole('listitem', { name: 'Card payment' });
  expect(row.querySelector('.money-event-value > span')).toHaveTextContent('Conflicting reports');
  expect(row).toHaveTextContent('Date: Conflicting reports');
  const print = view.container.querySelector('.money-print')!;
  expect(print).toHaveTextContent('Cash at plan start · 11 Sept 2026 · Estimated');
  expect(print).toHaveTextContent('Unknown · Unknown required / minimum');
  expect(print).toHaveTextContent('Intended, including minimum: ₹4,000.00 · Conflicting reports');
  expect(print).toHaveTextContent('Outstanding: ₹9,999.00 · Estimated');
});

it('separates elapsed requirements at evaluatedOn, preserving backend order and balances', async () => {
  const source = planningSnapshot();
  const events = [
    { ...source.plan.events[0], id: 'earlier', label: 'Earlier rent', date: '2026-09-11', originalDueDate: '2026-09-09', overdue: true, balancePaise: -77700 },
    { ...source.plan.events[0], id: 'z', label: 'First same-day payment', date: '2026-09-15', balancePaise: -12300 },
    { ...source.plan.events[0], id: 'a', label: 'Second same-day payment', date: '2026-09-15', balancePaise: -45600 },
    { ...source.plan.events[0], id: 'income', label: 'Later income', kind: 'income' as const, date: '2026-09-15', balancePaise: 32100 },
    { ...source.plan.events[0], id: 'last', label: 'Last payment', date: '2026-09-16' },
  ];
  const saved = moneyProjection({ ...source, plan: { ...source.plan, evaluatedOn: '2026-09-15', events } });
  const view = render(<MemoryRouter><MoneyOverview snapshot={saved} blocked={false} onEdit={vi.fn()} onChecks={vi.fn()} onCommand={vi.fn()} /></MemoryRouter>);
  const next = screen.getByRole('region', { name: 'Next money and payments' });
  expect(within(next).getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(['First same-day payment']);
  expect(within(next).getByRole('link', { name: '1 earlier item · status unconfirmed' })).toBeVisible();
  view.rerender(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  expect(screen.queryByRole('listitem', { name: 'Earlier rent' })).not.toBeInTheDocument();
  expect(screen.getByRole('listitem', { name: 'First same-day payment' })).toHaveTextContent('-₹123.00');
  await userEvent.click(screen.getByRole('button', { name: 'Earlier (1)' }));
  const earlier = screen.getByRole('listitem', { name: 'Earlier rent' });
  expect(earlier).toHaveTextContent('Originally due 9 Sept 2026');
  expect(earlier).toHaveTextContent('status not confirmed');
  expect(earlier).toHaveTextContent('Earlier projected balance · Calculated-₹777.00');
  await userEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(screen.getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(events.map(item => item.label));
  await userEvent.selectOptions(screen.getByLabelText('Filter upcoming items'), 'income');
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  await userEvent.type(screen.getByRole('searchbox'), 'unmatched');
  expect(screen.getByRole('heading', { name: 'No matching events' })).toBeVisible();
});

it('lists only authoritative missing-date entries and exempts undated known-zero items', async () => {
  const source = planningSnapshot();
  const saved = moneyProjection({ ...source, facts: { ...source.facts, records: [
    { ...source.facts.records[0], schedule: { date: null, certainty: 'unknown', recurrence: 'once', basis: 'payment' } },
    { ...source.facts.records[0], id: 'zero', label: 'No payment due', amount: { status: 'exact', amountPaise: 0 }, schedule: { date: null, certainty: 'unknown', recurrence: 'once', basis: 'payment' } },
  ] }, plan: { ...source.plan, events: [], budgetBasis: { datedProjectionComplete: false, unresolvedAmounts: [
    { recordId: 'rent', reason: 'missingDate', amount: source.facts.records[0].amount, recurrence: 'once' },
  ] } } });
  render(<MemoryRouter><MoneyUpcoming snapshot={saved} /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: '1 items without dates' }));
  const dialog = screen.getByRole('dialog', { name: '1 items without dates' });
  expect(dialog).toHaveTextContent('Rent'); expect(dialog).not.toHaveTextContent('No payment due');
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
});

it.each([['none', 'None reported'], ['notDiscussed', 'Not discussed yet'], ['reviewed', 'Review recorded · no listed items']] as const)('preserves empty %s category coverage', (coverage, heading) => {
  const source = snapshot();
  const saved = moneyProjection({ ...source, facts: { ...source.facts, coverage: { ...source.facts.coverage, income: coverage } } });
  const onEdit = vi.fn();
  render(<MoneyRecords category="income" snapshot={saved} blocked={false} onEdit={onEdit} onCommand={vi.fn()} />);
  expect(screen.getByRole('heading', { name: heading })).toBeVisible();
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(screen.queryByText('Nothing shared here yet')).not.toBeInTheDocument();
});

it('uses contribution reasons for excluded income instead of treating absent events as uncertain', () => {
  const source = planningSnapshot();
  const saved = moneyProjection({ ...source, facts: { ...source.facts, records: [{ ...source.facts.records[0], kind: 'income', reliability: 'reliable' }] }, plan: { ...source.plan, events: [] } });
  const contributions = [{ id: 'record:rent', recordId: 'rent', eventId: null, amountPaise: 1200000, included: false, reason: 'outsideHorizon', references: [] }];
  render(<MoneyRecords category="income" snapshot={{ ...saved, workspace: { ...saved.workspace, contributions } }} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  const row = screen.getByRole('listitem', { name: 'Rent' });
  expect(row).toHaveTextContent('Outside these 30 days'); expect(row).not.toHaveTextContent('Receipt uncertain');
});

it('keeps conditional income outcomes separate and shows only server-calculated amounts', async () => {
  const saved = planningSnapshot(); saved.facts.records[0].kind = 'income'; saved.facts.records[0].label = 'Client invoice';
  saved.plan.events[0] = { ...saved.plan.events[0], kind: 'income', label: 'Client invoice', included: false };
  saved.plan.incomeComparisons = [{ id: 'conditional', conditions: [{ eventId: saved.plan.events[0].id, arrival: 'reportedDate' }],
    metrics: { ...saved.plan, closingPaise: 123456, firstGap: { amountPaise: 7654, date: '2026-09-13' } } }];
  render(<MoneyRecords category="income" snapshot={saved} blocked={false} onEdit={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole('listitem', { name: 'Client invoice' })).toHaveTextContent('Not included in projected balances');
  await userEvent.click(screen.getByRole('button', { name: 'If income arrives' }));
  const dialog = screen.getByRole('dialog', { name: 'If income arrives' });
  expect(dialog).toHaveTextContent('Conditional calculations only'); expect(dialog).toHaveTextContent('₹1,234.56');
  expect(dialog).toHaveTextContent('₹76.54'); expect(api.save).not.toHaveBeenCalled();
});

it('offers compact server choices and previews the exact set without consent or client gap arithmetic', async () => {
  const source = choiceSnapshot();
  const saved = moneyProjection({ ...source, plan: { ...source.plan, decisionAssessment: { ...source.plan.decisionAssessment,
    choices: source.plan.decisionAssessment!.choices!.map(choice => ({ ...choice, metrics: { ...source.plan, closingPaise: 1000000, troughPaise: -87650, peakGapPaise: 87650, peakGapDate: '2026-09-18', firstGap: { date: '2026-09-13', amountPaise: 43210 }, reserveShortfallPaise: 87650 } })),
  } } });
  const onCommand = vi.fn();
  render(<MoneyChanges snapshot={saved} settings={settings} active blocked={false} pending={false} onCommand={onCommand} onEdit={vi.fn()} />);
  const suggestions = screen.getByRole('region', { name: 'Suggested plan changes' });
  expect(suggestions).toHaveTextContent('Optional purchase'); expect(suggestions).toHaveTextContent('27 Sept 2026');
  expect(suggestions).toHaveTextContent('₹432.10'); expect(suggestions).toHaveTextContent('Not saved');
  await userEvent.click(within(suggestions).getByRole('button', { name: 'Compare' }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'previewAdjustments', adjustments: [{ eventId: 'optional:2026-09-27', amount: '0.00' }] });
  expect(api.options).not.toHaveBeenCalled();
});

it('offers safe restore directly beside saved changes and invalidates confirmation on live updates', async () => {
  const saved = moneyProjection({ ...planningSnapshot(), accepted: scenario('accepted'), preview: scenario('proposed') });
  const props = { snapshot: saved, settings, active: true, blocked: false, pending: false, onCommand: vi.fn() };
  const view = render(<MoneyChanges {...props} />);
  expect(screen.getByRole('region', { name: 'Current planning changes' })).toHaveTextContent('Optional purchase');
  await userEvent.click(screen.getByRole('button', { name: 'Restore reported amounts' }));
  const dialog = screen.getByRole('dialog', { name: 'Restore reported amounts?' });
  expect(dialog).toHaveTextContent('₹0.00 Saved → ₹2,000.00 Reported');
  expect(dialog).toHaveTextContent('clear the current preview'); expect(props.onCommand).not.toHaveBeenCalled();
  view.rerender(<MoneyChanges {...props} snapshot={{ ...saved, sequence: saved.sequence + 1 }} />);
  expect(screen.queryByRole('dialog', { name: 'Restore reported amounts?' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Restore reported amounts' }));
  await userEvent.click(screen.getByRole('button', { name: 'Restore all reported amounts' }));
  expect(props.onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'clearAccepted' });
  expect(api.options).not.toHaveBeenCalled();
});