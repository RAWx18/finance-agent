// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceOrb } from '../src/components/assistant-ui/elements/voice';
import type { VoiceOrbState } from '../src/components/assistant-ui/elements/voice';
import registry from '../src/components/assistant-ui/registry.json';
import source from '../src/components/assistant-ui/elements/voice.tsx?raw';
import license from '../src/components/assistant-ui/LICENSE.md?raw';

const frames = new Map<number, FrameRequestCallback>();

/** Flushes one scheduled animation frame inside React's test update boundary. */
function frame() {
  expect(frames.size).toBe(1);
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => { for (const callback of callbacks) callback(performance.now()); });
}

beforeEach(() => {
  frames.clear();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
});

describe('official assistant-ui voice orb', () => {
  it('preserves the pinned upstream renderer and MIT attribution apart from the documented integration and accessibility patch', () => {
    expect(registry.registry).toBe('https://r.assistant-ui.com/voice.json');
    expect(registry.renderer).toBe('https://r.assistant-ui.com/elements-voice.json');
    expect(registry.upstreamSha256).toBe('b6f8ec3a137d2dd2ecb5ec514f5fc9245de84f030e65ea1333c42ddb27da0a38');
    expect(source.split('\n').slice(0, 2)).toEqual([
      '// SPDX-FileCopyrightText: 2025 AgentbaseAI Inc.',
      '// SPDX-License-Identifier: MIT',
    ]);
    expect(source).toContain('import { clsx as cn } from "clsx";');
    let upstream = source.split('\n').slice(2).join('\n')
      .replace('import { clsx as cn } from "clsx";', 'import { cn } from "@/lib/utils";').trimEnd();
    for (const adaptation of registry.sourceAdaptations) {
      expect(upstream.split(adaptation.installed)).toHaveLength(2);
      upstream = upstream.replace(adaptation.installed, adaptation.upstream);
    }
    // The registry digest covers raw content; normalize only its optional final newline.
    expect([upstream, `${upstream}\n`].map(content => createHash('sha256').update(content).digest('hex')))
      .toContain(registry.upstreamSha256);
    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) 2025 AgentbaseAI Inc.');
    expect(license).toContain('Permission is hereby granted, free of charge');
    expect(license).toContain('The above copyright notice and this permission notice shall be included');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('retains a canvas for all five states without substituting SVG or scheduling draws when WebGL2 is unavailable', () => {
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const view = render(<VoiceOrb variant="emerald" />);
    const canvas = view.container.querySelector('canvas.aui-voice-orb');
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute('data-state', 'idle');
    frame();
    expect(context).toHaveBeenCalledExactlyOnceWith('webgl2', { alpha: true, premultipliedAlpha: false, antialias: true });
    expect(frames.size).toBe(0);
    for (const state of ['idle', 'connecting', 'listening', 'speaking', 'muted'] as const) {
      view.rerender(<VoiceOrb state={state} volume={0.5} variant="emerald" />);
      expect(view.container.querySelector('canvas.aui-voice-orb')).toBe(canvas);
      expect(canvas).toHaveAttribute('data-state', state);
      expect(view.container.querySelector('svg')).toBeNull();
      expect(view.container.children).toHaveLength(1);
      expect(frames.size).toBe(0);
    }
    expect(context).toHaveBeenCalledOnce();
    view.unmount();
    expect(frames.size).toBe(0);
  });

  it('submits official shaders, emerald uniforms and interpolated state and volume changes to WebGL2, then releases its animation and context', () => {
    let reduced = false;
    const media = new EventTarget();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ get matches() { return reduced; },
      addEventListener: media.addEventListener.bind(media), removeEventListener: media.removeEventListener.bind(media) })));
    const loseContext = vi.fn();
    const gl = {
      VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
      ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, FLOAT: 5126, BLEND: 3042,
      SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771, COLOR_BUFFER_BIT: 16384, TRIANGLE_STRIP: 5,
      createShader: vi.fn((type: number) => ({ type })), shaderSource: vi.fn(), compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
      createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true), useProgram: vi.fn(),
      createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(),
      getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
      enable: vi.fn(), blendFunc: vi.fn(), getUniformLocation: vi.fn((_program: object, name: string) => name),
      viewport: vi.fn(), clearColor: vi.fn(), clear: vi.fn(), uniform1f: vi.fn(), uniform3fv: vi.fn(), drawArrays: vi.fn(),
      getExtension: vi.fn(() => ({ loseContext })),
    };
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as unknown as WebGL2RenderingContext);
    const view = render(<VoiceOrb state="idle" volume={0} variant="emerald" />);
    const canvas = view.container.querySelector('canvas.aui-voice-orb');
    expect(gl.drawArrays).not.toHaveBeenCalled();
    frame();
    expect(context).toHaveBeenCalledExactlyOnceWith('webgl2', { alpha: true, premultipliedAlpha: false, antialias: true });
    expect(gl.createShader.mock.calls).toEqual([[gl.VERTEX_SHADER], [gl.FRAGMENT_SHADER]]);
    expect(gl.shaderSource).toHaveBeenCalledWith({ type: gl.VERTEX_SHADER }, expect.stringContaining('#version 300 es\nin vec2 a_position;'));
    expect(gl.shaderSource).toHaveBeenCalledWith({ type: gl.FRAGMENT_SHADER }, expect.stringContaining('uniform vec3 u_color0;'));
    expect(gl.compileShader).toHaveBeenCalledTimes(2);
    expect(gl.linkProgram).toHaveBeenCalledOnce();
    expect(gl.useProgram).toHaveBeenCalledWith(gl.createProgram.mock.results[0].value);
    expect(gl.bufferData).toHaveBeenCalledWith(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    expect(gl.getUniformLocation.mock.calls.map(([, name]) => name)).toEqual([
      'u_time', 'u_speed', 'u_amplitude', 'u_glow', 'u_brightness', 'u_pulse', 'u_saturation',
      'u_color0', 'u_color1', 'u_color2', 'u_dpr',
    ]);
    expect(gl.drawArrays).not.toHaveBeenCalled();
    frame();
    expect(gl.drawArrays).toHaveBeenCalledExactlyOnceWith(gl.TRIANGLE_STRIP, 0, 4);
    expect(gl.uniform3fv.mock.calls).toEqual([
      ['u_color0', [0.15, 0.75, 0.55]], ['u_color1', [0.3, 0.9, 0.7]], ['u_color2', [0.1, 0.55, 0.4]],
    ]);
    expect(gl.uniform1f).toHaveBeenCalledWith('u_speed', 0.15);
    expect(gl.uniform1f).toHaveBeenCalledWith('u_amplitude', 0.04);
    expect(gl.uniform1f).toHaveBeenCalledWith('u_glow', 0.15);
    gl.uniform1f.mockClear();
    view.rerender(<VoiceOrb state="idle" volume={0.5} variant="emerald" />);
    expect(gl.uniform1f).not.toHaveBeenCalled();
    frame();
    expect(gl.uniform1f).toHaveBeenCalledWith('u_speed', expect.closeTo(0.35, 10));
    expect(gl.uniform1f).toHaveBeenCalledWith('u_amplitude', expect.closeTo(0.1, 10));
    expect(gl.uniform1f).toHaveBeenCalledWith('u_glow', expect.closeTo(0.25, 10));
    expect(gl.uniform1f).toHaveBeenCalledWith('u_brightness', 0.55);

    const presets: { state: VoiceOrbState; params: number[] }[] = [
      { state: 'connecting', params: [0.5, 0.1, 0.45, 0.75, 1, 0.9] },
      { state: 'listening', params: [0.4, 0.14, 0.5, 0.85, 0, 1] },
      { state: 'speaking', params: [1.4, 0.35, 0.9, 1, 0, 1] },
      { state: 'muted', params: [0.06, 0.015, 0.08, 0.35, 0, 0.2] },
      { state: 'idle', params: [0.15, 0.04, 0.15, 0.55, 0, 0.7] },
    ];
    let params = [0.15, 0.04, 0.15, 0.55, 0, 0.7];
    for (const preset of presets) {
      view.rerender(<VoiceOrb state={preset.state} volume={0} variant="emerald" />);
      expect(view.container.querySelector('canvas.aui-voice-orb')).toBe(canvas);
      expect(canvas).toHaveAttribute('data-state', preset.state);
      gl.uniform1f.mockClear();
      frame();
      params = params.map((value, index) => value + (preset.params[index] - value) * 0.045);
      ['u_speed', 'u_amplitude', 'u_glow', 'u_brightness', 'u_pulse', 'u_saturation'].forEach((name, index) => {
        expect(gl.uniform1f).toHaveBeenCalledWith(name, expect.closeTo(params[index], 10));
      });
    }
    expect(context).toHaveBeenCalledOnce();
    expect(gl.drawArrays).toHaveBeenCalledTimes(7);
    expect(view.container.querySelector('svg')).toBeNull();
    reduced = true;
    act(() => media.dispatchEvent(new Event('change')));
    gl.uniform1f.mockClear();
    frame();
    expect(gl.uniform1f).toHaveBeenCalledWith('u_time', 0);
    expect(frames.size).toBe(0);
    view.rerender(<VoiceOrb state="idle" volume={1} variant="emerald" />);
    expect(frames.size).toBe(0);
    view.rerender(<VoiceOrb state="speaking" volume={1} variant="emerald" />);
    gl.uniform1f.mockClear();
    frame();
    expect(gl.uniform1f).toHaveBeenCalledWith('u_time', 0);
    expect(gl.uniform1f).toHaveBeenCalledWith('u_speed', 1.4);
    expect(gl.uniform1f).toHaveBeenCalledWith('u_amplitude', .35);
    expect(frames.size).toBe(0);
    act(() => window.dispatchEvent(new Event('resize')));
    frame();
    expect(frames.size).toBe(0);
    reduced = false;
    act(() => media.dispatchEvent(new Event('change')));
    frame();
    expect(frames.size).toBe(1);
    expect(context).toHaveBeenCalledOnce();
    expect(view.container.querySelector('canvas.aui-voice-orb')).toBe(canvas);
    const pending = [...frames.keys()][0];
    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pending);
    expect(gl.getExtension).toHaveBeenCalledExactlyOnceWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});