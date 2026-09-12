// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { components } from './contracts';
import { isHistoryRoute } from './historyRoutes';
import { errorFields, log } from './telemetry';

export type Snapshot = components['schemas']['Snapshot'];
export type Settings = components['schemas']['Settings'];
export type FactsInput = components['schemas']['FactsInput'];
export type MoneyInput = components['schemas']['MoneyInput'];
export type Command = components['schemas']['Command'];
export type ApiEnvelope = components['schemas']['Error'];
export type AdjustmentOptions = components['schemas']['AdjustmentOptions'];
export type Scenario = components['schemas']['Scenario'];
export type Plan = components['schemas']['Plan'];
export type CallJoin = components['schemas']['CallJoin'];
export type CallState = components['schemas']['CallState'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type ConversationMessage = components['schemas']['ConversationMessage'];
export type SavedConversation = components['schemas']['SavedConversation'];
export type AuthSession = components['schemas']['AuthSession'];
export type AuthSettings = components['schemas']['AuthSettings'];
export type User = components['schemas']['User'];
export type ReturnPath = components['schemas']['LoginRequest']['returnTo'];
export type AuthLoss = 'unauthenticated' | 'sessionExpired' | 'authUnavailable' | 'accountDeleted';

let generation = 0;
/** Read the authentication generation used to identify stale asynchronous work. */
export const authEpoch = () => generation;
/** Invalidate protected requests belonging to the prior authentication state. */
export function invalidateRequests() { generation++; }
/** Notify the authentication provider of a loss reported by the current generation. */
export function reportAuthLoss(code: AuthLoss, epoch = generation) {
  if (epoch === generation) window.dispatchEvent(new CustomEvent<AuthLoss>('auth:loss', { detail: code }));
}

/** Represent an API failure with its HTTP status, structured service error and server request ID. */
export class ApiError extends Error {
  constructor(public status: number, public body: ApiEnvelope, public requestId: string | null = null) {
    super(body.message);
    this.name = 'ApiError';
  }
}

// JSON numbers crossing the boundary must retain every paise and sequence digit.
/** Reject unsafe numeric values while decoding API responses. */
export function exactNumbers(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('The saved figures could not be read safely.');
  }
  return value;
}

/** Check identifiers and labels without rewriting server-owned values. */
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
/** Check nonnegative integers that retain their exact value in JavaScript. */
const unsigned = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** Check calendar dates without accepting JavaScript's rollover normalization. */
const isoDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Check the shared occurrence identity, eligibility bounds, and consent dependency. */
function validOption(value: unknown): value is AdjustmentOptions['options'][number] {
  const option = value as AdjustmentOptions['options'][number] | null;
  return !!option && nonempty(option.eventId) && nonempty(option.recordId) && nonempty(option.label)
    && ['optional', 'card'].includes(option.kind) && isoDate(option.date)
    && unsigned(option.originalPaise) && unsigned(option.minimumPaise) && option.minimumPaise < option.originalPaise
    && typeof option.acceptanceReady === 'boolean' && nonempty(option.dependencyKey);
}

