// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { AdjustmentOptions, Scenario, Settings, Snapshot } from '../src/api';

export const settings: Settings = {
  currency: 'INR', timezone: 'Asia/Kolkata', today: '2026-09-11', horizonDays: 30,
  retentionHours: 24, maxRecords: 200, maxMoneyPaise: 1000000000000, maxRequestBytes: 131072,
  recurrence: ['once', 'weekly', 'fortnightly', 'monthly'], voiceAvailable: false,
  voiceUnavailableReason: 'Missing setup: AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, DAILY_API_KEY, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION.', openingBasis: 'Enter available cash and only unpaid or future items.',
};

export function snapshot(): Snapshot {
  return {
    sessionId: '51e107ab-efc3-4c40-ac5b-9b7f3a1678a0', revision: 0, sequence: 0,
    createdAt: '2026-09-11T04:00:00Z', asOf: '2026-09-11T04:00:00Z', expiresAt: '2026-09-12T04:00:00Z',
    anchorDate: '2026-09-11', endDateExclusive: '2026-10-11', currency: 'INR',
    facts: { opening: { amountPaise: null, status: 'unknown' }, reservePaise: 0,
      coverage: { income: 'notDiscussed', essential: 'notDiscussed', debt: 'notDiscussed', optional: 'notDiscussed' }, records: [],
      decision: { intent: 'plan30Days', concern: null, focusRecordIds: [], responsePreference: 'standard' }, providerResponses: [] },
    invalidatedAssumptions: [],
    plan: { evaluatedOn: '2026-09-11', projectionPartial: true, reliableIncomePaise: 0, uncertainIncomePaise: 0,
      outflowPaise: 0, closingPaise: null, troughPaise: null, firstGap: null, peakGapPaise: null,
      reserveShortfallPaise: null, events: [], issues: [{ code: 'unknownOpening', message: 'Confirm available cash; balances cannot be calculated yet.', recordId: null }],
      budgetBasis: { datedProjectionComplete: false, unresolvedAmounts: [] }, incomeComparisons: [],
      decisionAssessment: {
        uncertainties: [{ id: 'opening', kind: 'missing', recordIds: [], field: 'opening',
          question: 'What cash was available at the original cash basis?', changes: ['what', 'affordability'],
          blocks: ['immediateDecision', 'fullPlan'], priority: 0, reason: 'Available opening cash can reverse every funding decision.', beforeDate: null }],
        constraints: [], consequences: [], choices: [],
        actions: [{ id: 'clarify:opening', kind: 'clarify', recordIds: [], beforeDate: null,
          question: 'What cash was available at the original cash basis?', consequenceIds: [], ifDeclinedConsequenceIds: [] }],
        nextQuestionId: 'opening', nextActionId: 'clarify:opening',
        outcome: { branch: 'uncertain', readiness: 'qualified',
          summary: 'Available cash still needs checking before deciding what can be covered.',
          covered: 'No funding conclusion yet.', notCovered: 'Unresolved cash prevents an affordability conclusion.',
          nextStep: 'What cash was available at the original cash basis?', conditions: 'Use reported cash, not available credit.',
          trueNow: ['Unresolved amounts or dates prevent any available-to-spend conclusion.'],
          riskIds: [], choiceIds: [], nextActionId: 'clarify:opening', uncertain: ['opening'],
          revisit: 'Recalculate after a receipt correction, changed obligation or provider response; accepted assumptions are not completed actions.' },
      } },
  };
}

export class Stream extends EventTarget {
  static instances: Stream[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { super(); Stream.instances.push(this); }
  close() { this.closed = true; }
  emit(name: string, value: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(value) })); }
}

export const adjustmentOptions: AdjustmentOptions = { revision: 0, today: '2026-09-11', options: [
  { eventId: 'optional:2026-09-27', recordId: 'optional', label: 'Optional purchase', kind: 'optional', date: '2026-09-27', originalPaise: 200000, minimumPaise: 0, acceptanceReady: true, dependencyKey: 'optional-terms' },
  { eventId: 'card:2026-09-26', recordId: 'card', label: 'Card payment', kind: 'card', date: '2026-09-26', originalPaise: 400000, minimumPaise: 200000, acceptanceReady: true, dependencyKey: 'card-terms' },
] };

