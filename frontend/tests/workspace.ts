// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from '../src/api';
import type { components } from '../src/contracts';

// Test-only presentation fixtures copy supplied metrics; integration tests use the real server projector.
export function projectWorkspace(saved: Snapshot): Snapshot {
  const plan = saved.accepted?.plan ?? saved.plan;
  const workspace: Required<NonNullable<Snapshot['workspace']>> = {
    cards: [], questions: [], issues: plan.decisionAssessment?.uncertainties ?? [], results: [], contributions: [], actions: plan.decisionAssessment?.actions?.slice(0, 6) ?? [],
    choices: plan.decisionAssessment?.choices ?? [], change: saved.workspace?.change ?? null,
  };
  Object.assign(saved, { workspace });
  if (!saved.facts.records.length && saved.facts.opening.amountPaise === null && !saved.facts.conflicts?.length && !saved.facts.reservePaise
    && !Object.values(saved.facts.coverage).some(value => value !== 'notDiscussed')) return saved;
  workspace.contributions = [{ id: 'opening', recordId: null, eventId: null, amountPaise: saved.facts.opening.amountPaise,
    date: saved.anchorDate, included: saved.facts.opening.amountPaise !== null, reason: 'reportedOpening', references: ['facts.opening'] },
  ...plan.events.map(event => ({ id: `event:${event.id}`, recordId: event.recordId, eventId: event.id, amountPaise: event.amountPaise,
    balancePaise: event.balancePaise, date: event.date, included: event.included, reason: event.included ? 'reported' : 'conditionalReceipt', references: [] }))];
  const metrics: [string, number | null, string | null, string][] = [
    ['opening', saved.facts.opening.amountPaise, saved.anchorDate, 'reportedAvailableOpening'],
    ['closing', plan.closingPaise, saved.endDateExclusive, 'openingPlusIncludedIncomeMinusIncludedOutflow'],
    ['trough', plan.troughPaise, plan.peakGapDate ?? null, 'minimumOpeningAndEventBalances'],
    ['firstGap', plan.firstGap?.amountPaise ?? (plan.closingPaise === null ? null : 0), plan.firstGap?.date ?? null, 'maximumDeficitOnEarliestNegativeDate'],
    ['peakGap', plan.peakGapPaise, plan.peakGapDate ?? null, 'maxZeroMinusTroughNotSumOfGaps'],
    ['reserveShortfall', plan.reserveShortfallPaise, null, 'maxZeroReserveMinusMaxZeroTrough'],
    ['reliableIncome', plan.reliableIncomePaise, null, 'sumIncludedDatedReceipts'],
    ['uncertainIncome', plan.uncertainIncomePaise, null, 'sumExcludedKnownDatedReceipts'],
    ['datedOutflow', plan.outflowPaise, null, 'sumKnownDatedOutflow'],
  ];
  workspace.results = metrics.map(([id, amountPaise, date, rule]) => ({ id, amountPaise, date, rule, state: amountPaise === null ? 'missing' : 'uncertain',
    fromDate: saved.anchorDate, untilDateExclusive: saved.endDateExclusive,
    contributionIds: workspace.contributions.filter(item => item.included && (id !== 'opening' || item.id === 'opening')).map(item => item.id),
    excludedIds: workspace.contributions.filter(item => !item.included).map(item => item.id),
    eventIds: plan.events.map(event => event.id), witnessEventIds: [], recordIds: saved.facts.records.map(record => record.id),
    issueIds: plan.decisionAssessment?.uncertainties?.map(issue => issue.id) ?? [], dependencies: [],
    assumptions: ['sameDayOutflowBeforeIncome', 'closingIsNotSpendable', 'unreportedFactsNotZero', 'noPaymentExecution'],
  }));
  function card(template: 'cash' | 'timeline' | 'questions' | 'proposal', section: components['schemas']['WorkspaceCard']['section'], title: string,
    recordIds: string[] = [], resultIds: string[] = []) {
    const card: components['schemas']['WorkspaceCard'] = { id: template, template, section, title, state: 'known', recordIds, resultIds,
      rows: [], eventIds: [], issueIds: [], dependencies: [] };
    workspace.cards.push(card); return card;
  }
  workspace.questions = (plan.decisionAssessment?.uncertainties ?? []).slice(0, 3).map(issue => ({ id: issue.id, actionId: workspace.actions.find(action => action.id === `clarify:${issue.id}`)?.id ?? null,
    fields: [issue.field], recordIds: issue.recordIds, why: issue.reason, resolves: [issue.id], changes: issue.changes, blocks: issue.blocks, beforeDate: issue.beforeDate ?? null, priority: issue.priority }));
  const openingConflicts = saved.facts.conflicts?.filter(item => item.field === 'opening').map(item => item.id) ?? [];
  if (saved.facts.opening.amountPaise !== null || openingConflicts.length || saved.facts.reservePaise || plan.events.length) {
    const cash = card('cash', 'facts', 'Cash & timing', [], ['opening', ...(plan.events.length ? ['firstGap', 'closing', 'trough'] : []), ...(saved.facts.reservePaise ? ['reserveShortfall'] : [])]);
    const state = openingConflicts.length ? 'conflicting' : saved.facts.opening.amountPaise === null ? 'missing' : saved.facts.opening.status === 'estimate' ? 'estimated' : 'known';
    cash.state = openingConflicts.length ? 'conflicting' : plan.firstGap || plan.reserveShortfallPaise ? 'unresolved' : state;
    cash.issueIds = openingConflicts;
    cash.rows = [{ field: 'opening', label: 'Cash at the plan start', value: saved.facts.opening.amountPaise, state, references: ['facts.opening'] },
      { field: 'reserve', label: 'Reserve floor (not spending)', value: saved.facts.reservePaise, state: 'known', references: ['facts.reservePaise'] }];
    cash.dependencies = ['facts.opening', 'facts.reservePaise', 'facts.conflicts', ...(plan.events.length ? [saved.accepted ? 'accepted.plan' : 'plan'] : [])];
  }
  const nextEvents = new Map<string, typeof plan.events[number]>();
  for (const event of plan.events) if (event.amountBasis !== 'budget' && !nextEvents.has(event.recordId)) nextEvents.set(event.recordId, event);
  const selectedEvents = [...nextEvents.values()];
  const nextPayment = selectedEvents.find(event => event.kind !== 'income');
  const nextIncome = selectedEvents.find(event => event.kind === 'income');
  const priorities = workspace.issues.filter(issue => issue.kind !== 'coverage').sort((a, b) =>
    Number(a.kind !== 'conflict') - Number(b.kind !== 'conflict') || Number(!a.blocks.includes('immediateDecision')) - Number(!b.blocks.includes('immediateDecision'))
    || a.priority - b.priority || (a.beforeDate ?? '9999-12-31').localeCompare(b.beforeDate ?? '9999-12-31') || a.id.localeCompare(b.id));
  const records = new Map(saved.facts.records.map(record => [record.id, record]));
  const recordIds = [...new Set([...selectedEvents.filter(event => event === nextPayment || event === nextIncome).map(event => event.recordId),
    ...priorities.flatMap(issue => [...issue.recordIds].sort()), ...[...records.keys()].sort()])].filter(id => records.has(id));
  if (recordIds.length) {
    const timeline = card('timeline', 'timeline', 'Next & commitments', recordIds);
    timeline.eventIds = recordIds.flatMap(id => nextEvents.has(id) ? [nextEvents.get(id)!.id] : []);
    timeline.issueIds = priorities.filter(issue => issue.recordIds.length).map(issue => issue.id);
    timeline.dependencies = ['facts.records', 'facts.conflicts', 'workspace.issues', saved.accepted ? 'accepted.plan.events' : 'plan.events'];
  }
  const visibleIds = recordIds.slice(0, 4);
  const question = priorities.find(issue => !(issue.recordIds.length && issue.recordIds.every(id => visibleIds.includes(id)))
    && !(workspace.cards.some(card => card.template === 'cash') && ['opening', 'reserve'].includes(issue.field)));
  if (question && (records.size || workspace.cards.length)) {
    const uncertainty = card('questions', 'issues', 'Important uncertainty', question.recordIds);
    uncertainty.state = question.kind === 'conflict' ? 'conflicting' : 'unresolved';
    uncertainty.issueIds = [question.id];
    uncertainty.dependencies = [`workspace.issues.${question.id}`, 'facts.conflicts'];
    uncertainty.rows = [{ field: question.id, label: question.question, value: null, state: uncertainty.state, references: [`workspace.issues.${question.id}`] }];
  }
  if (saved.preview || saved.accepted || saved.invalidatedAssumptions?.length) {
    const adjustments = [...(saved.preview?.adjustments ?? []), ...(saved.accepted?.adjustments ?? [])];
    const eventIds = [...new Set([...adjustments.map(item => item.eventId), ...(saved.invalidatedAssumptions ?? []).map(item => item.eventId)])];
    const proposal = card('proposal', 'decisions', 'Plan changes', [...new Set([...adjustments.map(item => item.recordId),
      ...eventIds.map(id => id.slice(0, id.lastIndexOf(':')))])].filter(id => records.has(id)), ['firstGap', 'peakGap', 'closing']);
    proposal.state = saved.preview ? 'proposed' : saved.invalidatedAssumptions?.length ? 'unresolved' : 'accepted';
    proposal.eventIds = eventIds;
    proposal.dependencies = ['preview', 'accepted', 'invalidatedAssumptions'];
  }
  return saved;
}