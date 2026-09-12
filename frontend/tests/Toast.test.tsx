// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { Profiler, StrictMode, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../src/Dialog';
import { dismiss, dismissAll, notify, registerToastHost, ToastViewport } from '../src/Toast';
import type { Notice } from '../src/Toast';

const saved: Notice = { id: 'saved', title: 'Figures saved', message: 'Your plan includes these figures.', severity: 'success' };

/** Advances fake time within React's update boundary for toast lifetime tests. */
function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds));
}

/** Exposes promise settlement controls for asynchronous notification actions. */
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});

describe('toast store and lifetimes', () => {
  it('accepts notices before mounting without a provider or stealing focus', () => {
    render(<button type="button">Review figures</button>);
    const trigger = screen.getByRole('button', { name: 'Review figures' });
    trigger.focus();
    notify(saved);
    advance(60000);
    expect(vi.getTimerCount()).toBe(0);
    const view = render(<StrictMode><ToastViewport /></StrictMode>);
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.getByRole('complementary', { name: 'Notifications' }).parentElement).toBe(document.body);
    expect(screen.getByRole('status', { name: saved.title })).toHaveTextContent(saved.message!);
    expect(screen.getByRole('button', { name: `Dismiss ${saved.title}` })).toBeEnabled();
    expect(trigger).toHaveFocus();
    advance(6000);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each([
    ['info', 'status', 6000], ['success', 'status', 6000], ['warning', 'status', 8000],
    ['error', 'alert', null], ['critical', 'alert', null],
  ] as const)('uses the %s role and default lifetime', (severity, role, duration) => {
    render(<ToastViewport />);
    act(() => notify({ ...saved, severity }));
    const notice = screen.getByRole(role, { name: saved.title });
    expect(notice).toHaveAttribute('data-severity', severity);
    expect(notice).toHaveAttribute('aria-atomic', 'true');
    expect(notice).toHaveAccessibleDescription(saved.message);
    expect(notice.querySelector('.toast-severity')).not.toBeEmptyDOMElement();
    advance(duration === null ? 60000 : duration - 1);
    expect(notice).toBeInTheDocument();
    if (duration !== null) {
      advance(1);
      expect(notice).not.toBeInTheDocument();
    } else expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps actionable notices and explicit null durations persistent', () => {
    render(<ToastViewport />);
    act(() => {
      notify({ ...saved, id: 'review', severity: 'info', action: { label: 'Review', onClick: vi.fn() } });
      notify({ ...saved, id: 'check', severity: 'warning', action: { label: 'Check', onClick: vi.fn(), disabled: true } });
      notify({ ...saved, duration: null });
    });
    advance(60000);
    expect(screen.getAllByRole('status')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('protects a non-dismissible critical notice even with an explicit duration', () => {
    const retry = vi.fn();
    render(<ToastViewport />);
    act(() => notify({ ...saved, id: 'cleanup', duration: 1000 }));
    advance(500);
    act(() => notify({ id: 'cleanup', title: 'Microphone release is not confirmed', severity: 'critical', duration: 1,
      dismissible: false, action: { label: 'Retry cleanup', onClick: retry, disabled: true } }));
    advance(60000);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(retry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    act(() => dismiss('cleanup'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('deduplicates visible content while reading the latest action and disabled state', () => {
    const commits = vi.fn();
    const initial = vi.fn();
    const current = vi.fn();
    const notice: Notice = { ...saved, severity: 'error', action: { label: 'Try again', onClick: initial } };
    notify(notice);
    render(<Profiler id="notifications" onRender={commits}><ToastViewport /></Profiler>);
    const count = commits.mock.calls.length;
    const alert = screen.getByRole('alert');
    const button = screen.getByRole('button', { name: 'Try again' });
    for (let index = 0; index < 10; index++) {
      act(() => notify({ ...notice, action: { label: 'Try again', onClick: () => current() } }));
    }
    expect(commits).toHaveBeenCalledTimes(count);
    expect(screen.getByRole('alert')).toBe(alert);
    act(() => notify({ ...notice, action: { label: 'Try again', onClick: current, disabled: true } }));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(current).not.toHaveBeenCalled();
    act(() => {
      notify({ ...notice, action: { label: 'Try again', onClick: initial, disabled: false } });
    });
    const enabledCount = commits.mock.calls.length;
    act(() => notify({ ...notice, action: { label: 'Try again', onClick: current, disabled: false } }));
    expect(commits).toHaveBeenCalledTimes(enabledCount);
    expect(screen.getByRole('button', { name: 'Try again' })).toBe(button);
    fireEvent.click(button);
    expect(current).toHaveBeenCalledOnce();
    expect(initial).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not restart deadlines for callback or disabled-only updates', () => {
    render(<ToastViewport />);
    const notice: Notice = { ...saved, duration: 1000, action: { label: 'Review', onClick: vi.fn(), disabled: true } };
    act(() => notify(notice));
    advance(400);
    act(() => notify({ ...notice, action: { label: 'Review', onClick: vi.fn(), disabled: true } }));
    advance(300);
    act(() => notify({ ...notice, action: { label: 'Review', onClick: vi.fn(), disabled: false } }));
    advance(299);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('gives changed messages a current deadline and ignores obsolete callbacks', () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    render(<ToastViewport />);
    act(() => notify({ ...saved, duration: 1000 }));
    const expire = timers.mock.calls.find(([, delay]) => delay === 1000)![0] as () => void;
    advance(500);
    act(() => notify({ ...saved, title: 'Correction saved', duration: 2000 }));
    act(expire);
    advance(1999);
    expect(screen.getByRole('status', { name: 'Correction saved' })).toBeVisible();
    expect(vi.getTimerCount()).toBe(1);
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('allows a dismissed ID to return without a stale timer deleting it', () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    render(<ToastViewport />);
    act(() => notify(saved));
    const expire = timers.mock.calls.find(([, delay]) => delay === 6000)![0] as () => void;
    act(() => { dismiss(saved.id); notify(saved); });
    act(expire);
    expect(screen.getByRole('status')).toBeVisible();
    advance(5999);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('rejects non-string titles and messages at the callback boundary', () => {
    render(<ToastViewport />);
    act(() => {
      notify({ ...saved, title: new Error('Private diagnostic') as unknown as string });
      notify({ ...saved, message: { detail: 'Private diagnostic' } as unknown as string });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Private diagnostic');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears visible and queued notices and cancels every clock', () => {
    render(<ToastViewport />);
    act(() => { for (let index = 0; index < 5; index++) notify({ ...saved, id: String(index) }); });
    expect(screen.getAllByRole('status')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(3);
    act(dismissAll);
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    advance(60000);
    act(() => notify({ ...saved, id: '0' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /more notifications/ })).not.toBeInTheDocument();
    act(() => { dismiss('absent'); dismiss('0'); dismiss('0'); dismissAll(); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves remaining time across viewport unmounts and StrictMode remounts', () => {
    notify({ ...saved, duration: 1000 });
    const view = render(<StrictMode><ToastViewport /></StrictMode>);
    advance(400);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    advance(60000);
    render(<StrictMode><ToastViewport /></StrictMode>);
    advance(599);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('toast queue and reading', () => {
  it('minimizes without discarding critical notices or running hidden expiry timers', () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const cancelled = vi.spyOn(globalThis, 'clearTimeout');
    render(<ToastViewport />);
    act(() => {
      notify({ id: 'pending', title: 'Save not confirmed', severity: 'critical', dismissible: false });
      notify({ ...saved, duration: 1000 });
    });
    const expiry = timers.mock.results[timers.mock.calls.findIndex(([, delay]) => delay === 1000)]!.value;
    const toggle = screen.getByRole('button', { name: 'Minimize notifications' });
    const list = screen.getByRole('list', { name: 'Notification list' });
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    act(() => toggle.focus());
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(list);
    expect(list).not.toBeVisible();
    expect(list).toBeEmptyDOMElement();
    expect(cancelled).toHaveBeenCalledWith(expiry);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    advance(60000);
    const restore = screen.getByRole('button', { name: 'Important notifications (2)' });
    fireEvent.click(restore);
    expect(restore).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'Notification list' })).toBe(list);
    expect(list).toBeVisible();
    expect(screen.getByRole('alert', { name: 'Save not confirmed' })).toBeVisible();
    expect(screen.getByRole('status', { name: saved.title })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Dismiss Save not confirmed' })).not.toBeInTheDocument();
    act(() => toggle.blur());
    advance(999);
    expect(screen.getByRole('status', { name: saved.title })).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status', { name: saved.title })).not.toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Save not confirmed' })).toBeVisible();
  });
  it('prioritizes critical and error notices without discarding queued critical notices', () => {
    render(<ToastViewport />);
    act(() => {
      notify({ ...saved, id: 'info', title: 'Information', severity: 'info' });
      notify({ ...saved, id: 'error', title: 'Connection failed', severity: 'error' });
      for (let index = 1; index <= 4; index++) notify({ id: `critical${index}`, title: `Important ${index}`, severity: 'critical', dismissible: false });
    });
    expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Important 1', 'Important 2', 'Important 3']);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    advance(60000);
    const more = screen.getByRole('button', { name: '3 more notifications' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(screen.getAllByRole('heading').map(heading => heading.textContent))
      .toEqual(['Important 1', 'Important 2', 'Important 3', 'Important 4', 'Connection failed', 'Information']);
    expect(screen.getByRole('list', { name: 'Notification list' })).toHaveAttribute('id', more.getAttribute('aria-controls'));
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer notifications' }));
    act(() => dismiss('critical1'));
    expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Important 2', 'Important 3', 'Important 4']);
    expect(screen.getByRole('button', { name: '2 more notifications' })).toBeVisible();
  });

  it('runs queued clocks only while displayed and resumes rather than resetting them', () => {
    render(<ToastViewport />);
    act(() => {
      for (let index = 0; index < 3; index++) notify({ id: `error${index}`, title: `Check ${index}`, severity: 'error' });
      notify({ ...saved, duration: 1000 });
    });
    advance(60000);
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '1 more notifications' }));
    advance(400);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer notifications' }));
    expect(vi.getTimerCount()).toBe(0);
    advance(60000);
    fireEvent.click(screen.getByRole('button', { name: '1 more notifications' }));
    advance(599);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(3);
  });

  it('pauses the whole stack for overlapping hover, focus and document hiding', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    render(<><button type="button">Continue planning</button><ToastViewport /></>);
    act(() => {
      notify({ ...saved, duration: 1000 });
      notify({ ...saved, id: 'reminder', title: 'Reminder', duration: 1000 });
    });
    const viewport = screen.getByRole('complementary', { name: 'Notifications' });
    advance(200);
    fireEvent.pointerOver(viewport, { pointerType: 'mouse' });
    advance(10000);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    act(() => screen.getByRole('list', { name: 'Notification list' }).focus());
    fireEvent.pointerOut(viewport, { pointerType: 'mouse', relatedTarget: document.body });
    advance(10000);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    act(() => screen.getByRole('button', { name: 'Continue planning' }).focus());
    advance(10000);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    advance(799);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not interpret touch pointer entry as hovering', () => {
    render(<ToastViewport />);
    act(() => notify({ ...saved, duration: 1000 }));
    fireEvent.pointerOver(screen.getByRole('complementary', { name: 'Notifications' }), { pointerType: 'touch' });
    advance(1000);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps revised content paused until focus leaves the stack', () => {
    render(<><button type="button">Continue planning</button><ToastViewport /></>);
    act(() => notify({ ...saved, duration: 1000 }));
    advance(200);
    const close = screen.getByRole('button', { name: `Dismiss ${saved.title}` });
    act(() => close.focus());
    act(() => notify({ ...saved, title: 'Correction saved', duration: 2000 }));
    advance(60000);
    expect(close).toHaveFocus();
    expect(close).toHaveAccessibleName('Dismiss Correction saved');
    expect(vi.getTimerCount()).toBe(0);
    act(() => screen.getByRole('button', { name: 'Continue planning' }).focus());
    advance(1999);
    expect(screen.getByRole('status', { name: 'Correction saved' })).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('toast actions and focus', () => {
  it('returns focus to the app trigger after an explicit dismissal', () => {
    render(<><button type="button">Review figures</button><ToastViewport /></>);
    const trigger = screen.getByRole('button', { name: 'Review figures' });
    act(() => trigger.focus());
    act(() => notify(saved));
    expect(trigger).toHaveFocus();
    act(() => screen.getByRole('list', { name: 'Notification list' }).focus());
    expect(screen.getByRole('list', { name: 'Notification list' })).toHaveFocus();
    act(() => screen.getByRole('button', { name: `Dismiss ${saved.title}` }).focus());
    expect(screen.getByRole('button', { name: `Dismiss ${saved.title}` })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: `Dismiss ${saved.title}` }));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['disabled', 'disconnected'] as const)('does not restore focus to a %s app trigger', state => {
    const view = render(<><section><button type="button">Review figures</button></section><ToastViewport /></>);
    const trigger = screen.getByRole('button', { name: 'Review figures' });
    act(() => trigger.focus());
    act(() => notify(saved));
    const close = screen.getByRole('button', { name: `Dismiss ${saved.title}` });
    act(() => close.focus());
    view.rerender(<><section>{state === 'disabled' && <button type="button" disabled>Review figures</button>}</section><ToastViewport /></>);
    fireEvent.click(close);
    expect(trigger).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('dismisses before invoking an action and retains a replacement after resolution', async () => {
    const pending = deferred();
    render(<><button type="button">Review figures</button><ToastViewport /></>);
    const trigger = screen.getByRole('button', { name: 'Review figures' });
    act(() => trigger.focus());
    const retry = vi.fn(() => {
      expect(trigger).toHaveFocus();
      notify({ id: 'connection', title: 'Checking the connection', severity: 'critical', dismissible: false });
      return pending.promise;
    });
    act(() => notify({ id: 'connection', title: 'Connection interrupted', severity: 'error', action: { label: 'Try again', onClick: retry } }));
    act(() => screen.getByRole('button', { name: 'Try again' }).focus());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert', { name: 'Connection interrupted' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Checking the connection' })).toBeVisible();
    await act(async () => pending.resolve());
    expect(screen.getByRole('alert', { name: 'Checking the connection' })).toBeVisible();
  });

  it.each(['throw', 'reject'] as const)('handles an action %s with safe persistent copy without replacing critical state', async mode => {
    render(<ToastViewport />);
    /** Publishes a critical notice before simulating synchronous or asynchronous action failure. */
    const retry = () => {
      notify({ id: 'cleanup', title: 'Microphone release is not confirmed', severity: 'critical', dismissible: false });
      const error = new Error('Private provider diagnostic and credentials');
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    };
    act(() => notify({ id: 'cleanup', title: 'Please check the microphone', severity: 'error', action: { label: 'Retry cleanup', onClick: retry } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' })); });
    expect(screen.getByRole('alert', { name: 'Could not complete that action' })).toHaveTextContent('Please try again from the original control.');
    expect(screen.getByRole('alert', { name: 'Microphone release is not confirmed' })).toBeVisible();
    expect(document.body).not.toHaveTextContent(/Private|provider|credentials|Error:/);
    advance(60000);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('ignores pending action failures after dismissAll, even if the store was empty', async () => {
    const pending = deferred();
    render(<ToastViewport />);
    act(() => notify({ ...saved, action: { label: 'Review', onClick: () => pending.promise } }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(dismissAll);
    await act(async () => pending.reject(new Error('Private diagnostic')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('toast modal hosts', () => {
  it('restores stacked hosts through duplicate and out-of-order unregister calls', () => {
    render(<><div data-testid="first-host" /><div data-testid="second-host" /><ToastViewport /></>);
    act(() => notify({ ...saved, duration: null }));
    const first = screen.getByTestId('first-host');
    const second = screen.getByTestId('second-host');
    const releases: (() => void)[] = [];
    const viewport = () => screen.getByRole('complementary', { name: 'Notifications' });
    try {
      act(() => { releases.push(registerToastHost(first)); });
      expect(viewport().parentElement).toBe(first);
      act(() => { releases.push(registerToastHost(second)); });
      expect(viewport().parentElement).toBe(second);
      act(() => { releases.push(registerToastHost(first)); });
      expect(viewport().parentElement).toBe(first);
      act(() => releases[0]());
      expect(viewport().parentElement).toBe(first);
      act(() => releases[2]());
      expect(viewport().parentElement).toBe(second);
      act(dismissAll);
      act(() => notify({ ...saved, duration: null }));
      expect(viewport().parentElement).toBe(second);
      act(() => releases[1]());
      expect(viewport().parentElement).toBe(document.body);
      act(() => releases[1]());
      expect(viewport().parentElement).toBe(document.body);
    } finally {
      act(() => { for (const release of releases) release(); });
    }
  });

  it('portals existing and arriving notices through nested dialogs without resetting time', () => {
    /** Provides nested dialog controls for testing toast host changes and focus behavior. */
    function Dialogs() {
      const [figures, setFigures] = useState(false);
      const [help, setHelp] = useState(false);
      return <><button type="button" onClick={() => setFigures(true)}>Open figures</button>
        <Dialog open={figures} title="Figures" onClose={() => setFigures(false)}>
          <button type="button" onClick={() => setHelp(true)}>Open help</button>
          <Dialog open={help} title="Help" onClose={() => setHelp(false)}>Check the reported figures.</Dialog>
        </Dialog><ToastViewport /></>;
    }
    render(<StrictMode><Dialogs /></StrictMode>);
    const trigger = screen.getByRole('button', { name: 'Open figures' });
    act(() => trigger.focus());
    act(() => notify({ ...saved, duration: 1000 }));
    advance(200);
    fireEvent.click(trigger);
    const figures = screen.getByRole('dialog', { name: 'Figures' });
    expect(screen.getByRole('complementary', { name: 'Notifications' }).parentElement).toBe(figures);
    expect(within(figures).getByRole('heading', { name: 'Figures' })).toHaveFocus();
    act(() => notify({ id: 'check', title: 'Check the date', severity: 'warning', duration: null }));
    expect(within(figures).getByRole('status', { name: 'Check the date' })).toBeVisible();
    expect(within(figures).getByRole('heading', { name: 'Figures' })).toHaveFocus();
    advance(200);
    fireEvent.click(screen.getByRole('button', { name: 'Open help' }));
    const help = screen.getByRole('dialog', { name: 'Help' });
    expect(screen.getByRole('complementary', { name: 'Notifications' }).parentElement).toBe(help);
    advance(200);
    fireEvent.click(within(help).getByRole('button', { name: 'Close help' }));
    expect(screen.getByRole('complementary', { name: 'Notifications' }).parentElement).toBe(figures);
    advance(200);
    fireEvent.click(within(figures).getByRole('button', { name: 'Close figures' }));
    expect(screen.getByRole('complementary', { name: 'Notifications' }).parentElement).toBe(document.body);
    expect(trigger).toHaveFocus();
    expect(screen.getAllByRole('complementary', { name: 'Notifications' })).toHaveLength(1);
    advance(199);
    expect(screen.getByRole('status', { name: saved.title })).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status', { name: saved.title })).not.toBeInTheDocument();
  });

  it('includes portal controls in native Tab handling and leaves Escape to the dialog', () => {
    // jsdom supplies no layout or native modal keyboard behavior.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    const onClose = vi.fn();
    render(<><Dialog open title="Figures" onClose={onClose}><button type="button">Edit figures</button></Dialog><ToastViewport /></>);
    const notice: Notice = { ...saved, severity: 'error', action: { label: 'Review', onClick: vi.fn() } };
    act(() => notify(notice));
    const dialog = screen.getByRole('dialog', { name: 'Figures' });
    const close = within(dialog).getByRole('button', { name: 'Close figures' });
    const dismissButton = within(dialog).getByRole('button', { name: `Dismiss ${saved.title}` });
    act(() => dismissButton.focus());
    expect(fireEvent.keyDown(dismissButton, { key: 'Tab' })).toBe(false);
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(dismissButton).toHaveFocus();
    fireEvent.keyDown(dismissButton, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('button', { name: 'Review' })).toHaveFocus();
    act(() => notify({ ...notice, action: { label: 'Review', onClick: vi.fn(), disabled: true } }));
    act(() => dismissButton.focus());
    fireEvent.keyDown(dismissButton, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('list', { name: 'Notification list' })).toHaveFocus();
    expect(fireEvent.keyDown(dismissButton, { key: 'Escape' })).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert')).toBeVisible();
    expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(within(dialog).getByRole('alert')).toBeVisible();
    act(() => (dialog as HTMLDialogElement).close());
    expect(screen.getByRole('complementary', { name: 'Notifications' }).parentElement).toBe(document.body);
  });
});