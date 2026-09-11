// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { DeviceArray, DeviceErrorType, Participant, PipecatClientOptions, Tracks } from '@pipecat-ai/client-js';

// Only the in-memory browser-test build aliases providers here; this is not speech acceptance.
export const RTVIEvent = { TrackStarted: 'trackStarted', TrackStopped: 'trackStopped' } as const;

export class DeviceError extends Error {
  constructor(public devices: DeviceArray, public type: DeviceErrorType, message?: string) { super(message); }
}

export interface VoiceFixture {
  clients: PipecatClient[];
  tracks: MediaStreamTrack[];
  destroyed: number;
  connectError: boolean;
}

declare global {
  interface Window { voiceFixture: VoiceFixture }
}

window.voiceFixture = { clients: [], tracks: [], destroyed: 0, connectError: false };

export class DailyTransport {
  dailyCallClient = { destroy: () => { window.voiceFixture.destroyed += 1; throw new Error('Calls to destroy() are disabled.'); } };
}

export class PipecatClient {
  readonly callbacks: NonNullable<PipecatClientOptions['callbacks']>;
  readonly connections: { url: string; token: string }[] = [];
  disconnects = 0;
  isMicEnabled = true;
  private stream?: MediaStream;
  private listeners = new Map<string, (track: MediaStreamTrack, participant?: Participant) => void>();

  constructor(options: PipecatClientOptions) {
    this.callbacks = options.callbacks ?? {};
    window.voiceFixture.clients.push(this);
  }

  on(event: string, listener: (track: MediaStreamTrack, participant?: Participant) => void) {
    this.listeners.set(event, listener);
  }

  async initDevices() {
    // Chromium's fake-device launch flag supplies this capture; no human audio is recorded or sent.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const track of this.stream.getTracks()) {
      window.voiceFixture.tracks.push(track);
      this.listeners.get(RTVIEvent.TrackStarted)?.(track, { id: 'fixture-user', name: 'Test microphone', local: true });
    }
  }

  async connect(params: { url: string; token: string }) {
    if (params.url !== 'https://voice-fixture.invalid/room' || params.token !== 'synthetic-provider-double')
      throw new Error('Provider-double transport accepts only synthetic join data.');
    this.connections.push(params);
    if (window.voiceFixture.connectError) throw new Error('Synthetic connection failure');
    // Connection and BotReady callbacks are emitted explicitly by each test, not by this promise.
  }

  stopCapture() {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
      this.listeners.get(RTVIEvent.TrackStopped)?.(track, { id: 'fixture-user', name: 'Test microphone', local: true });
    }
    this.stream = undefined;
  }

  async disconnect() {
    this.disconnects += 1;
    this.stopCapture();
  }

  tracks(): Tracks { return { local: { audio: this.stream?.getAudioTracks()[0] } }; }

  enableMic(enabled: boolean) {
    this.isMicEnabled = enabled;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = enabled;
  }
}