// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceCircle } from '../src/VoiceCircle';
import type { VoiceState } from '../src/VoiceCircle';

const motion: Record<VoiceState, string> = {
  idle: 'none', connecting: 'orbit', listening: 'none', userSpeaking: 'none', assistantSpeaking: 'none',
  processing: 'breath', interrupted: 'none', reconnecting: 'orbit', muted: 'none', paused: 'none',
  unavailable: 'unavailable', disconnected: 'disconnected', ended: 'none', ending: 'settle',
};
const states = Object.keys(motion) as VoiceState[];
const speaking = ['userSpeaking', 'assistantSpeaking', 'interrupted'] as const;

function geometry(circle: HTMLElement, mode = 'live') {
  const shape = circle.querySelector<SVGGElement>(`.voice-circle-${mode}`)!;
  return { transform: shape.getAttribute('transform'), paths: Array.from(shape.querySelectorAll('path'), path => path.getAttribute('d')) };
}

afterEach(() => vi.useRealTimers());

describe('VoiceCircle', () => {
  it('exposes one named image without duplicating status text or entering keyboard navigation', async () => {
    const { rerender } = render(<>
      <button>Start talking</button>
      <VoiceCircle state="listening" level={0} label="Listening" />
      <button>End conversation</button>
    </>);
    const circle = screen.getByRole('img', { name: 'Listening' });
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(circle).not.toHaveAttribute('tabindex');
    expect(circle).not.toHaveAttribute('aria-live');
    expect(circle.textContent).toBe('');
    expect(circle.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(circle.querySelector('svg')).toHaveAttribute('focusable', 'false');
    expect(circle.querySelector('button, a, input, audio, video, [tabindex], [aria-live]')).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Start talking' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'End conversation' })).toHaveFocus();
    rerender(<>
      <button>Start talking</button>
      <VoiceCircle state="userSpeaking" level={.4} label="Listening to you" />
      <button>End conversation</button>
    </>);
    expect(screen.getByRole('img', { name: 'Listening to you' })).toBe(circle);
    expect(screen.getByRole('button', { name: 'End conversation' })).toHaveFocus();
  });

  it.each(['listening', ...speaking] as const)('keeps %s still at zero until a level is delivered', state => {
    vi.useFakeTimers();
    const { rerender } = render(<VoiceCircle state={state} level={0} label="Quiet" />);
    const circle = screen.getByRole('img');
    const quiet = geometry(circle);
    expect(circle).toHaveAttribute('data-energy', '0');
    expect(circle).toHaveAttribute('data-motion', 'none');
    expect(circle).toHaveClass('voice-circle', { exact: true });
    expect(quiet.transform).toBe('rotate(0 80 80)');
    expect(circle.querySelector('animate, animateTransform, animateMotion')).toBeNull();
    act(() => vi.advanceTimersByTime(30_000));
    rerender(<VoiceCircle state={state} level={0} label="Still quiet" />);
    expect(geometry(circle)).toEqual(quiet);
  });

  it.each(speaking)('responds directly to %s levels and resets to the same quiet shape', state => {
    const { rerender } = render(<VoiceCircle state={state} level={0} label="Voice" />);
    const circle = screen.getByRole('img');
    const quiet = geometry(circle);
    rerender(<VoiceCircle state={state} level={.35} label="Voice" />);
    const soft = geometry(circle);
    expect(circle).toHaveAttribute('data-energy', '0.35');
    expect(soft.transform).not.toBe(quiet.transform);
    soft.paths.forEach((path, index) => expect(path).not.toBe(quiet.paths[index]));
    rerender(<VoiceCircle state={state} level={1} label="Voice" />);
    geometry(circle).paths.forEach((path, index) => expect(path).not.toBe(soft.paths[index]));
    rerender(<VoiceCircle state={state} level={.35} label="Voice" />);
    expect(geometry(circle)).toEqual(soft);
    rerender(<VoiceCircle state={state} level={0} label="Voice" />);
    expect(circle).toHaveAttribute('data-energy', '0');
    expect(geometry(circle)).toEqual(quiet);
  });

  it('distinguishes assistant geometry and two outlined rings from the user shape even at silence', () => {
    const { rerender } = render(<VoiceCircle state="userSpeaking" level={0} label="You" />);
    const circle = screen.getByRole('img');
    const user = geometry(circle);
    expect(circle.querySelector('.voice-circle-live .voice-circle-shell')).toHaveAttribute('fill', 'currentColor');
    rerender(<VoiceCircle state="assistantSpeaking" level={0} label="Assistant" />);
    expect(circle).toHaveAttribute('data-state', 'assistantSpeaking');
    geometry(circle).paths.forEach((path, index) => expect(path).not.toBe(user.paths[index]));
    expect(circle.querySelectorAll('.voice-circle-live path[fill="none"]')).toHaveLength(2);
    expect(circle.querySelector('.voice-circle-live .voice-circle-core')).toHaveAttribute('fill', 'currentColor');
  });

  it.each(states.filter(state => !speaking.some(value => value === state)))('suppresses levels in %s, including when leaving speech', state => {
    const { rerender } = render(<VoiceCircle state="userSpeaking" level={1} label="Speaking" />);
    const circle = screen.getByRole('img');
    rerender(<VoiceCircle state={state} level={1} label={state} />);
    const quiet = geometry(circle);
    expect(circle).toHaveAttribute('data-energy', '0');
    expect(quiet.transform).toBe('rotate(0 80 80)');
    for (const level of [0, .7, Number.NaN, Number.MAX_VALUE]) {
      rerender(<VoiceCircle state={state} level={level} label={state} />);
      expect(circle).toHaveAttribute('data-energy', '0');
      expect(geometry(circle)).toEqual(quiet);
    }
  });

  it.each([
    { level: 0, expected: 0 }, { level: .375, expected: .375 }, { level: 1, expected: 1 },
    { level: -.5, expected: 0 }, { level: 1.5, expected: 1 }, { level: Number.MAX_VALUE, expected: 1 },
    { level: Number.NaN, expected: 0 }, { level: Infinity, expected: 0 }, { level: -Infinity, expected: 0 },
    { level: undefined as unknown as number, expected: 0 },
  ])('normalizes $level to $expected without invalid geometry', ({ level, expected }) => {
    const { rerender } = render(<VoiceCircle state="userSpeaking" level={level} label="You" />);
    const circle = screen.getByRole('img');
    const shape = geometry(circle);
    expect(circle).toHaveAttribute('data-energy', String(expected));
    shape.paths.forEach(path => expect(path).not.toMatch(/NaN|Infinity|undefined/));
    rerender(<VoiceCircle state="userSpeaking" level={expected} label="You" />);
    expect(geometry(circle)).toEqual(shape);
  });

  it.each(speaking)('keeps %s deformation proportional and within eight percent of each loop radius', state => {
    const { rerender } = render(<VoiceCircle state={state} level={0} label="Voice" />);
    const circle = screen.getByRole('img');
    const paths = Array.from(circle.querySelectorAll('.voice-circle-live path'));
    const quiet = paths.map(path => path.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number));
    for (const level of [.25, .5, 1]) {
      rerender(<VoiceCircle state={state} level={level} label="Voice" />);
      paths.forEach((path, index) => {
        const coordinates = path.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        const radius = Math.max(...quiet[index].map(value => Math.abs(value - 80)));
        expect(coordinates).toHaveLength(quiet[index].length);
        coordinates.forEach((value, coordinate) => {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThan(160);
          expect(Math.abs(value - quiet[index][coordinate])).toBeLessThanOrEqual(radius * .08 * level);
        });
      });
      const rotation = Number(geometry(circle).transform!.match(/-?\d+(?:\.\d+)?/)![0]);
      expect(Math.abs(rotation)).toBeLessThanOrEqual(5 * level);
    }
  });

  it.each(speaking)('provides fixed reduced-motion geometry throughout %s level changes', state => {
    const { rerender } = render(<VoiceCircle state={state} level={0} label="Voice" />);
    const circle = screen.getByRole('img');
    const still = geometry(circle, 'still');
    expect(still).toEqual(geometry(circle));
    for (const level of [.2, 1, .6, 0]) {
      rerender(<VoiceCircle state={state} level={level} label="Voice" />);
      expect(geometry(circle, 'still')).toEqual(still);
      if (level > 0) expect(geometry(circle)).not.toEqual(still);
    }
  });

  it.each(states)('selects only the state-authorized CSS activity for %s', state => {
    const { rerender } = render(<VoiceCircle state={state} level={1} label={state} />);
    const circle = screen.getByRole('img');
    expect(circle).toHaveAttribute('data-state', state);
    expect(circle).toHaveAttribute('data-motion', motion[state]);
    rerender(<VoiceCircle state="listening" level={1} label="Listening" />);
    expect(circle).toHaveAttribute('data-motion', 'none');
    expect(circle).toHaveAttribute('data-energy', '0');
    expect(circle).toHaveClass('voice-circle', { exact: true });
  });

  it('uses distinct static marks for muted, paused, unavailable, disconnected and ended states', () => {
    const { rerender } = render(<VoiceCircle state="muted" level={0} label="Muted" />);
    const circle = screen.getByRole('img');
    const marks = new Set<string>();
    for (const state of ['muted', 'paused', 'unavailable', 'disconnected', 'ended'] as const) {
      rerender(<VoiceCircle state={state} level={1} label={state} />);
      const mark = circle.querySelector('.voice-circle-mark')!.getAttribute('d')!;
      expect(mark).not.toBe('');
      marks.add(mark);
    }
    expect(marks.size).toBe(5);
  });

  it('preserves SVG dimensions and every node while states and levels change without inline styles', () => {
    const { rerender } = render(<VoiceCircle state="idle" level={0} label="Ready" />);
    const circle = screen.getByRole('img');
    const svg = circle.querySelector('svg');
    const nodes = Array.from(circle.querySelectorAll('*'));
    for (const state of states) {
      for (const level of [0, 1]) {
        rerender(<VoiceCircle state={state} level={level} label={state} />);
        expect(screen.getByRole('img', { name: state })).toBe(circle);
        expect(circle.querySelector('svg')).toBe(svg);
        expect(svg).toHaveAttribute('viewBox', '0 0 160 160');
        expect(svg).toHaveAttribute('width', '160');
        expect(svg).toHaveAttribute('height', '160');
        expect(circle).not.toHaveAttribute('style');
        expect(circle.querySelector('[style]')).toBeNull();
        expect(circle.querySelectorAll('*')).toHaveLength(nodes.length);
        nodes.forEach((node, index) => expect(circle.querySelectorAll('*')[index]).toBe(node));
      }
    }
  });
});