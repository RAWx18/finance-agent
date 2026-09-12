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
  if (!saved.facts.records.length && saved.facts.opening.amountPaise === null && !saved.facts.conflicts?.length && !saved.preview && !saved.accepted
    && !Object.values(saved.facts.coverage).some(value => value !== 'notDiscussed') && !saved.facts.decision?.responses?.length) return saved;
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
  function card(template: components['schemas']['WorkspaceCard']['template'], section: components['schemas']['WorkspaceCard']['section'], title: string,
    recordIds: string[] = [], resultIds: string[] = []) {
    const card: components['schemas']['WorkspaceCard'] = { id: template, template, section, title, state: 'known', recordIds, resultIds,
      rows: [], eventIds: [], issueIds: [], dependencies: [] };
    workspace.cards.push(card); return card;
  }
  if (saved.facts.opening.amountPaise !== null || saved.facts.conflicts?.some(item => item.field === 'opening')) card('cash', 'facts', 'Available opening cash', [], ['opening']);
  const groups = [['income', 'Expected income'], ['essential', 'Essential spending'], ['optional', 'Optional spending'], ['loans', 'Loan payments'], ['creditCards', 'Credit card payments']] as const;
  for (const [template, title] of groups) {
    const records = saved.facts.records.filter(record => (record.debtType === 'card' ? 'creditCards' : record.kind === 'debt' ? 'loans' : record.kind) === template);
    if (records.length) card(template, 'facts', title, records.map(record => record.id), template === 'income' ? ['reliableIncome', 'uncertainIncome'] : ['datedOutflow']);
  }
  workspace.questions = (plan.decisionAssessment?.uncertainties ?? []).slice(0, 3).map(issue => ({ id: issue.id, actionId: workspace.actions.find(action => action.id === `clarify:${issue.id}`)?.id ?? null,
    fields: [issue.field], recordIds: issue.recordIds, why: issue.reason, resolves: [issue.id], changes: issue.changes, blocks: issue.blocks, beforeDate: issue.beforeDate ?? null, priority: issue.priority }));
  if (workspace.questions.length) card('questions', 'issues', 'Information that changes the plan').issueIds = workspace.questions.map(item => item.id);
  if (plan.firstGap || plan.peakGapPaise || plan.reserveShortfallPaise) card('gap', 'issues', 'Cash gap and timing risk', [], ['firstGap', 'peakGap', 'reserveShortfall']);
  if (plan.events.length) card('timeline', 'timeline', 'Dated cash requirements', [], ['closing', 'trough', 'firstGap', 'peakGap']).eventIds = plan.events.map(event => event.id);
  if (saved.preview) card('proposal', 'decisions', 'Proposed planning change').state = 'proposed';
  if (saved.accepted) card('assumptions', 'decisions', 'Accepted planning assumptions · no payments executed').state = 'accepted';
  if (saved.invalidatedAssumptions?.length) card('invalidation', 'decisions', 'Assumptions need confirmation again').rows = saved.invalidatedAssumptions.map(item => ({ field: item.eventId, label: 'Affected assumption', value: item.reason, state: 'unresolved', references: [] }));
  if (plan.decisionAssessment?.outcome) card('outcome', 'outcome', plan.decisionAssessment.outcome.readiness === 'ready' ? 'Reviewed outlook' : 'Qualified outlook').state = plan.decisionAssessment.outcome.readiness === 'ready' ? 'known' : 'unresolved';
  return saved;
}