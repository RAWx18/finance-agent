// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { startRingback } from '../src/ringback';

/** Installs an in-memory AudioContext double for inspecting ringback samples and cleanup calls. */
function audio() {
  const source = { buffer: null as AudioBuffer | null, loop: false, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const context = {
    sampleRate: 8000, state: 'running', destination: {},
    createBuffer: vi.fn((_channels: number, length: number, rate: number) => {
      const samples = new Float32Array(length);
      return { sampleRate: rate, duration: length / rate, getChannelData: () => samples };
    }),
    createBufferSource: vi.fn(() => source), resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
  };
  const create = vi.fn(function () { return context; });
  vi.stubGlobal('AudioContext', create);
  return { context, source, create };
}

describe('connecting ringback audio', () => {
  it('loops a quiet double ring with soft edges and a silent rest', () => {
    const { context, source } = audio();
    const stop = startRingback();
    const samples = source.buffer!.getChannelData(0);
    /** Measures peak absolute amplitude within a seconds-based window of the 8 kHz fixture. */
    const peak = (from: number, until: number) => samples.slice(from * 8000, until * 8000).reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
    expect(source.loop).toBe(true);
    expect(source.buffer!.duration).toBe(3);
    expect(peak(0.03, 0.37)).toBeGreaterThan(0.02);
    expect(peak(0.63, 0.97)).toBeGreaterThan(0.02);
    expect(peak(0.4, 0.6)).toBe(0);
    expect(peak(1, 3)).toBeLessThan(0.0000001);
    expect(peak(0, 3)).toBeLessThanOrEqual(0.036);
    expect(peak(0, 0.005)).toBeLessThan(0.009);
    expect(samples[0]).toBe(0);
    expect(source.connect).toHaveBeenCalledExactlyOnceWith(context.destination);
    expect(source.start).toHaveBeenCalledOnce(); expect(context.resume).toHaveBeenCalledOnce();
    stop();
    expect(source.disconnect).toHaveBeenCalledOnce(); expect(source.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    stop();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('cannot restart after cancellation while audio permission is pending', async () => {
    const { context, source } = audio();
    let resume!: () => void;
    context.resume.mockReturnValue(new Promise<void>(resolve => { resume = resolve; }));
    const stop = startRingback();
    stop();
    resume(); await Promise.resolve();
    expect(source.start).toHaveBeenCalledOnce(); expect(source.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
  });

  it('releases audio when the browser rejects playback without rejecting the connection', async () => {
    const { context, source } = audio();
    context.resume.mockRejectedValue(new DOMException('Playback blocked', 'NotAllowedError'));
    const stop = startRingback();
    await Promise.resolve();
    expect(source.stop).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
    expect(stop).not.toThrow();
  });

  it('remains optional when Web Audio is unavailable or setup fails', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(startRingback()).not.toThrow();
    const { context, source } = audio();
    context.createBuffer.mockImplementation(() => { throw new Error('Audio unavailable'); });
    expect(startRingback()).not.toThrow();
    expect(context.close).toHaveBeenCalledOnce(); expect(source.start).not.toHaveBeenCalled();
  });
});