// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';

export type Notice = {
  id: string;
  title: string;
  message?: string;
  severity: 'info' | 'success' | 'warning' | 'error' | 'critical';
  action?: { label: string; onClick: () => void | Promise<void>; disabled?: boolean };
  duration?: number | null;
  dismissible?: boolean;
};

type Entry = {
  notice: Notice;
  version: number;
  remaining: number | null;
  started: number;
  timer: ReturnType<typeof setTimeout> | null;
  element: HTMLElement | null;
};
type Snapshot = { notices: { entry: Entry; notice: Notice }[]; host: HTMLElement | null };

const durations = { info: 6000, success: 6000, warning: 8000, error: null, critical: null };
const priority = { critical: 0, error: 1, warning: 2, success: 3, info: 3 };
const labels = { info: 'Update', success: 'Success', warning: 'Warning', error: 'Error', critical: 'Important' };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const hosts: { element: HTMLElement }[] = [];
const emptySnapshot: Snapshot = { notices: [], host: null };
let snapshot = emptySnapshot;
let viewport: HTMLElement | null = null;
let hovered = false;
let focused = false;
let returnFocus: HTMLElement | null = null;
let generation = 0;

function publish() {
  snapshot = {
    notices: [...entries.values()].sort((a, b) => priority[a.notice.severity] - priority[b.notice.severity])
      .map(entry => ({ entry, notice: entry.notice })),
    host: hosts.at(-1)?.element ?? null,
  };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function stopTimer(entry: Entry) {
  if (entry.timer === null) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.remaining !== null) entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.started));
}

function paused(entry: Entry) {
  return !viewport?.isConnected || !entry.element?.isConnected || hovered || focused || document.hidden
    || viewport.contains(document.activeElement);
}

function schedule(entry: Entry) {
  if (entries.get(entry.notice.id) !== entry || entry.remaining === null || paused(entry)) {
    stopTimer(entry);
    return;
  }
  if (entry.timer !== null) return;
  const version = entry.version;
  entry.started = Date.now();
  const timer = setTimeout(() => {
    if (entries.get(entry.notice.id) !== entry || entry.version !== version || entry.timer !== timer) return;
    stopTimer(entry);
    if (!paused(entry)) dismiss(entry.notice.id);
  }, entry.remaining);
  entry.timer = timer;
}

function updateTimers() {
  for (const entry of entries.values()) schedule(entry);
}

function restoreFocus() {
  if (returnFocus?.isConnected && !returnFocus.matches(':disabled')
    && !returnFocus.closest('[hidden], [inert], dialog:not([open])')
    && (!snapshot.host || snapshot.host.contains(returnFocus))) returnFocus.focus({ preventScroll: true });
}

export function notify(notice: Notice): void {
  if (typeof notice.title !== 'string' || (notice.message !== undefined && typeof notice.message !== 'string')) return;
  const duration = notice.dismissible === false ? null
    : notice.duration !== undefined ? notice.duration : notice.action ? null : durations[notice.severity];
  notice = { ...notice, duration, dismissible: notice.dismissible ?? true,
    action: notice.action ? { ...notice.action, disabled: notice.action.disabled ?? false } : undefined };
  const entry = entries.get(notice.id);
  if (entry) {
    const previous = entry.notice;
    const changed = previous.title !== notice.title || previous.message !== notice.message || previous.severity !== notice.severity
      || previous.action?.label !== notice.action?.label || previous.duration !== duration || previous.dismissible !== notice.dismissible;
    entry.notice = notice;
    if (changed) {
      stopTimer(entry);
      entry.version++;
      entry.remaining = duration;
      schedule(entry);
    }
    // Callback identity is not visible content; actions always read the current entry.
    if (changed || previous.action?.disabled !== notice.action?.disabled) publish();
    return;
  }
  entries.set(notice.id, { notice, version: 0, remaining: duration, started: 0, timer: null, element: null });
  publish();
}

export function dismiss(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  stopTimer(entry);
  entries.delete(id);
  if (entry.element?.contains(document.activeElement)) restoreFocus();
  publish();
}