export function planningSnapshot(): Snapshot {
  const saved = snapshot();
  saved.facts.opening = { status: 'exact', amountPaise: 500000 };
  saved.plan = { ...saved.plan, closingPaise: 1000000, outflowPaise: 2500000, reliableIncomePaise: 3000000,
    troughPaise: -1600000, peakGapPaise: 1600000, peakGapDate: '2026-09-18', firstGap: { date: '2026-09-13', amountPaise: 700000 },
    issues: [], budgetBasis: { datedProjectionComplete: true, unresolvedAmounts: [] },
    decisionAssessment: {
      uncertainties: [{ id: 'provider:rent:2026-09-13', kind: 'uncertain', recordIds: ['rent'], field: 'providerResponses',
        question: 'Contact the provider before the due date.', changes: ['what', 'when', 'affordability'],
        blocks: ['immediateDecision', 'fullPlan'], priority: 30, reason: 'Only an actual agreement could change this exposed deadline.', beforeDate: '2026-09-13' }],
      constraints: [{ id: 'rent:essential', kind: 'essential', eventIds: ['rent:2026-09-13'], date: '2026-09-13', amountPaise: 1200000 }],
      consequences: [{ id: 'cash:2026-09-13', kind: 'cashExposure', eventIds: ['rent:2026-09-13'], date: '2026-09-13', amountPaise: 700000 }],
      choices: [], actions: [{ id: 'contact:rent:2026-09-13', kind: 'contactPayee', recordIds: ['rent'],
        beforeDate: '2026-09-13', question: 'Contact the provider before the due date.',
        consequenceIds: ['cash:2026-09-13'], ifDeclinedConsequenceIds: ['cash:2026-09-13'] }],
      nextQuestionId: 'provider:rent:2026-09-13', nextActionId: 'contact:rent:2026-09-13',
      outcome: { branch: 'gap', readiness: 'qualified',
        summary: 'The rent deadline comes before enough money is available.',
        covered: 'Later income supports later dated commitments.', notCovered: 'The first rent deadline has a ₹7,000.00 gap.',
        nextStep: 'Contact the provider before the due date.', conditions: 'No changed payment terms are agreed yet.',
        trueNow: ['This is a dated requirements projection, not executed payments or an overdraft.', 'Later income does not resolve earlier dues.'],
        riskIds: ['cash:2026-09-13'], choiceIds: [], nextActionId: 'contact:rent:2026-09-13', uncertain: ['provider:rent:2026-09-13'],
        revisit: 'Recalculate after a receipt correction, changed obligation or provider response; accepted assumptions are not completed actions.' },
    } };
  saved.facts.records = [{ id: 'rent', label: 'Rent', kind: 'essential', amount: { status: 'exact', amountPaise: 1200000 }, schedule: { date: '2026-09-13', recurrence: 'once' }, autoDebit: false, controllability: 'committed' }];
  return saved;
}

export function scenario(id = 'preview-one'): Scenario {
  return { id, sourceRevision: 0, createdAt: '2026-09-11T04:00:00Z',
    adjustments: [{ ...adjustmentOptions.options[0], amountPaise: 0, acceptedRevision: null }], reducedOutflowPaise: 200000,
    plan: { ...planningSnapshot().plan, outflowPaise: 2300000, closingPaise: 1200000 } };
}

export function unconfirmedSnapshot(): Snapshot {
  const saved = snapshot();
  saved.revision = 1; saved.sequence = 1;
  saved.facts.decision = { ...saved.facts.decision!, responses: [{ actionId: 'clarify:opening', response: 'unavailable', dependencyKey: 'opening-basis' }] };
  const question = 'Have we covered all your income and commitments for these 30 days?';
  saved.plan.decisionAssessment = { ...saved.plan.decisionAssessment,
    uncertainties: [...saved.plan.decisionAssessment!.uncertainties!, { id: 'coverage', kind: 'missing', field: 'coverage',
      question, reason: 'Unreported commitments are not included.', recordIds: [], priority: 1,
      changes: ['what', 'affordability'], blocks: ['fullPlan'] }],
    actions: [{ id: 'clarify:coverage', kind: 'clarify', question, recordIds: [], beforeDate: null, consequenceIds: [], ifDeclinedConsequenceIds: [] }],
    nextQuestionId: 'coverage', nextActionId: 'clarify:coverage',
    outcome: { ...saved.plan.decisionAssessment!.outcome!, nextStep: question, nextActionId: 'clarify:coverage', uncertain: ['opening', 'coverage'] },
  };
  return saved;
}

export function choiceSnapshot(kind: 'reduceOptional' | 'cardMinimum' = 'reduceOptional'): Snapshot {
  const saved = planningSnapshot();
  const option = adjustmentOptions.options[kind === 'reduceOptional' ? 0 : 1];
  saved.facts.records.push({ id: option.recordId, label: option.label, kind: kind === 'reduceOptional' ? 'optional' : 'debt',
    amount: { status: 'exact', amountPaise: kind === 'reduceOptional' ? option.originalPaise : option.minimumPaise },
    target: kind === 'cardMinimum' ? { status: 'exact', amountPaise: option.originalPaise } : null,
    debtType: kind === 'cardMinimum' ? 'card' : null, schedule: { date: option.date, recurrence: 'once' },
    autoDebit: false, controllability: 'controllable' });
  saved.plan.events.push({ id: option.eventId, recordId: option.recordId, label: option.label,
    kind: kind === 'reduceOptional' ? 'optional' : 'debt', date: option.date, originalDueDate: option.date,
    amountPaise: option.originalPaise, amountBasis: 'reported', included: true, overdue: false, autoDebit: false,
    balancePaise: saved.plan.closingPaise });
  saved.plan.decisionAssessment = { ...saved.plan.decisionAssessment,
    choices: [{ id: 'spending-choice', kind, eventIds: [option.eventId], prerequisiteIds: [],
      adjustmentAmounts: [{ eventId: option.eventId, amountPaise: option.minimumPaise }], consequenceIds: [],
      affectsFirstGap: false, affectsPeakGap: false, laterOnly: true }],
    actions: [...saved.plan.decisionAssessment!.actions!, { id: 'preview-spending', kind: 'previewChange', choiceId: 'spending-choice',
      question: `Would you like to compare a reduction to ${option.label}?`, recordIds: [option.recordId], beforeDate: option.date,
      consequenceIds: [], ifDeclinedConsequenceIds: [] }], nextActionId: 'preview-spending',
  };
  return saved;
}