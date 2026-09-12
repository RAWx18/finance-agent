// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { DeviceArray, DeviceErrorType, Participant, PipecatClientOptions, Tracks } from '@pipecat-ai/client-js';
import type { DailyEventObjectParticipant } from '@daily-co/daily-js';

// Only the in-memory browser-test build aliases providers here; this is not speech acceptance.
export const RTVIEvent = { TrackStarted: 'trackStarted', TrackStopped: 'trackStopped' } as const;

/** Supplies the SDK-shaped device error used by the browser voice double. */
export class DeviceError extends Error {
  readonly status = undefined;
  readonly details = undefined;
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

/** Models participant subscriptions and rejected destruction calls without a Daily connection. */
export class DailyTransport {
  readonly participants = new Set<(event: DailyEventObjectParticipant) => void>();
  dailyCallClient = {
    /** Registers a listener for microphone acknowledgements emitted by the test double. */
    on: (event: 'participant-updated', listener: (event: DailyEventObjectParticipant) => void) => {
      if (event === 'participant-updated') this.participants.add(listener);
      return this.dailyCallClient;
    },
    /** Unregisters a participant listener during simulated call cleanup. */
    off: (event: 'participant-updated', listener: (event: DailyEventObjectParticipant) => void) => {
      if (event === 'participant-updated') this.participants.delete(listener);
      return this.dailyCallClient;
    },
    /** Records and rejects destruction to expose misuse of the transport double. */
    destroy: () => { window.voiceFixture.destroyed += 1; throw new Error('Calls to destroy() are disabled.'); },
  };
}

/** Provides browser-controlled voice events and capture without joining a provider room. */
export class PipecatClient {
  readonly callbacks: NonNullable<PipecatClientOptions['callbacks']>;
  readonly connections: { url: string; token: string }[] = [];
  readonly messages: { type: string; data: unknown }[] = [];
  disconnects = 0;
  isMicEnabled = true;
  micReady: Promise<void> = Promise.resolve();
  readonly transport: DailyTransport;
  private stream?: MediaStream;
  private listeners = new Map<string, (track: MediaStreamTrack, participant?: Participant) => void>();

  /** Captures client options and registers the instance for browser-test inspection. */
  constructor(options: PipecatClientOptions) {
    this.callbacks = options.callbacks ?? {};
    this.transport = options.transport as unknown as DailyTransport;
    this.isMicEnabled = options.enableMic ?? true;
    window.voiceFixture.clients.push(this);
  }

  /** Stores a track listener for explicit event delivery by the test double. */
  on(event: string, listener: (track: MediaStreamTrack, participant?: Participant) => void) {
    this.listeners.set(event, listener);
  }

  /** Records a supplied track and delivers its synthetic TrackStarted event. */
  emitTrack(track: MediaStreamTrack, participant: Participant) {
    window.voiceFixture.tracks.push(track);
    this.listeners.get(RTVIEvent.TrackStarted)?.(track, participant);
  }

  /** Requests test microphone capture only when this client starts with its microphone enabled. */
  async initDevices() {
    if (this.isMicEnabled) await this.captureMic();
  }

  /** Captures the browser test device and publishes its tracks as the fixture participant. */
  private async captureMic() {
    // Chromium's fake-device launch flag supplies this capture; no human audio is recorded or sent.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const track of this.stream.getTracks()) {
      window.voiceFixture.tracks.push(track);
      this.listeners.get(RTVIEvent.TrackStarted)?.(track, { id: 'fixture-user', name: 'Test microphone', local: true });
    }
  }

  /** Records synthetic join data and optionally fails without emitting connection readiness. */
  async connect(params: { url: string; token: string }) {
    if (params.url !== 'https://voice-fixture.daily.co/room' || params.token !== 'synthetic-provider-double')
      throw new Error('Provider-double transport accepts only synthetic join data.');
    this.connections.push(params);
    if (window.voiceFixture.connectError) throw new Error('Synthetic connection failure');
    // Connection and BotReady callbacks are emitted explicitly by each test, not by this promise.
  }

  /** Stops captured test tracks and delivers local TrackStopped events. */
  stopCapture() {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
      this.listeners.get(RTVIEvent.TrackStopped)?.(track, { id: 'fixture-user', name: 'Test microphone', local: true });
    }
    this.stream = undefined;
  }

  /** Records a disconnect request and releases this double's captured tracks. */
  async disconnect() {
    this.disconnects += 1;
    this.stopCapture();
  }

  tracks(): Tracks { return { local: { audio: this.stream?.getAudioTracks()[0] } }; }

  /** Simulates capture, mute events and queued participant acknowledgements for microphone changes. */
  enableMic(enabled: boolean) {
    if (enabled && !this.stream) {
      this.micReady = this.captureMic().then(() => this.enableMic(true), () => {
        this.callbacks.onDeviceError?.(new DeviceError(['mic'], 'permissions'));
      });
      return;
    }
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
      if (!enabled) this.listeners.get(RTVIEvent.TrackStopped)?.(track, { id: 'fixture-user', name: 'Test microphone', local: true });
    }
    queueMicrotask(() => {
      this.isMicEnabled = enabled;
      const event = { action: 'participant-updated', participant: { local: true, session_id: 'fixture-user', audio: enabled } } as DailyEventObjectParticipant;
      for (const listener of this.transport.participants) listener(event);
    });
  }

  /** Records outbound client messages for assertions instead of sending them to a provider. */
  sendClientMessage(type: string, data?: unknown) {
    this.messages.push({ type, data });
  }
}