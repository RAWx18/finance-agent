// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { components } from './contracts';
import { isHistoryRoute } from './historyRoutes';

export type Snapshot = components['schemas']['Snapshot'];
export type Settings = components['schemas']['Settings'];
export type FactsInput = components['schemas']['FactsInput'];
export type RecordInput = components['schemas']['RecordInput'];
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
export type AuthLoss = 'unauthenticated' | 'sessionExpired' | 'authUnavailable';

let generation = 0;
export const authEpoch = () => generation;
export function invalidateRequests() { generation++; }
export function reportAuthLoss(code: AuthLoss, epoch = generation) {
  if (epoch === generation) window.dispatchEvent(new CustomEvent<AuthLoss>('auth:loss', { detail: code }));
}

export class ApiError extends Error {
  constructor(public status: number, public body: ApiEnvelope) {
    super(body.message);
  }
}

// JSON numbers crossing the boundary must retain every paise and sequence digit.
export function exactNumbers(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('The saved figures could not be read safely.');
  }
  return value;
}

export function readSnapshot(value: unknown): Snapshot {
  const snapshot = value as Snapshot | null;
  if (!snapshot || typeof snapshot.sessionId !== 'string' || !snapshot.sessionId
    || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || typeof snapshot.anchorDate !== 'string' || typeof snapshot.endDateExclusive !== 'string'
    || typeof snapshot.expiresAt !== 'string' || !snapshot.facts?.opening || !snapshot.facts.coverage
    || !Array.isArray(snapshot.facts.records) || !Array.isArray(snapshot.facts.conflicts)
    || !snapshot.plan || !Array.isArray(snapshot.plan.events))
    throw new Error('The saved figures could not be read safely.');
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

export function readSettings(value: unknown): Settings {
  const settings = value as Settings | null;
  if (!settings || typeof settings.assistantName !== 'string' || !settings.assistantName.trim()
    || !Number.isFinite(settings.voiceStartupSeconds) || settings.voiceStartupSeconds <= 0
    || !Number.isFinite(settings.voiceShutdownSeconds) || settings.voiceShutdownSeconds <= 0
    || Array.from(settings.assistantName).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error('Conversation settings could not be read safely.');
  return settings;
}

function readUser(value: unknown): User {
  const user = value as User | null;
  if (!user || typeof user.googleName !== 'string' || !['id', 'displayName', 'email'].every(key => {
    const field = user[key as keyof User];
    return typeof field === 'string' && field.trim().length > 0;
  })) throw new Error('The account could not be read safely.');
  return user;
}

function readHistory(value: unknown, detail: boolean) {
  const validDate = (date: unknown) => typeof date === 'string' && Number.isFinite(Date.parse(date));
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

async function request<T>(path: string, init?: RequestInit, text = false): Promise<T> {
  const epoch = generation;
  const response = await fetch(`/api/${path}`, { ...init, credentials: 'same-origin' });
  const content = await response.text();
  const protectedRequest = !path.startsWith('auth/');
  if (protectedRequest && epoch !== generation) throw new DOMException('Request no longer current', 'AbortError');
  if (!response.ok) {
    let body: ApiEnvelope;
    try { body = JSON.parse(content, exactNumbers) as ApiEnvelope; }
    catch { body = { code: 'unavailable', message: 'The request could not be completed.' }; }
    if (protectedRequest && (response.status === 401 || body.code === 'authUnavailable'))
      reportAuthLoss(response.status === 401 ? body.code === 'sessionExpired' ? 'sessionExpired' : 'unauthenticated' : 'authUnavailable', epoch);
    throw new ApiError(response.status, body);
  }
  const value = response.status === 204 ? undefined : text ? content : JSON.parse(content, exactNumbers);
  if (!text && (path === 'history' || path.startsWith('history?') || path.startsWith('history/')))
    readHistory(value, path.startsWith('history/'));
  if (path === 'auth/session' || path === 'auth/refresh') {
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
  return (response.status !== 204 && (path === 'session' && init?.method !== 'DELETE' || path === 'session/commands')
    ? readSnapshot(value) : value) as T;
}

export const api = {
  history: {
    list: (search = '', signal?: AbortSignal) => request<components['schemas']['ConversationList']>(
      `history${search ? `?${new URLSearchParams({ search })}` : ''}`, { signal }),
    get: (slug: string, signal?: AbortSignal) => request<SavedConversation>(`history/${encodeURIComponent(slug)}`, { signal }),
    transcript: (slug: string, signal?: AbortSignal) => request<string>(`history/${encodeURIComponent(slug)}/transcript`, { signal }, true),
  },
  auth: {
    settings: (signal?: AbortSignal) => request<AuthSettings>('auth/settings', { signal }),
    session: (signal?: AbortSignal) => request<AuthSession>('auth/session', { signal }),
    refresh: (signal?: AbortSignal) => request<AuthSession>('auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
    }),
    login: (returnTo: ReturnPath) => request<components['schemas']['LoginURL']>('auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo }),
    }),
    logout: () => request<void>('auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }),
  },
  account: {
    update: (displayName: string) => request<User>('account', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }),
    }),
    delete: (confirmation: 'DELETE') => request<components['schemas']['AccountDeleted']>('account', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation }),
    }),
  },
  call: (signal?: AbortSignal) => request<CallState>('session/call', { signal }),
  startCall: (callId: string) => request<CallJoin>('session/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId }),
  }),
  endCall: (callId: string, signal?: AbortSignal) => request<CallState>('session/call', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId }), keepalive: true, signal,
  }),
  settings: (signal?: AbortSignal) => request<Settings>('settings', { signal }).then(readSettings),
  current: (signal?: AbortSignal) => request<Snapshot>('session', { signal }),
  options: (signal?: AbortSignal) => request<AdjustmentOptions>('session/options', { signal }),
  start: () => request<Snapshot>('session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }),
  save: (command: Command) => request<Snapshot>('session/commands', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  }),
  export: () => request<string>('session/export', undefined, true),
  delete: () => request<components['schemas']['Deleted']>('session', { method: 'DELETE' }),
};

export function errorMessage(error: unknown, operation?: Command['operation']['type']): string {
  if (!(error instanceof ApiError)) return 'We could not reach your projection. Check your connection and retry.';
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
    if (operation === 'discardPreview' || operation === 'rejectPreview') return 'This preview is no longer available to reject. Review the current proposal before trying again.';
    return 'This preview is no longer available to accept. Review the current preview or refresh eligible choices and preview again; a date may have passed.';
  }
  if (error.body.code === 'noAccepted') return 'There are no saved assumptions to clear. The current saved projection is shown.';
  if (error.body.code === 'invalidAdjustments') return 'These changes are no longer eligible. Refresh choices, check each amount and confirmation, then preview again.';
  if (error.status === 503 || error.status >= 500) return 'Saving is temporarily unavailable. Keep this page open and retry.';
  if (error.status === 429) return 'The service is busy or this projection has reached a limit. Wait before retrying, or export and start again.';
  if (error.status === 413) return 'This draft is too large. Remove some items before saving.';
  if (error.status === 422) return 'Some figures cannot be saved. Check amounts, dates, category review, and the number of repeating items.';
  if (error.body.code === 'commandConflict') return 'This save could not be confirmed. Export the saved figures before starting again.';
  return 'This action is unavailable. Check your connection or try reloading the saved projection.';
}