export function dismissAll(): void {
  generation++;
  if (!entries.size) return;
  for (const entry of entries.values()) stopTimer(entry);
  entries.clear();
  if (viewport?.contains(document.activeElement)) restoreFocus();
  publish();
}

export function registerToastHost(element: HTMLElement): () => void {
  const host = { element };
  hosts.push(host);
  if (snapshot.host !== element) publish();
  return () => {
    const index = hosts.indexOf(host);
    if (index < 0) return;
    hosts.splice(index, 1);
    if (snapshot.host !== (hosts.at(-1)?.element ?? null)) publish();
  };
}

function ToastItem({ entry, notice }: { entry: Entry; notice: Notice }) {
  const id = useId();
  const attach = useCallback((element: HTMLElement | null) => {
    stopTimer(entry);
    entry.element = element;
    schedule(entry);
  }, [entry]);

  return <li><article ref={attach} className="toast" data-severity={notice.severity}
    role={notice.severity === 'error' || notice.severity === 'critical' ? 'alert' : 'status'}
    aria-labelledby={`${id}-title`} aria-describedby={notice.message ? `${id}-message` : undefined} aria-atomic="true">
    <span className="toast-severity">{labels[notice.severity]}</span>
    <h2 className="toast-title" id={`${id}-title`}>{notice.title}</h2>
    {notice.message && <p className="toast-message" id={`${id}-message`}>{notice.message}</p>}
    {(notice.action || notice.dismissible !== false) && <div className="toast-actions">
      {notice.action && <button type="button" className="toast-action" title={notice.action.label} disabled={notice.action.disabled}
        onClick={async () => {
          const action = entry.notice.action;
          if (entries.get(entry.notice.id) !== entry || !action || action.disabled) return;
          const currentGeneration = generation;
          dismiss(entry.notice.id);
          try { await action.onClick(); }
          catch {
            if (generation === currentGeneration) notify({ id: `toast:${entry.notice.id}:action`, severity: 'error',
              title: 'Could not complete that action', message: 'Please try again from the original control.' });
          }
        }}>{notice.action.label}</button>}
      {notice.dismissible !== false && <button type="button" className="toast-dismiss" aria-label={`Dismiss ${notice.title}`}
        onClick={() => { if (entries.get(entry.notice.id) === entry && entry.notice.dismissible !== false) dismiss(entry.notice.id); }}>
        <span aria-hidden="true">×</span>
      </button>}
    </div>}
  </article></li>;
}

export function ToastViewport(): JSX.Element {
  const { notices, host } = useSyncExternalStore(subscribe, () => snapshot, () => emptySnapshot);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const attach = useCallback((element: HTMLElement | null) => {
    for (const entry of entries.values()) stopTimer(entry);
    viewport = element;
    hovered = element?.matches(':hover') ?? false;
    focused = element?.contains(document.activeElement) ?? false;
    updateTimers();
  }, []);

  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !active.closest('.toast-viewport')) returnFocus = active;
    const focus = (event: FocusEvent) => {
      const target = event.type === 'focusout' ? event.relatedTarget : event.target;
      focused = target instanceof Node && (viewport?.contains(target) ?? false);
      if (target instanceof HTMLElement && target !== document.body && !target.closest('.toast-viewport')) returnFocus = target;
      updateTimers();
    };
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', focus);
    document.addEventListener('visibilitychange', updateTimers);
    return () => {
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', focus);
      document.removeEventListener('visibilitychange', updateTimers);
      returnFocus = null;
    };
  }, []);

  return createPortal(<aside ref={attach} className="toast-viewport" aria-label="Notifications" hidden={!notices.length}
    onPointerEnter={event => { if (event.pointerType !== 'touch') { hovered = true; updateTimers(); } }}
    onPointerLeave={() => { hovered = false; updateTimers(); }}>
    <ol id={id} className="toast-stack" aria-label="Notification list" tabIndex={0}>
      {(expanded ? notices : notices.slice(0, 3)).map(item => <ToastItem key={item.notice.id} {...item} />)}
    </ol>
    {notices.length > 3 && <button type="button" className="toast-more" aria-controls={id} aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer notifications' : `${notices.length - 3} more notifications`}</button>}
  </aside>, host ?? document.body);
}