/** Check the financial values and collections consumed by proposal review. */
function validPlan(value: unknown): value is Plan {
  const plan = value as Plan | null;
  const amount = (value: unknown) => value === null || Number.isSafeInteger(value);
  const cost = (value: unknown) => value === null || unsigned(value);
  return !!plan && ['reliableIncomePaise', 'uncertainIncomePaise', 'outflowPaise'].every(key => unsigned(plan[key as keyof Plan]))
    && amount(plan.closingPaise) && amount(plan.troughPaise) && cost(plan.peakGapPaise) && cost(plan.reserveShortfallPaise)
    && (plan.firstGap === null || !!plan.firstGap && isoDate(plan.firstGap.date) && unsigned(plan.firstGap.amountPaise))
    && (plan.peakGapDate == null || isoDate(plan.peakGapDate)) && isoDate(plan.evaluatedOn)
    && typeof plan.projectionPartial === 'boolean'
    && Array.isArray(plan.events) && plan.events.every(event => !!event && nonempty(event.id) && nonempty(event.recordId)
      && nonempty(event.label) && ['income', 'essential', 'optional', 'debt'].includes(event.kind)
      && isoDate(event.date) && isoDate(event.originalDueDate) && cost(event.amountPaise) && amount(event.balancePaise)
      && ['reported', 'requiredOnly', 'requiredFloor', 'assumed', 'budget'].includes(event.amountBasis)
      && (event.amountStatus === undefined || ['exact', 'estimate', 'unknown'].includes(event.amountStatus))
      && (event.requiredStatus === undefined || ['exact', 'estimate', 'unknown'].includes(event.requiredStatus))
      && (event.requiredPaise == null || unsigned(event.requiredPaise))
      && (event.scheduleIndex == null || unsigned(event.scheduleIndex))
      && (event.dateAssumption == null || typeof event.dateAssumption === 'string')
      && typeof event.included === 'boolean' && typeof event.overdue === 'boolean' && typeof event.autoDebit === 'boolean')
    && new Set(plan.events.map(event => event.id)).size === plan.events.length
    && (plan.timingRisks === undefined || Array.isArray(plan.timingRisks) && plan.timingRisks.every(risk => !!risk
      && isoDate(risk.date) && unsigned(risk.exposurePaise) && unsigned(risk.remainingGapPaise)))
    && !!plan.budgetBasis && typeof plan.budgetBasis.datedProjectionComplete === 'boolean'
    && Array.isArray(plan.budgetBasis.unresolvedAmounts) && plan.budgetBasis.unresolvedAmounts.every(item => !!item
      && nonempty(item.recordId) && ['missingDate', 'missingAmount', 'unknownTarget'].includes(item.reason)
      && !!item.amount && cost(item.amount.amountPaise) && ['exact', 'estimate', 'unknown'].includes(item.amount.status)
      && ['once', 'daily', 'weekly', 'fortnightly', 'monthly', 'monthlyBudget'].includes(item.recurrence));
}

/** Validate a saved financial snapshot and its workspace references before use. */
export function readSnapshot(value: unknown): Snapshot {
  const snapshot = value as Snapshot | null;
  if (!snapshot || typeof snapshot.sessionId !== 'string' || !snapshot.sessionId
    || snapshot.conversationSlug !== null && (typeof snapshot.conversationSlug !== 'string' || !isHistoryRoute(`/history/${snapshot.conversationSlug}`))
    || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || typeof snapshot.anchorDate !== 'string' || typeof snapshot.endDateExclusive !== 'string'
    || typeof snapshot.expiresAt !== 'string' || !snapshot.facts?.opening || !snapshot.facts.coverage
    || !Array.isArray(snapshot.facts.records) || !Array.isArray(snapshot.facts.conflicts)
    || !validPlan(snapshot.plan))
    throw new Error('The saved figures could not be read safely.');
  for (const scenario of [snapshot.preview, snapshot.accepted]) {
    if (scenario === undefined || scenario === null) continue;
    if (!nonempty(scenario.id) || !unsigned(scenario.sourceRevision)
      || typeof scenario.createdAt !== 'string' || !isoDate(scenario.createdAt.slice(0, 10))
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(scenario.createdAt)
      || !Number.isFinite(Date.parse(scenario.createdAt))
      || !unsigned(scenario.reducedOutflowPaise) || !Array.isArray(scenario.adjustments)
      || scenario.adjustments.some(item => !validOption(item) || !unsigned(item.amountPaise)
        || item.amountPaise < item.minimumPaise || item.amountPaise >= item.originalPaise
        || item.acceptedRevision != null && !unsigned(item.acceptedRevision))
      || new Set(scenario.adjustments.map(item => item.eventId)).size !== scenario.adjustments.length
      || scenario.removedAssumptionIds !== undefined && (!Array.isArray(scenario.removedAssumptionIds)
        || !scenario.removedAssumptionIds.every(nonempty)
        || new Set(scenario.removedAssumptionIds).size !== scenario.removedAssumptionIds.length)
      || !validPlan(scenario.plan))
      throw new Error('The saved figures could not be read safely.');
  }
  const workspace = snapshot.workspace;
  const arrays = ['cards', 'questions', 'results', 'contributions', 'actions', 'choices'] as const;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
  const states = ['known', 'estimated', 'uncertain', 'missing', 'conflicting', 'proposed', 'accepted', 'unresolved'];
  const templates = ['cash', 'income', 'essential', 'optional', 'loans', 'creditCards', 'questions', 'timeline', 'gap', 'proposal', 'assumptions', 'invalidation', 'outcome'];
  const amount = (value: unknown) => value === null || Number.isSafeInteger(value);
  if (!workspace || arrays.some(key => !Array.isArray(workspace[key])
    || workspace[key].some(item => !item || typeof item.id !== 'string' || !item.id)
    || new Set(workspace[key].map(item => item.id)).size !== workspace[key].length))
    throw new Error('The saved figures could not be read safely.');
  const results = new Set(workspace.results!.map(item => item.id));
  const contributions = new Set(workspace.contributions!.map(item => item.id));
  const records = new Set(snapshot.facts.records.map(item => item.id));
  if (workspace.cards!.some(card => !templates.includes(card.template) || !states.includes(card.state)
    || !['facts', 'issues', 'timeline', 'decisions', 'outcome'].includes(card.section) || typeof card.title !== 'string'
    || !Array.isArray(card.rows) || card.rows.some(row => !row || typeof row.field !== 'string' || typeof row.label !== 'string' || !states.includes(row.state))
    || !strings(card.recordIds) || card.recordIds.some(id => !records.has(id))
    || !strings(card.resultIds) || card.resultIds.some(id => !results.has(id))
    || !strings(card.eventIds) || !strings(card.issueIds) || !strings(card.dependencies))
    || workspace.results!.some(result => !amount(result.amountPaise) || !states.includes(result.state) || typeof result.rule !== 'string'
      || !strings(result.contributionIds) || !strings(result.excludedIds)
      || [...result.contributionIds, ...result.excludedIds].some(id => !contributions.has(id))
      || !strings(result.recordIds) || !strings(result.eventIds) || !strings(result.issueIds) || !strings(result.dependencies) || !strings(result.assumptions)
      || typeof result.fromDate !== 'string' || typeof result.untilDateExclusive !== 'string')
    || workspace.contributions!.some(item => !amount(item.amountPaise) || !amount(item.balancePaise ?? null)
      || typeof item.included !== 'boolean' || typeof item.reason !== 'string' || !strings(item.references))
    || workspace.questions!.some(item => !strings(item.fields) || !strings(item.recordIds) || !strings(item.resolves)
      || !strings(item.changes) || !strings(item.blocks) || typeof item.why !== 'string')
    || workspace.actions!.some(item => typeof item.question !== 'string' || !strings(item.recordIds))
    || workspace.choices!.some(item => !Array.isArray(item.adjustmentAmounts))
    || (workspace.change && (!Array.isArray(workspace.change.items) || workspace.change.items.some(item =>
      !item || !Array.isArray(item.fields) || !strings(item.recordIds) || !strings(item.resultIds) || !strings(item.cardIds)))))
    throw new Error('The saved figures could not be read safely.');
  return snapshot;
}

