// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Captions } from '../src/Captions';
import type { Caption } from '../src/Captions';

function words(id: number, patch: Partial<Caption> = {}): Caption {
  return { id: String(id), speaker: 'You', text: `Words ${id}`, time: Date.parse('2026-09-11T04:00:00Z') + id * 1000, ...patch };
}

function geometry(element: HTMLElement, height: number, top: number) {
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: height }, clientHeight: { configurable: true, value: 100 } });
  element.scrollTop = top;
}

describe('caption presentation', () => {
  it('keeps a truthful empty current surface and a keyboard-accessible history mounted', () => {
    const view = render(<Captions captions={[]} timezone="UTC" />);
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Captions appear as you speak')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Caption history' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Earlier captions' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('list', { name: 'Conversation transcript' })).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(view.container.querySelector('details, dialog, time, [aria-live="assertive"]')).toBeNull();
  });

  it.each([
    ['UTC', '18:30:05', '11 September 2026'],
    ['Asia/Kolkata', '00:00:05', '12 September 2026'],
  ])('formats 24-hour seconds and full date context in %s', (timezone, clock, date) => {
    const time = Date.parse('2026-09-11T18:30:05Z');
    render(<Captions captions={[words(1, { time })]} timezone={timezone} />);
    const stamp = screen.getByText(clock);
    expect(stamp.tagName).toBe('TIME');
    expect(stamp).toHaveAttribute('datetime', '2026-09-11T18:30:05.000Z');
    expect(stamp.getAttribute('title')).toContain(date);
    expect(stamp.getAttribute('title')).toContain(timezone);
    expect(stamp).toHaveAttribute('aria-label', stamp.getAttribute('title'));
  });

  it('sorts chronologically without altering timestamps, equal-time order or caller data', () => {
    const captions = [words(3), words(2, { time: words(1).time }), words(1), words(4)];
    render(<Captions captions={captions} timezone="UTC" />);
    const history = within(screen.getByRole('list', { name: 'Conversation transcript' }));
    expect(history.getAllByRole('listitem').map(item => item.querySelector('p')!.textContent)).toEqual(['Words 2', 'Words 1', 'Words 3']);
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Words 4')).toBeVisible();
    expect(history.queryByText('Words 4')).not.toBeInTheDocument();
    expect(screen.getAllByText('Words 4')).toHaveLength(1);
    expect(captions.map(item => item.id)).toEqual(['3', '2', '1', '4']);
    expect(history.getAllByText('04:00:01')).toHaveLength(2);
  });

  it('keeps the latest received caption live even when its server time precedes earlier receipts', () => {
    const view = render(<Captions captions={[words(4), words(2), words(3), words(1)]} timezone="UTC" />);
    const live = screen.getByRole('region', { name: 'Live caption' });
    const history = screen.getByRole('list', { name: 'Conversation transcript' });
    expect(within(live).getByText('Words 1')).toBeVisible();
    expect(within(live).getByText('04:00:01')).toBeVisible();
    expect(within(history).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent)).toEqual(['Words 2', 'Words 3', 'Words 4']);
    view.rerender(<Captions captions={[words(4, { text: 'Corrected words' }), words(2), words(3), words(1)]} timezone="UTC" />);
    expect(within(live).getByText('Words 1')).toBeVisible();
    expect(within(history).getByText('Corrected words')).toBeVisible();
    expect(screen.getAllByText('Words 1')).toHaveLength(1);
  });

  it.each([NaN, Infinity, -Infinity, 8.64e15 + 1])('omits an invalid timestamp without losing caption text: %s', (time) => {
    const view = render(<Captions captions={[words(1, { time }), words(2, { time })]} timezone="UTC" />);
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Words 2')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Conversation transcript' })).getByText('Words 1')).toBeVisible();
    expect(view.container.querySelector('time')).toBeNull();
  });

  it('keeps the current spoken prefix separate and moves it to history when a later caption arrives', () => {
    const spoken = words(2, { speaker: 'Assistant', text: 'Check the bill', pending: true });
    const view = render(<Captions captions={[words(1), spoken]} timezone="UTC" />);
    const live = screen.getByRole('region', { name: 'Live caption' });
    const history = screen.getByRole('list', { name: 'Conversation transcript' });
    const stamp = within(live).getByText('04:00:02');
    expect(within(live).getByText('Assistant · spoken so far')).toBeVisible();
    expect(within(history).queryByText(spoken.text)).not.toBeInTheDocument();
    view.rerender(<Captions captions={[words(1), { ...spoken, text: 'Check the bill first' }]} timezone="UTC" />);
    expect(within(live).getByText('04:00:02')).toBe(stamp);
    expect(screen.getAllByText('Check the bill first')).toHaveLength(1);
    view.rerender(<Captions captions={[words(1), { ...spoken, pending: false, interrupted: true }, words(3)]} timezone="UTC" />);
    expect(within(history).getByText('Assistant · interrupted')).toBeVisible();
    expect(within(history).getByText('Check the bill')).toBeVisible();
    expect(within(live).getByText('Words 3')).toBeVisible();
  });

  it('retains all earlier spoken prefixes while interim words are live', () => {
    const captions = [words(1, { speaker: 'Assistant', pending: true }), words(2, { speaker: 'Assistant', interrupted: true }), words(3)];
    const view = render(<Captions captions={captions} interim={{ text: 'Please wait', time: words(4).time }} timezone="UTC" />);
    const history = screen.getByRole('list', { name: 'Conversation transcript' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(3);
    expect(within(history).getByText('Assistant · spoken so far')).toBeVisible();
    expect(within(history).getByText('Assistant · interrupted')).toBeVisible();
    expect(screen.getAllByText('Words 1')).toHaveLength(1);
    view.rerender(<Captions captions={captions} timezone="UTC" />);
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(within(history).getByText('Words 1')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Words 3')).toBeVisible();
  });

  it('labels an interrupted current prefix without suggesting it is still being spoken', () => {
    render(<Captions captions={[words(1, { speaker: 'Assistant', text: 'Check the bill', pending: false, interrupted: true })]} />);
    const live = within(screen.getByRole('region', { name: 'Live caption' }));
    expect(live.getByRole('heading', { name: 'Assistant · interrupted' })).toBeVisible();
    expect(live.getByText('Check the bill')).toBeVisible();
    expect(screen.queryByText(/spoken so far/)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Conversation transcript' })).toBeEmptyDOMElement();
  });

  it('shows interim words only in the current surface without hiding any finalized history', () => {
    render(<Captions captions={[words(1), words(2)]} interim={{ text: 'Still talking', time: words(3).time }} timezone="UTC" />);
    const history = within(screen.getByRole('list', { name: 'Conversation transcript' }));
    expect(history.getAllByRole('listitem')).toHaveLength(2);
    expect(history.queryByText('Still talking')).not.toBeInTheDocument();
    const live = within(screen.getByRole('region', { name: 'Live caption' }));
    expect(live.getByText('You · still being transcribed')).toBeVisible();
    expect(live.getByText('04:00:03')).toBeVisible();
  });

  it('retains all earlier captions in one scroll region without pagination or a dialog', () => {
    render(<Captions captions={Array.from({ length: 120 }, (_, index) => words(index))} timezone="UTC" />);
    const history = within(screen.getByRole('region', { name: 'Earlier captions' }));
    expect(history.getAllByRole('listitem')).toHaveLength(119);
    expect(history.getByText('Words 0')).toBeVisible();
    expect(history.getByText('Words 118')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Live caption' })).getByText('Words 119')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next|Previous|Conversation history/ })).not.toBeInTheDocument();
  });

  it('renders transcript text as text, including markup characters', () => {
    const text = '<strong>Only spoken text</strong>';
    const view = render(<Captions captions={[words(1, { text })]} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(view.container.querySelector('.live-caption p strong')).toBeNull();
  });
});

describe('independent history scrolling', () => {
  it('follows new words only within the history and preserves focus elsewhere', () => {
    const jump = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const page = vi.spyOn(window, 'scrollTo');
    const view = render(<><button>End conversation</button><Captions captions={[words(1), words(2)]} /></>);
    const scroll = screen.getByRole('region', { name: 'Earlier captions' });
    geometry(scroll, 400, 300); fireEvent.scroll(scroll);
    const end = screen.getByRole('button', { name: 'End conversation' }); end.focus();
    geometry(scroll, 500, 300);
    view.rerender(<><button>End conversation</button><Captions captions={[words(1), words(2), words(3)]} /></>);
    expect(scroll.scrollTop).toBe(400);
    expect(end).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Latest captions' })).not.toBeInTheDocument();
    expect(jump).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled();
  });

  it.each([24, 25])('uses a 24-pixel bottom threshold when the gap is %s pixels', (gap) => {
    const view = render(<Captions captions={[words(1), words(2)]} />);
    const scroll = screen.getByRole('region', { name: 'Earlier captions' });
    geometry(scroll, 400, 300 - gap); fireEvent.scroll(scroll);
    geometry(scroll, 500, 300 - gap);
    view.rerender(<Captions captions={[words(1), words(2), words(3)]} />);
    expect(scroll.scrollTop).toBe(gap === 24 ? 400 : 275);
    if (gap === 25) expect(screen.getByRole('button', { name: 'Latest captions' })).toBeVisible();
    else expect(screen.queryByRole('button', { name: 'Latest captions' })).not.toBeInTheDocument();
  });

  it('preserves manual reading and resumes following only on request without taking focus', async () => {
    const jump = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const view = render(<><button>End conversation</button><Captions captions={[words(1), words(2)]} /></>);
    const scroll = screen.getByRole('region', { name: 'Earlier captions' });
    geometry(scroll, 500, 120); fireEvent.scroll(scroll);
    const end = screen.getByRole('button', { name: 'End conversation' }); end.focus();
    geometry(scroll, 600, 120);
    view.rerender(<><button>End conversation</button><Captions captions={[words(1), words(2), words(3)]} /></>);
    expect(scroll.scrollTop).toBe(120); expect(end).toHaveFocus();
    const latest = screen.getByRole('button', { name: 'Latest captions' });
    await userEvent.click(latest);
    expect(scroll.scrollTop).toBe(500); expect(latest).toHaveFocus();
    geometry(scroll, 700, 500);
    view.rerender(<><button>End conversation</button><Captions captions={[words(1), words(2), words(3), words(4)]} /></>);
    expect(scroll.scrollTop).toBe(600); expect(latest).toHaveFocus();
    act(() => end.focus());
    expect(screen.queryByRole('button', { name: 'Latest captions' })).not.toBeInTheDocument();
    expect(jump).not.toHaveBeenCalled();
  });

  it('does not move history being read with the keyboard, even when it was at the bottom', () => {
    const view = render(<><button>End conversation</button><Captions captions={[words(1), words(2)]} /></>);
    const scroll = screen.getByRole('region', { name: 'Earlier captions' });
    geometry(scroll, 400, 300); fireEvent.scroll(scroll); scroll.focus();
    geometry(scroll, 500, 300);
    view.rerender(<><button>End conversation</button><Captions captions={[words(1), words(2), words(3)]} /></>);
    expect(scroll.scrollTop).toBe(300); expect(scroll).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Latest captions' })).toBeVisible();
    screen.getByRole('button', { name: 'End conversation' }).focus();
    geometry(scroll, 600, 300);
    view.rerender(<><button>End conversation</button><Captions captions={[words(1), words(2), words(3), words(4)]} /></>);
    expect(scroll.scrollTop).toBe(300);
  });

  it('preserves selected history text even when keyboard focus is outside the scroll region', () => {
    const view = render(<><button>End conversation</button><Captions captions={[words(1), words(2)]} /></>);
    const scroll = screen.getByRole('region', { name: 'Earlier captions' });
    geometry(scroll, 400, 300); fireEvent.scroll(scroll);
    const end = screen.getByRole('button', { name: 'End conversation' }); end.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(within(scroll).getByText('Words 1'));
    selection.removeAllRanges(); selection.addRange(range);
    try {
      geometry(scroll, 500, 300);
      view.rerender(<><button>End conversation</button><Captions captions={[words(1), words(2), words(3)]} /></>);
      expect(scroll.scrollTop).toBe(300); expect(end).toHaveFocus();
      expect(selection.toString()).toBe('Words 1');
      expect(screen.getByRole('button', { name: 'Latest captions' })).toBeVisible();
    } finally { selection.removeAllRanges(); }
  });

  it('offers the latest captions for new interim words and clears reading state for a fresh call', () => {
    const view = render(<Captions captions={[words(1), words(2)]} />);
    const scroll = screen.getByRole('region', { name: 'Earlier captions' });
    geometry(scroll, 500, 100); fireEvent.scroll(scroll);
    view.rerender(<Captions captions={[words(1), words(2)]} interim={{ text: 'More words', time: words(3).time }} />);
    expect(scroll.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: 'Latest captions' })).toBeVisible();
    view.rerender(<Captions captions={[]} interim={null} />);
    expect(scroll.scrollTop).toBe(0);
    expect(screen.getByRole('list', { name: 'Conversation transcript' })).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Latest captions' })).not.toBeInTheDocument();
    expect(screen.getByText('Captions appear as you speak')).toBeVisible();
    view.rerender(<Captions captions={[words(4), words(5)]} />);
    expect(scroll.scrollTop).toBe(400);
  });
});