// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../src/api';
import { FinancialContext } from '../src/FinancialContext';
import { MoneyChanges } from '../src/MoneyChanges';
import { MoneyOverview } from '../src/MoneyOverview';
import { MoneyPrint } from '../src/MoneyPrint';
import { RecordRow } from '../src/MoneyRecords';
import { Correction } from '../src/WorkspaceDetails';
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
  saved.plan.decisionAssessment!.consequences!.push({ id: 'reserve:breach', kind: 'reserveBreach', eventIds: [], date: '2026-09-13', amountPaise: 100000 });
  render(<MemoryRouter><MoneyOverview snapshot={saved} blocked={false} onEdit={vi.fn()} onChecks={vi.fn()} onCommand={vi.fn()} /><MoneyPrint snapshot={saved} /></MemoryRouter>);
  const overview = screen.getByRole('region', { name: 'What needs attention' });
  expect(overview).toHaveTextContent('Cash to keep aside: ₹5,000.00. Largest reserve shortfall: ₹2,000.00');
  expect(overview).toHaveTextContent('First falls below the reserve on 13 Sept 2026');
  expect(overview).not.toHaveTextContent('Some details still need checking');
  if (cashGap) expect(within(overview).getByRole('heading', { name: 'First funding gap' })).toBeVisible();
  else expect(within(overview).getByRole('heading', { name: 'Cash to keep aside is not covered' })).toBeVisible();
  const printed = document.querySelector('.money-print')!;
  expect(printed).toHaveTextContent('Largest reserve shortfall: ₹2,000.00');
  expect(printed).toHaveTextContent('First falls below the reserve on 13 Sept 2026');
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
  card.amount.status = 'estimate'; card.target = { amountPaise: null, status: 'unknown' };
  saved.plan.events = saved.plan.events.filter(item => item.recordId === card.id).map(item => ({ ...item, amountPaise: card.amount.amountPaise, amountBasis: 'requiredOnly', autoDebit: true }));
  render(<FinancialContext snapshot={projectWorkspace(saved)} locked={false} stale={false} mode="live" proposalActive onCommand={vi.fn().mockResolvedValue(saved)} />);
  const timeline = screen.getByRole('article', { name: 'Dated cash requirements' });
  expect(timeline).toHaveTextContent('Estimated requirement');
  expect(timeline).toHaveTextContent('Required / minimum only · intended payment unknown');
  expect(timeline).toHaveTextContent('Automatic debit reported');
  expect(timeline).not.toHaveTextContent('Reported requirement');
});

it.each(['rejected', 'unconfirmed'] as const)('keeps a correction draft after a %s save, then closes after confirmation', async failure => {
  const saved = planningSnapshot();
  const onCommand = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(saved);
  if (failure === 'rejected') onCommand.mockReset().mockRejectedValueOnce(new Error('Save rejected')).mockResolvedValueOnce(saved);
  render(<Correction snapshot={saved} record={saved.facts.records[0]} blocked={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole('button', { name: 'Correct Rent' }));
  await userEvent.clear(screen.getByLabelText('Amount (₹)')); await userEvent.type(screen.getByLabelText('Amount (₹)'), '6000');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByLabelText('Amount (₹)')).toHaveValue('6000');
  expect(screen.getByRole('alert')).toHaveTextContent('Your entry is kept');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(onCommand).toHaveBeenCalledTimes(2);
});

it('keeps a pending correction open and prevents another submission', async () => {
  const saved = planningSnapshot();
  let confirm!: (value: Snapshot) => void;
  const onCommand = vi.fn(() => new Promise<Snapshot>(resolve => { confirm = resolve; }));
  render(<Correction snapshot={saved} blocked={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole('button', { name: 'Correct available cash' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(onCommand).toHaveBeenCalledOnce();
  await act(async () => confirm(saved));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});