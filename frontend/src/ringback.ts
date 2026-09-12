// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only

const tone = { frequencies: [400, 450], volume: 0.018, pulse: 0.4, gap: 0.2, cycle: 3, fade: 0.02 };

/** Play a local connecting tone and return its cleanup function. */
export function startRingback(): () => void {
  let context: AudioContext | undefined;
  let source: AudioBufferSourceNode | undefined;
  let started = false;
  let stopped = false;
  /** Silence the connecting tone and release its audio resources. */
  const stop = () => {
    if (stopped) return;
    stopped = true;
    source?.disconnect();
    if (started) source?.stop();
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  };
  try {
    context = new AudioContext();
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * tone.cycle), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) {
      const time = index / context.sampleRate;
      const pulse = time < tone.pulse ? time : time - tone.pulse - tone.gap;
      if (pulse < 0 || pulse >= tone.pulse) continue;
      const envelope = Math.min(1, pulse / tone.fade, (tone.pulse - pulse) / tone.fade);
      samples[index] = tone.volume * envelope * tone.frequencies.reduce(
        (value, frequency) => value + Math.sin(2 * Math.PI * frequency * time), 0);
    }
    source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(context.destination);
    source.start();
    started = true;
    void context.resume().catch(stop);
  } catch {
    // Optional local audio must never prevent connecting to the assistant.
    stop();
  }
  return stop;
}