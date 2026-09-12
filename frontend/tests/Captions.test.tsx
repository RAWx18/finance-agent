// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LiveCaption } from '../src/Captions';
import type { Caption } from '../src/Captions';

function words(id: number, patch: Partial<Caption> = {}): Caption {
  return { id: String(id), speaker: 'You', text: `Words ${id}`, time: Date.parse('2026-09-11T04:00:00Z') + id * 1000, ...patch };
}

describe('live caption presentation', () => {
  it('uses loaded identity without changing the caption, timestamp or user label', () => {
    const captions = [words(1, { speaker: 'Assistant', interrupted: true })];
    const view = render(<LiveCaption captions={captions} timezone="UTC" />);
    expect(screen.getByRole('heading', { name: 'Assistant · interrupted' })).toBeVisible();
    const stamp = screen.getByText('04:00:01');
    view.rerender(<LiveCaption captions={captions} timezone="UTC" assistantName="Maya" />);
    expect(screen.getByRole('heading', { name: 'Maya · interrupted' })).toBeVisible();
    expect(screen.getByText('Words 1')).toBeVisible();
    expect(screen.getByText('04:00:01')).toBe(stamp);
    view.rerender(<LiveCaption captions={captions} interim={{ text: 'Still talking', time: words(2).time }} assistantName="Maya" />);
    expect(screen.getByRole('heading', { name: 'You' })).toBeVisible();
  });

  it('keeps an empty keyboard-accessible current surface without history or controls', () => {
    const view = render(<LiveCaption captions={[]} timezone="UTC" />);
    const live = screen.getByRole('region', { name: 'Live caption' });
    expect(within(live).getByText('Captions appear here')).toBeVisible();
    expect(live).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(view.container.querySelector('details, dialog, time, [aria-live="assertive"]')).toBeNull();
  });

  it.each([
    ['UTC', '18:30:05', '11 September 2026'],
    ['Asia/Kolkata', '00:00:05', '12 September 2026'],
  ])('formats 24-hour seconds and full date context in %s', (timezone, clock, date) => {
    const time = Date.parse('2026-09-11T18:30:05Z');
    render(<LiveCaption captions={[words(1, { time })]} timezone={timezone} />);
    const stamp = screen.getByText(clock);
    expect(stamp.tagName).toBe('TIME');
    expect(stamp).toHaveAttribute('datetime', '2026-09-11T18:30:05.000Z');
    expect(stamp.getAttribute('title')).toContain(date);
    expect(stamp.getAttribute('title')).toContain(timezone);
    expect(stamp).toHaveAttribute('aria-label', stamp.getAttribute('title'));
  });

  it('keeps the latest received caption live even when its server time precedes earlier receipts', () => {
    const captions = [words(4), words(2), words(3), words(1)];
    const view = render(<LiveCaption captions={captions} timezone="UTC" />);
    const live = screen.getByRole('region', { name: 'Live caption' });
    expect(within(live).getByText('Words 1')).toBeVisible();
    expect(within(live).getByText('04:00:01')).toBeVisible();
    expect(screen.queryByText('Words 4')).not.toBeInTheDocument();
    view.rerender(<LiveCaption captions={[words(4, { text: 'Corrected words' }), words(2), words(3), words(1)]} timezone="UTC" />);
    expect(within(live).getByText('Words 1')).toBeVisible();
    expect(screen.queryByText('Corrected words')).not.toBeInTheDocument();
    expect(captions.map(item => item.id)).toEqual(['4', '2', '3', '1']);
  });

  it.each([NaN, Infinity, -Infinity, 8.64e15 + 1])('omits an invalid timestamp without losing caption text: %s', time => {
    const view = render(<LiveCaption captions={[words(1, { time }), words(2, { time })]} timezone="UTC" />);
    expect(screen.getByText('Words 2')).toBeVisible();
    expect(screen.queryByText('Words 1')).not.toBeInTheDocument();
    expect(view.container.querySelector('time')).toBeNull();
  });

  it('updates the spoken prefix without replacing its timestamp and shows only the latest receipt', () => {
    const spoken = words(2, { speaker: 'Assistant', text: 'Check the bill', pending: true });
    const view = render(<LiveCaption captions={[words(1), spoken]} timezone="UTC" />);
    const stamp = screen.getByText('04:00:02');
    expect(screen.getByRole('heading', { name: 'Assistant' })).toBeVisible();
    view.rerender(<LiveCaption captions={[words(1), { ...spoken, text: 'Check the bill first' }]} timezone="UTC" />);
    expect(screen.getByText('04:00:02')).toBe(stamp);
    expect(screen.getAllByText('Check the bill first')).toHaveLength(1);
    view.rerender(<LiveCaption captions={[words(1), { ...spoken, pending: false, interrupted: true }, words(3)]} timezone="UTC" />);
    expect(screen.getByText('Words 3')).toBeVisible();
    expect(screen.queryByText('Check the bill')).not.toBeInTheDocument();
  });

  it('labels an interrupted current prefix without suggesting it is still being spoken', () => {
    render(<LiveCaption captions={[words(1, { speaker: 'Assistant', text: 'Check the bill', pending: false, interrupted: true })]} />);
    expect(screen.getByRole('heading', { name: 'Assistant · interrupted' })).toBeVisible();
    expect(screen.getByText('Check the bill')).toBeVisible();
    expect(screen.queryByText(/spoken so far/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows interim words instead of finalized captions and restores the latest receipt when cleared', () => {
    const captions = [words(1), words(2)];
    const view = render(<LiveCaption captions={captions} interim={{ text: 'Still talking', time: words(3).time }} timezone="UTC" />);
    expect(screen.getByRole('heading', { name: 'You' })).toBeVisible();
    expect(screen.getByText('Still talking')).toBeVisible();
    expect(screen.getByText('04:00:03')).toBeVisible();
    expect(screen.queryByText('Words 2')).not.toBeInTheDocument();
    view.rerender(<LiveCaption captions={captions} interim={null} timezone="UTC" />);
    expect(screen.getByText('Words 2')).toBeVisible();
    expect(screen.queryByText('Still talking')).not.toBeInTheDocument();
    view.rerender(<LiveCaption captions={[]} interim={null} />);
    expect(screen.getByText('Captions appear here')).toBeVisible();
  });

  it('renders transcript text as text, including markup characters', () => {
    const text = '<strong>Only spoken text</strong>';
    const view = render(<LiveCaption captions={[words(1, { text })]} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(view.container.querySelector('.live-caption p strong')).toBeNull();
  });
});