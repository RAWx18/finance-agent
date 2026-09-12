// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { DeviceArray, DeviceErrorType, Participant, PipecatClientOptions, Tracks } from '@pipecat-ai/client-js';
import type { DailyEventObjectParticipant } from '@daily-co/daily-js';

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
  readonly participants = new Set<(event: DailyEventObjectParticipant) => void>();
  dailyCallClient = {
    on: (event: 'participant-updated', listener: (event: DailyEventObjectParticipant) => void) => {
      if (event === 'participant-updated') this.participants.add(listener);
      return this.dailyCallClient;
    },
    off: (event: 'participant-updated', listener: (event: DailyEventObjectParticipant) => void) => {
      if (event === 'participant-updated') this.participants.delete(listener);
      return this.dailyCallClient;
    },
    destroy: () => { window.voiceFixture.destroyed += 1; throw new Error('Calls to destroy() are disabled.'); },
  };
}

export class PipecatClient {
  readonly callbacks: NonNullable<PipecatClientOptions['callbacks']>;
  readonly connections: { url: string; token: string }[] = [];
  readonly messages: { type: string; data: unknown }[] = [];
  disconnects = 0;
  isMicEnabled = true;
  readonly transport: DailyTransport;
  private stream?: MediaStream;
  private listeners = new Map<string, (track: MediaStreamTrack, participant?: Participant) => void>();

  constructor(options: PipecatClientOptions) {
    this.callbacks = options.callbacks ?? {};
    this.transport = options.transport as unknown as DailyTransport;
    window.voiceFixture.clients.push(this);
  }

  on(event: string, listener: (track: MediaStreamTrack, participant?: Participant) => void) {
    this.listeners.set(event, listener);
  }

  emitTrack(track: MediaStreamTrack, participant: Participant) {
    window.voiceFixture.tracks.push(track);
    this.listeners.get(RTVIEvent.TrackStarted)?.(track, participant);
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
    if (params.url !== 'https://voice-fixture.daily.co/room' || params.token !== 'synthetic-provider-double')
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
    queueMicrotask(() => {
      this.isMicEnabled = enabled;
      for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = enabled;
      const event = { action: 'participant-updated', participant: { local: true, session_id: 'fixture-user', audio: enabled } } as DailyEventObjectParticipant;
      for (const listener of this.transport.participants) listener(event);
    });
  }

  sendClientMessage(type: string, data?: unknown) {
    this.messages.push({ type, data });
  }
}