/** Validate the conversation settings required by the frontend. */
export function readSettings(value: unknown): Settings {
  const settings = value as Settings | null;
  if (!settings || typeof settings.assistantName !== 'string' || !settings.assistantName.trim()
    || !Number.isFinite(settings.voiceStartupSeconds) || settings.voiceStartupSeconds <= 0
    || !Number.isFinite(settings.voiceShutdownSeconds) || settings.voiceShutdownSeconds <= 0
    || Array.from(settings.assistantName).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error('Conversation settings could not be read safely.');
  return settings;
}

/** Validate the account identity and profile fields used by the frontend. */
function readUser(value: unknown): User {
  const user = value as User | null;
  if (!user || typeof user.googleName !== 'string' || !['id', 'displayName', 'email'].every(key => {
    const field = user[key as keyof User];
    return typeof field === 'string' && field.trim().length > 0;
  })) throw new Error('The account could not be read safely.');
  return user;
}

/** Validate a saved-conversation detail response or history listing. */
function readHistory(value: unknown, detail: boolean) {
  const validDate = (date: unknown) => typeof date === 'string' && Number.isFinite(Date.parse(date));
  /** Check the identity, timing, and message count of a conversation summary. */
  const summary = (item: ConversationSummary | null) => !!item && typeof item.slug === 'string'
    && isHistoryRoute(`/history/${item.slug}`) && typeof item.title === 'string' && item.title.trim().length > 0
    && validDate(item.startedAt) && validDate(item.expiresAt) && (item.endedAt === null || validDate(item.endedAt))
    && Number.isSafeInteger(item.messageCount) && item.messageCount >= 0;
  if (detail) {
    const item = value as SavedConversation | null;
    if (!summary(item) || !item || !Array.isArray(item.messages) || item.messages.length !== item.messageCount
      || item.messages.some(message => !message || typeof message.id !== 'string' || !message.id
        || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || !message.text.trim()
        || !validDate(message.createdAt) || typeof message.interrupted !== 'boolean')
      || new Set(item.messages.map(message => message.id)).size !== item.messages.length)
      throw new Error('The conversation could not be read safely.');
  } else {
    const list = value as components['schemas']['ConversationList'] | null;
    if (!list || !Array.isArray(list.conversations) || !list.conversations.every(summary)
      || new Set(list.conversations.map(item => item.slug)).size !== list.conversations.length)
      throw new Error('History could not be read safely.');
  }
}

/** Send an API request and validate its response within the current authentication context. */
async function request<T>(path: string, init?: RequestInit, text = false): Promise<T> {
  const epoch = generation;
  // Saved-conversation slugs are user-derived titles and stay out of console logs.
  const route = { method: init?.method ?? 'GET', path: `/api/${path.split('?')[0].replace(/^history\/[^/]+/, 'history/{slug}')}` };
  let response: Response;
  try { response = await fetch(`/api/${path}`, { ...init, credentials: 'same-origin' }); }
  catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) log('api.request', { ...route, ...errorFields(error) }, 'warn');
    throw error;
  }
  const requestId = response.headers.get('x-request-id');
  const content = await response.text();
  const protectedRequest = !path.startsWith('auth/');
  // AuthProvider owns deletion completion even when revocation invalidates ordinary requests.
  if (protectedRequest && !(path === 'account' && init?.method === 'DELETE') && epoch !== generation) throw new DOMException('Request no longer current', 'AbortError');
  if (!response.ok) {
    let body: ApiEnvelope;
    try {
      body = JSON.parse(content, exactNumbers) as ApiEnvelope;
      if (!body || typeof body.code !== 'string' || typeof body.message !== 'string') throw new Error('Invalid error response');
      if (body.snapshot !== undefined && body.snapshot !== null) readSnapshot(body.snapshot);
    }
    catch { body = { code: 'unavailable', message: 'The request could not be completed.' }; }
    log('api.request', { ...route, status: response.status, errorCode: body.code, requestId }, 'warn');
    if (protectedRequest && (response.status === 401 || body.code === 'authUnavailable'))
      reportAuthLoss(response.status === 401 ? body.code === 'sessionExpired' ? 'sessionExpired' : 'unauthenticated' : 'authUnavailable', epoch);
    throw new ApiError(response.status, body, requestId);
  }
  const value = response.status === 204 ? undefined : text ? content : JSON.parse(content, exactNumbers);
  if (path === 'session/options' && (!value || !nonempty(value.sessionId) || !unsigned(value.revision)
    || !unsigned(value.sequence) || !isoDate(value.today) || !Array.isArray(value.options)
    || !value.options.every(validOption)
    || new Set(value.options.map((option: AdjustmentOptions['options'][number]) => option.eventId)).size !== value.options.length))
    throw new Error('Planning choices could not be read safely.');
  const selecting = path.startsWith('history/') && path.endsWith('/continue');
  if (!text && !selecting && (path === 'history' || path.startsWith('history?') || path.startsWith('history/')))
    readHistory(value, path.startsWith('history/'));
  if (path === 'session/call') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.callId !== null && (typeof value.callId !== 'string' || !uuid.test(value.callId)))
      throw new Error('Call ownership could not be confirmed.');
    if (init?.method && value.callId !== JSON.parse(String(init.body)).callId)
      throw new Error('Call ownership could not be confirmed.');
    if (init?.method === 'POST') {
      const requested = JSON.parse(String(init.body)).conversationSlug;
      if (typeof value.conversationSlug !== 'string' || !isHistoryRoute(`/history/${value.conversationSlug}`)
        || requested !== undefined && value.conversationSlug !== requested)
        throw new Error('Conversation ownership could not be confirmed.');
      if (typeof value.url !== 'string' || typeof value.token !== 'string' || !value.token.trim()
        || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))
        throw new Error('Call credentials could not be confirmed.');
      const url = new URL(value.url);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.daily.co') || url.hostname === '.daily.co'
        || url.username || url.password || url.port && url.port !== '443' || url.search || url.hash)
        throw new Error('Call destination could not be confirmed.');
      if (Date.parse(value.expiresAt) <= Date.now())
        throw new ApiError(410, { code: 'callExpired', message: 'This call expired. Reconnect to continue with your saved figures.' });
    } else if (value.conversationSlug != null && (typeof value.conversationSlug !== 'string' || !isHistoryRoute(`/history/${value.conversationSlug}`))
      || !['idle', 'connecting', 'active', 'ending', 'ended', 'error'].includes(value.status)
      || typeof value.cleanupConfirmed !== 'boolean' || value.message !== null && typeof value.message !== 'string'
      || ['connecting', 'active', 'ending'].includes(value.status) && !value.callId)
      throw new Error('Call state could not be confirmed.');
  } else if (path === 'auth/session' || path === 'auth/refresh') {
    if (!value || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.now()) throw new Error('The sign-in could not be confirmed.');
    readUser(value.user);
  } else if (path === 'auth/settings') {
    if (!value || typeof value.googleAvailable !== 'boolean' || !Number.isSafeInteger(value.sessionHours)
      || value.sessionHours <= 0) throw new Error('Sign-in availability could not be checked.');
  } else if (path === 'auth/login') {
    if (!value || typeof value.url !== 'string' || !value.url.trim()) throw new Error('Sign-in could not start.');
  } else if (path === 'auth/logout') {
    if (response.status !== 204) throw new Error('Sign-out could not be confirmed.');
  } else if (path === 'account') {
    if (init?.method === 'DELETE') {
      if (value?.deleted !== true) throw new Error('Account deletion could not be confirmed.');
    } else readUser(value);
  }
  return (response.status !== 204 && (path === 'session' && init?.method !== 'DELETE' || path === 'session/commands' || selecting)
    ? readSnapshot(value) : value) as T;
}

/** Expose the application's account, conversation, and financial-session API operations. */
export const api = {
  history: {
    /** Fetch saved conversations, optionally filtered by search text. */
    list: (search = '', signal?: AbortSignal) => request<components['schemas']['ConversationList']>(
      `history${search ? `?${new URLSearchParams({ search })}` : ''}`, { signal }),
    /** Fetch a saved conversation and its messages. */
    get: (slug: string, signal?: AbortSignal) => request<SavedConversation>(`history/${encodeURIComponent(slug)}`, { signal }),
    /** Select a saved conversation's financial workspace without starting a call. */
    continue: async (slug: string, signal?: AbortSignal) => {
      if (!isHistoryRoute(`/history/${slug}`)) throw new Error('Invalid conversation.');
      return request<Snapshot>(`history/${slug}/continue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
      });
    },
    /** Fetch a saved conversation's plain-text caption export. */
    transcript: (slug: string, signal?: AbortSignal) => request<string>(`history/${encodeURIComponent(slug)}/transcript`, { signal }, true),
  },
  auth: {
    /** Fetch Google sign-in availability and session settings. */
    settings: (signal?: AbortSignal) => request<AuthSettings>('auth/settings', { signal }),
    /** Fetch the current authenticated session. */
    session: (signal?: AbortSignal) => request<AuthSession>('auth/session', { signal }),
    /** Revalidate the current sign-in session. */
    refresh: (signal?: AbortSignal) => request<AuthSession>('auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
    }),
    /** Begin Google sign-in for a permitted return destination. */
    login: (returnTo: ReturnPath) => request<components['schemas']['LoginURL']>('auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo }),
    }),
    /** End the current sign-in session. */
    logout: () => request<void>('auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }),
  },
  account: {
    /** Save the account's display name. */
    update: (displayName: string) => request<User>('account', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }),
    }),
    /** Permanently delete the app account after explicit confirmation. */
    delete: (confirmation: 'DELETE') => request<components['schemas']['AccountDeleted']>('account', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation }),
    }),
  },
  /** Fetch the current call's status and cleanup confirmation. */
  call: (signal?: AbortSignal) => request<CallState>('session/call', { signal }),
  /** Request call credentials for a new or selected saved conversation. */
  startCall: async (callId: string, conversationSlug?: string) => {
    if (conversationSlug !== undefined && !isHistoryRoute(`/history/${conversationSlug}`)) throw new Error('Invalid conversation.');
    return request<CallJoin>('session/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, conversationSlug }),
    });
  },
  /** Request termination of the specified owned call. */
  endCall: (callId: string, signal?: AbortSignal) => request<CallState>('session/call', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId }), keepalive: true, signal,
  }),
  /** Fetch and validate application settings. */
  settings: (signal?: AbortSignal) => request<Settings>('settings', { signal }).then(readSettings),
  /** Fetch the current saved financial snapshot. */
  current: (signal?: AbortSignal) => request<Snapshot>('session', { signal }),
  /** Fetch eligible planning adjustments for the current saved figures. */
  options: (signal?: AbortSignal) => request<AdjustmentOptions>('session/options', { signal }),
  /** Create or retrieve the current financial session. */
  start: () => request<Snapshot>('session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }),
  /** Submit a financial command and return the confirmed snapshot. */
  save: (command: Command) => request<Snapshot>('session/commands', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  }),
  /** Fetch a plain-text export of the saved plan. */
  export: () => request<string>('session/export', undefined, true),
  /** Delete the current plan and its associated conversations. */
  delete: () => request<components['schemas']['Deleted']>('session', { method: 'DELETE' }),
};

/** Describe a saved-conversation failure with guidance for recovery. */
export function conversationError(error: unknown): string {
  if (error instanceof ApiError) {
    if ([403, 404, 410].includes(error.status)) return 'This conversation is unavailable. It may have expired or been deleted. Choose another conversation.';
    if (error.body.code === 'conversationMemoryUnavailable') return 'You can still read this conversation, but its saved figures are unavailable. Choose another conversation to continue.';
    if (error.body.code === 'conversationChanged') return 'The selected conversation has changed. Open it again from History before continuing.';
    if (error.status === 409) return 'A call may still be open. Return to Conversation and confirm it has ended, then try again.';
    if (error.status === 401) return 'Sign in again to open this conversation.';
  }
  return 'Couldn’t open this conversation. Check your connection, then try Continue talking again.';
}

/** Describe a financial-session failure with guidance for the attempted operation. */
export function errorMessage(error: unknown, operation?: Command['operation']['type']): string {
  if (!(error instanceof ApiError)) return operation && ['previewAdjustments', 'acceptPreview', 'discardPreview', 'rejectPreview', 'clearAccepted'].includes(operation)
    ? 'This proposal action could not be confirmed. Keep this page open, check your connection, and retry the same action safely.'
    : 'We could not reach your projection. Check your connection and retry.';
  if (error.body.code === 'invalidStoredState') return 'The service is reachable, but your saved figures could not be read. They have not been deleted.';
  if (error.status === 410) return 'This projection has expired. Start again to enter fresh figures.';
  if (error.status === 404) return 'This projection is no longer available. You can start again.';
  if (error.body.code === 'invalidActionResponse' || (error.body.code === 'staleRevision' && operation === 'respondToAction'))
    return 'Your answer was not saved because this next step has changed or is no longer available. Review the current next step before answering again.';
  if (error.body.code === 'staleRevision' && operation === 'updateFacts')
    return 'Saved figures changed elsewhere. Review the current figures before retrying your corrections.';
  if (error.body.code === 'staleRevision') return operation && operation !== 'replaceFacts'
    ? 'Saved figures changed elsewhere. Review the current projection and refresh your choices before comparing again.'
    : 'Saved figures changed elsewhere. Your draft is still here; review it before saving.';
  if (error.body.code === 'stalePreview') {
    if (operation === 'respondToAction') return 'Your answer was not saved because the open proposal differs from this suggested cut. Review the proposal or choose “Reject preview” before answering again.';
    if (operation === 'previewAdjustments') return 'Another preview changed while you were choosing amounts. Review the current preview before replacing it.';
    if (operation === 'discardPreview') return 'This preview is no longer available to close. Review the current proposal before trying again. Closing a preview does not reject it.';
    if (operation === 'rejectPreview') return 'This preview is no longer available to reject. Review the current proposal before trying again.';
    return 'This preview is no longer available to accept. Review the current preview or refresh eligible choices and preview again; a date may have passed.';
  }
  if (error.body.code === 'proposalRejected') return 'This exact set of proposed changes was previously declined. Choose another amount or a different set of changes to preview.';
  if (error.body.code === 'noAccepted') return 'There are no saved assumptions to clear. The current saved projection is shown.';
  if (error.body.code === 'invalidAdjustments') return 'These changes are no longer eligible. Refresh choices, check each amount and confirmation, then preview again.';
  if (error.status === 503 || error.status >= 500) return 'Saving is temporarily unavailable. Keep this page open and retry.';
  if (error.status === 429) return 'The service is busy or this projection has reached a limit. Wait before retrying, or export and start again.';
  if (error.status === 413) return 'This draft is too large. Remove some items before saving.';
  if (error.status === 422) return 'Some figures cannot be saved. Check amounts, dates, category review, and the number of repeating items.';
  if (error.body.code === 'commandConflict') return 'This save could not be confirmed. Export the saved figures before starting again.';
  return 'This action is unavailable. Check your connection or try reloading the saved projection.';
}