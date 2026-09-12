// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { DeviceError, PipecatClient, RTVIEvent } from '@pipecat-ai/client-js';
import { DailyTransport } from '@pipecat-ai/daily-transport';
import type { DailyEventObjectParticipant } from '@daily-co/daily-js';
import { api, ApiError, authEpoch } from './api';
import type { CallJoin, Settings, Snapshot } from './api';
import { LiveCaption } from './Captions';
import type { Caption, Transcript } from './Captions';
import { CallIcon } from './CallIcon';
import { startRingback } from './ringback';
import { dismiss, notify } from './Toast';
import type { Notice } from './Toast';
import { VoiceOrb } from './components/assistant-ui/elements/voice';
import type { VoiceOrbState } from './components/assistant-ui/elements/voice';

export type VoicePhase = 'idle' | 'connecting' | 'active' | 'ended' | 'disconnected' | 'error';
type VoiceState = 'idle' | 'connecting' | 'listening' | 'userSpeaking' | 'assistantSpeaking'
  | 'processing' | 'interrupted' | 'reconnecting' | 'muted' | 'paused' | 'unavailable' | 'disconnected' | 'ended';
type Release = 'ended' | 'error' | 'unconfirmed';
type CallOwner = { callId?: string; authEpoch: number; conversationSlug?: string };
type Problem = Omit<Notice, 'action'> & { type: 'retry' | 'reconnect' | 'availability' | 'end' | 'session' };
const notices = ['voice:problem', 'voice:audio', 'voice:availability', 'voice:previous'];
const unavailable: Problem = { id: 'voice:availability', type: 'availability', title: 'Conversations unavailable', severity: 'error', duration: null,
  message: 'Try again shortly.' };
const quiet = { user: false, bot: false, generating: false, tool: false, muted: false, paused: false,
  capture: false, interrupted: false, connected: false, reconnecting: false, remote: false, playing: false, blocked: false,
  waiting: false, continuing: false, resumeFailed: false, responseMissing: false };
type Attempt = {
  client: PipecatClient; cancelled: boolean; ready: boolean; activity: typeof quiet;
  authEpoch: number; callId: string; shutdownSeconds: number;
  startupTimer?: ReturnType<typeof setTimeout>; expiryTimer?: ReturnType<typeof setTimeout>;
  devicesPending?: boolean; connectionPending?: boolean; connection?: Promise<unknown>;
  sequence: number; resumeSequence?: number; resumeTimer?: ReturnType<typeof setTimeout>;
  sessionId?: string; parentSession?: string; conversationSlug?: string;
  devices?: Promise<void>; join?: Promise<CallJoin>; cleanup?: Promise<Release>;
  financialReady?: () => void;
  tracks: Set<MediaStreamTrack>;
  observers: Map<MediaStreamTrack, () => void>;
  localTrack?: MediaStreamTrack; suspendedTrack?: MediaStreamTrack; remoteTrack?: MediaStreamTrack; remoteId?: string; botId?: string;
  level: number; levelAt?: number; meter?: ReturnType<typeof setTimeout>;
  onPageHide: () => void;
  removeParticipantListener?: () => void;
  stopRinging?: () => void;
};

function mark(stage: string) {
  performance.mark(`voice:${stage}`);
}

async function releaseCall(owner: CallOwner, seconds: number): Promise<Release> {
  if (owner.authEpoch !== authEpoch()) return 'unconfirmed';
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<Release> => {
        if (!owner.callId) {
          const call = await api.call(controller.signal);
          if (call.cleanupConfirmed && ['idle', 'ended', 'error'].includes(call.status)) return call.status === 'error' ? 'error' : 'ended';
          owner.callId = call.callId ?? undefined;
        }
        if (!owner.callId || owner.authEpoch !== authEpoch() || controller.signal.aborted) return 'unconfirmed';
        mark('end-request');
        // The deadline limits confirmation, not delivery of the keepalive termination request.
        const call = await api.endCall(owner.callId);
        if (owner.authEpoch !== authEpoch() || call.callId !== owner.callId) return 'unconfirmed';
        if (call.conversationSlug) owner.conversationSlug = call.conversationSlug;
        if (call.cleanupConfirmed !== true) return 'unconfirmed';
        if (call.status !== 'idle' && call.status !== 'ended' && call.status !== 'error') return 'unconfirmed';
        mark('end-confirmed');
        return call.status === 'error' ? 'error' : 'ended';
      })(),
      new Promise<Release>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('unconfirmed'); }, seconds * 1000); }),
    ]);
  } catch { return 'unconfirmed'; }
  finally { clearTimeout(timer); }
}

function stopTracks(attempt: Attempt) {
  try {
    for (const track of Object.values(attempt.client.tracks().local)) if (track) attempt.tracks.add(track);
  } catch { /* Failed device setup can leave SDK track access unavailable. */ }
  for (const track of attempt.tracks) track.stop();
}

async function disconnect(attempt: Attempt) {
  stopTracks(attempt);
  try { await attempt.client.disconnect(); } catch { /* Local teardown must not prevent owned room release. */ }
}

// Late device and transport work belongs only to this SDK instance, never the next attempt.
function dispose(attempt: Attempt): Promise<Release> {
  if (attempt.cleanup) return attempt.cleanup;
  attempt.cancelled = true;
  attempt.stopRinging?.();
  attempt.removeParticipantListener?.();
  attempt.financialReady?.();
  clearTimeout(attempt.meter);
  clearTimeout(attempt.resumeTimer);
  clearTimeout(attempt.startupTimer);
  clearTimeout(attempt.expiryTimer);
  window.removeEventListener('pagehide', attempt.onPageHide);
  for (const [track, observer] of attempt.observers) {
    for (const event of ['mute', 'unmute', 'ended']) track.removeEventListener?.(event, observer);
  }
  stopTracks(attempt);
  mark('local-stop');
  attempt.cleanup = attempt.join ? releaseCall(attempt, attempt.shutdownSeconds) : Promise.resolve('ended');
  // Pending permission cannot be cancelled by the browser; release any eventual capture in the background.
  if (attempt.devicesPending) void attempt.devices?.then(() => disconnect(attempt), () => disconnect(attempt));
  else void disconnect(attempt);
  if (attempt.connectionPending) void attempt.connection?.then(() => disconnect(attempt), () => disconnect(attempt));
  return attempt.cleanup;
}

function callError(error: unknown): Problem {
  if ((error instanceof DOMException && error.name === 'NotAllowedError') || (error instanceof DeviceError && error.type === 'permissions'))
    return { id: 'voice:problem', type: 'retry', title: 'Microphone access denied', severity: 'warning', duration: null,
      message: 'Allow microphone access in your browser’s site settings, then try again.' };
  if ((error instanceof DOMException && error.name === 'NotFoundError') || (error instanceof DeviceError && error.type === 'not-found'))
    return { id: 'voice:problem', type: 'retry', title: 'No microphone found', severity: 'error', duration: null,
      message: 'Connect a microphone, then try again.' };
  if ((error instanceof DOMException && error.name === 'NotReadableError') || (error instanceof DeviceError && error.type === 'in-use'))
    return { id: 'voice:problem', type: 'retry', title: 'Microphone in use', severity: 'error', duration: null,
      message: 'Close other calling apps, then try again.' };
  if (error instanceof DeviceError && error.type === 'undefined-mediadevices')
    return { id: 'voice:problem', type: 'retry', title: 'Microphone unavailable', severity: 'error', duration: null,
      message: 'Open this page in a current browser, then try again.' };
  if (error instanceof ApiError && error.body.code === 'callExpired')
    return { id: 'voice:problem', type: 'retry', title: 'Call expired', severity: 'info', duration: null,
      message: 'This call expired. Reconnect to continue with your saved figures.' };
  if (error instanceof ApiError && (error.status === 401 || error.status === 403))
    return { id: 'voice:problem', type: 'session', title: 'Sign-in required', severity: 'error', duration: null, dismissible: false,
      message: 'Your sign-in could not be verified. Reload the page and sign in again to continue.' };
  if (error instanceof ApiError && (error.status === 404 || error.status === 410))
    return { id: 'voice:problem', type: 'session', title: error.status === 410 ? 'Conversation expired' : 'Conversation unavailable',
      severity: 'error', duration: null, dismissible: false,
      message: 'This conversation is no longer available. Reload the page to check your session before starting again.' };
  if (error instanceof ApiError && ['conversationChanged', 'sessionChanged'].includes(error.body.code))
    return { id: 'voice:problem', type: 'session', title: 'Conversation changed', severity: 'warning', duration: null,
      message: 'Your microphone is off. Open this conversation again from History before continuing.' };
  if (error instanceof ApiError && error.status === 409)
    return { id: 'voice:previous', type: 'end', title: 'A conversation is still open', severity: 'critical', duration: null,
      message: 'Another conversation is still open. End it before connecting here.' };
  if (error instanceof ApiError && error.status === 503) return unavailable;
  if (error instanceof TypeError || !navigator.onLine)
    return { id: 'voice:problem', type: 'reconnect', title: 'Connection lost', severity: 'error', duration: null,
      message: 'Check your internet connection, then reconnect.' };
  return { id: 'voice:problem', type: 'retry', title: 'Could not connect', severity: 'error', duration: null,
    message: 'Check your connection and microphone, then try again.' };
}

function audioSource(current: Attempt): 'local' | 'remote' | undefined {
  if (!current.ready || current.cancelled || current.activity.reconnecting || current.activity.waiting) return;
  const { activity, localTrack, remoteTrack } = current;
  if (activity.user && activity.capture && !activity.paused && !activity.muted && current.client.isMicEnabled
    && localTrack?.readyState === 'live' && !localTrack.muted && localTrack.enabled !== false) return 'local';
  if (activity.bot && activity.remote && activity.playing && !activity.blocked
    && remoteTrack?.readyState === 'live' && !remoteTrack.muted && remoteTrack.enabled !== false) return 'remote';
}

export function Conversation({ settings, sessionId, conversationSlug, startRequest, onStartConsumed, onConversationChange, disabled, onStarted, onBusyChange, presentation, onPrepare, onPhaseChange, onSettings, onTranscriptChange, visible = true, sessionIssue, updatesLost = false, updatesReady = true }: {
  settings: Settings | null; sessionId?: string; disabled: boolean;
  conversationSlug?: string | null; startRequest?: string; onStartConsumed?: () => void;
  onConversationChange?: (slug: string, sessionId: string) => void;
  onStarted: (snapshot: Snapshot) => void; onBusyChange: (busy: boolean) => void;
  presentation: 'landing' | 'ready' | 'session'; onPrepare: () => void;
  onPhaseChange: (phase: VoicePhase) => void; onSettings: (settings: Settings) => void;
  visible?: boolean; sessionIssue?: 'expired' | 'deleted' | 'unreadable' | 'unauthorized';
  updatesLost?: boolean;
  updatesReady?: boolean;
  onTranscriptChange?: (transcript: Transcript) => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [activity, setActivity] = useState(quiet);
  const [level, setLevel] = useState(0);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [interim, setInterim] = useState<{ text: string; time: number } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [endIssue, setEndIssue] = useState<'open' | 'unconfirmed' | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [checkedSession, setCheckedSession] = useState<string>();
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const voiceAvailable = settings?.voiceAvailable;
  const [observed, setObserved] = useState({ sessionId, sessionIssue, updatesLost, voiceAvailable });
  if (observed.sessionId !== sessionId || observed.sessionIssue !== sessionIssue || observed.updatesLost !== updatesLost
    || observed.voiceAvailable !== voiceAvailable) {
    const contextChanged = observed.sessionId !== sessionId || observed.sessionIssue !== sessionIssue || observed.updatesLost !== updatesLost;
    setObserved({ sessionId, sessionIssue, updatesLost, voiceAvailable });
    setCheckingAvailability(false);
    if (observed.sessionId && observed.sessionId !== sessionId || sessionIssue && observed.sessionIssue !== sessionIssue) {
      setCaptions([]); setInterim(null); setEndIssue(null);
    }
    if (observed.sessionId && observed.sessionId !== sessionId || contextChanged && (sessionIssue || problem?.type === 'session' || problem?.type === 'availability')
      || observed.voiceAvailable !== voiceAvailable && voiceAvailable && problem?.type === 'availability') setProblem(null);
  }
  const audio = useRef<HTMLAudioElement>(null);
  const attempt = useRef<Attempt | null>(null);
  const mounted = useRef(false);
  const captionId = useRef(0);
  const interimTime = useRef<number | null>(null);
  const generation = useRef(0);
  const ending = useRef(false);
  const previousCall = useRef<CallOwner | null>(null);
  const logicalChat = useRef({ sessionId, slug: conversationSlug });
  const consumedStart = useRef<string | undefined>(undefined);
  const availability = useRef<AbortController | null>(null);
  const sessionBlocked = !!sessionIssue || problem?.type === 'session';
  const needsEnd = endIssue !== null && !sessionBlocked;
  const running = phase === 'connecting' || phase === 'active';
  const checkingCall = !!sessionId && !sessionBlocked && checkedSession !== sessionId;
  const busy = running || cleanupPending || needsEnd || checkingCall;
  const startBlocked = disabled || updatesLost || sessionBlocked || !settings?.voiceAvailable || busy;
  const actions = useRef({ start, finish, playAudio, checkAvailability, onStarted, onSettings, sessionBlocked, sessionId, updatesReady });
  const notifyPhase = useEffectEvent(onPhaseChange);
  const notifyBusy = useEffectEvent(onBusyChange);
  const notifyTranscript = useEffectEvent((transcript: Transcript) => onTranscriptChange?.(transcript));
  const consumeStart = useEffectEvent(() => onStartConsumed?.());

  useLayoutEffect(() => {
    if (conversationSlug || !attempt.current && logicalChat.current.sessionId !== sessionId)
      logicalChat.current = { sessionId, slug: conversationSlug };
  }, [sessionId, conversationSlug]);

  useEffect(() => {
    if (!startRequest || consumedStart.current === startRequest || !visible || presentation === 'landing' || startBlocked || !updatesReady) return;
    consumedStart.current = startRequest;
    consumeStart();
    void actions.current.start();
  }, [startRequest, visible, presentation, startBlocked, updatesReady]);

  useLayoutEffect(() => {
    actions.current = { start, finish, playAudio, checkAvailability, onStarted, onSettings, sessionBlocked, sessionId, updatesReady };
    if (updatesReady && attempt.current?.sessionId === sessionId) attempt.current?.financialReady?.();
  });
  useEffect(() => { notifyPhase(phase); }, [phase]);
  useEffect(() => { notifyBusy(busy); }, [busy]);
  useLayoutEffect(() => { notifyTranscript({ captions, interim }); }, [captions, interim]);

  useLayoutEffect(() => {
    mounted.current = true;
    const player = audio.current;
    return () => {
      mounted.current = false;
      availability.current?.abort();
      for (const id of notices) dismiss(id);
      if (player?.srcObject) player.pause();
      if (player) player.srcObject = null;
      if (attempt.current) void dispose(attempt.current);
    };
  }, []);

  const stopUnavailable = useEffectEvent(() => {
    const current = attempt.current;
    availability.current?.abort(); availability.current = null;
    if (sessionIssue) {
      dismiss('voice:problem'); dismiss('voice:availability'); dismiss('voice:audio');
    }
    if (current && (sessionIssue || updatesLost || sessionId !== current.parentSession && sessionId !== current.sessionId))
      void actions.current.finish('error', updatesLost && !sessionIssue ? { id: 'voice:problem', type: 'reconnect', title: 'Conversation stopped',
        severity: 'warning', duration: null, message: 'Your microphone is off. Start talking again when you’re ready.' } : undefined);
  });
  // Capture and playback must stop before paint when their financial session becomes unsafe.
  useLayoutEffect(() => { stopUnavailable(); }, [sessionIssue, sessionId, updatesLost, voiceAvailable]);

  useEffect(() => {
    if (!problem || sessionIssue || updatesLost) { dismiss('voice:problem'); dismiss('voice:availability'); return; }
    notify({ ...problem, action: problem.type === 'session' ? undefined : problem.type === 'availability'
      ? { label: 'Check availability', dismiss: false, disabled: checkingAvailability || disabled, onClick: () => actions.current.checkAvailability() }
      : { label: problem.type === 'reconnect' ? 'Reconnect' : 'Retry', dismiss: false, disabled: startBlocked, onClick: () => actions.current.start() } });
  }, [problem, sessionIssue, updatesLost, startBlocked, checkingAvailability, disabled]);

  useEffect(() => {
    if (!endIssue || sessionBlocked) { dismiss('voice:previous'); return; }
    notify({ id: 'voice:previous', title: endIssue === 'open' ? 'A conversation is still open' : 'Call ending not confirmed',
      message: endIssue === 'open' ? 'Another conversation is still open. End it before connecting here.'
        : 'Microphone off. We couldn’t confirm the call ended. Retry ending it before starting again.',
      severity: 'critical', duration: null, dismissible: false,
      action: { label: 'Retry ending call', disabled: cleanupPending, dismiss: false, onClick: () => actions.current.finish('ended') } });
  }, [endIssue, cleanupPending, sessionBlocked]);

  useEffect(() => {
    if (!activity.blocked || sessionBlocked) { dismiss('voice:audio'); return; }
    notify({ id: 'voice:audio', title: 'Assistant audio paused', severity: 'warning', duration: null,
      message: 'Your browser paused playback. Resume audio to hear the assistant.',
      action: { label: 'Resume audio', dismiss: false, disabled, onClick: () => actions.current.playAudio() } });
  }, [activity, sessionBlocked, disabled]);

  useEffect(() => {
    if (!sessionId || sessionIssue || !settings) return;
    if (attempt.current) { setCheckedSession(sessionId); return; }
    const controller = new AbortController();
    const version = generation.current;
    previousCall.current = null;
    const timer = setTimeout(() => {
      controller.abort();
      if (attempt.current || version !== generation.current) return;
      setCheckedSession(sessionId); setEndIssue('unconfirmed');
    }, settings.voiceStartupSeconds * 1000);
    void api.call(controller.signal).then((call) => {
      if (controller.signal.aborted || attempt.current || version !== generation.current) return;
      const open = call.status === 'active' || call.status === 'connecting';
      const unconfirmed = !call.cleanupConfirmed || call.status === 'ending';
      previousCall.current = { callId: call.callId ?? undefined, authEpoch: authEpoch() };
      setCheckedSession(sessionId);
      setEndIssue(open ? 'open' : unconfirmed ? 'unconfirmed' : null);
      if (call.status === 'error' && call.cleanupConfirmed && !actions.current.sessionBlocked) setProblem({ id: 'voice:problem', type: 'retry', severity: 'info', duration: 6000,
        title: 'Previous conversation stopped', message: 'The previous conversation stopped with an error. You can try a new conversation.' });
    }).catch((error) => {
      if (!controller.signal.aborted && !attempt.current && version === generation.current) {
        setCheckedSession(sessionId);
        const issue = callError(error);
        setEndIssue(issue.type === 'session' ? null : 'unconfirmed');
        if (issue.type === 'session') setProblem(issue);
      }
    }).finally(() => clearTimeout(timer));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, sessionIssue, settings]);

  function resetLevel(current: Attempt) {
    clearTimeout(current.meter);
    current.level = 0; current.levelAt = undefined;
    if (mounted.current && attempt.current === current) setLevel(0);
  }

  function updateActivity(current: Attempt, patch: Partial<typeof quiet>) {
    if (!mounted.current || attempt.current !== current || current.cancelled) return;
    const source = audioSource(current);
    current.activity = { ...current.activity, ...patch };
    if (!audioSource(current) || source !== audioSource(current)) resetLevel(current);
    setActivity(current.activity);
  }

  function measure(current: Attempt, source: 'local' | 'remote', value: number) {
    if (!mounted.current || attempt.current !== current || actions.current.sessionBlocked || audioSource(current) !== source) return;
    value = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    if (!value) { resetLevel(current); return; }
    const time = performance.now();
    const weight = current.levelAt === undefined ? 1 : 1 - Math.exp(-(time - current.levelAt) / 100);
    current.level += (value - current.level) * weight;
    current.levelAt = time;
    setLevel(current.level);
    clearTimeout(current.meter);
    // Missing metering samples must not leave residual energy on the circle.
    current.meter = setTimeout(() => resetLevel(current), 200);
  }

  async function finish(next: VoicePhase, issue?: Problem) {
    const current = attempt.current;
    if (!mounted.current || current?.cancelled || ending.current || !current && sessionBlocked) return;
    ending.current = true;
    mark('end');
    generation.current += 1;
    setCleanupPending(true);
    setInterim(null); interimTime.current = null;
    setCaptions((items) => items.map((item) => item.pending ? { ...item, pending: false, interrupted: true } : item));
    if (current) resetLevel(current);
    setActivity(quiet);
    dismiss('voice:audio');
    audio.current?.pause();
    if (audio.current) audio.current.srcObject = null;
    const owner = current ?? previousCall.current ?? { authEpoch: authEpoch() };
    previousCall.current = owner;
    const cleanup = current ? dispose(current) : settings ? releaseCall(owner, settings.voiceShutdownSeconds) : 'unconfirmed';
    // Voice phase describes the local interaction, independently of provider cleanup.
    setPhase(next);
    if (issue && issue.type !== 'end' && !actions.current.sessionBlocked) setProblem(issue);
    const released = await cleanup;
    if (!mounted.current || attempt.current !== current) return;
    if (current && owner.authEpoch === authEpoch() && owner.conversationSlug
      && (actions.current.sessionId === current.sessionId || actions.current.sessionId === current.parentSession))
      logicalChat.current = { sessionId: actions.current.sessionId, slug: owner.conversationSlug };
    attempt.current = null;
    ending.current = false;
    setCleanupPending(false);
    if (issue?.type === 'end') previousCall.current = { authEpoch: owner.authEpoch };
    setEndIssue(issue?.type === 'end' ? 'open' : released === 'unconfirmed' ? endIssue === 'open' ? 'open' : 'unconfirmed' : null);
    if (released === 'error' && !issue && !problem && !actions.current.sessionBlocked) setProblem({ ...callError(undefined),
      title: 'Conversation stopped', message: 'The conversation stopped with an error. Try a new conversation.' });
  }

  async function playAudio(automatic = false) {
    if (!mounted.current || actions.current.sessionBlocked || !automatic && disabled) return;
    if (!automatic && (!visible || presentation === 'landing')) { onPrepare(); return; }
    const current = attempt.current;
    const player = audio.current;
    const stream = player?.srcObject;
    if (!current || current.cancelled || current.remoteTrack?.readyState !== 'live' || !player || !stream) return;
    if (current.activity.waiting && !current.activity.continuing) return;
    const sequence = current.sequence;
    try {
      await player.play();
      if (mounted.current && attempt.current === current && !current.cancelled && player.srcObject === stream && current.sequence === sequence) {
        updateActivity(current, { playing: !current.activity.waiting, blocked: false }); dismiss('voice:audio');
      }
    } catch {
      if (player.srcObject === stream && current.sequence === sequence && !current.activity.waiting)
        updateActivity(current, { playing: false, blocked: true });
    }
  }

  async function start() {
    if (!mounted.current || disabled || sessionBlocked || !settings) return;
    if (!visible || presentation === 'landing') { onPrepare(); return; }
    if (attempt.current || ending.current || startBlocked) return;
    mark('start');
    generation.current += 1;
    availability.current?.abort(); availability.current = null;
    setCheckingAvailability(false);
    setPhase('connecting');
    for (const id of notices) dismiss(id);
    setProblem(null);
    setCaptions([]);
    setInterim(null); interimTime.current = null;
    setLevel(0);
    const activity = { ...quiet, reconnecting: phase === 'ended' || phase === 'disconnected' || phase === 'error' };
    setActivity(activity);
    let current: Attempt | null = null;
    try {
      // Daily's script loader must respect the application's no-eval content security policy.
      const transport = new DailyTransport({ bufferLocalAudioUntilBotReady: false,
        dailyConfig: { avoidEval: true, alwaysIncludeMicInPermissionPrompt: false } });
      const live = () => mounted.current && current !== null && attempt.current === current && !current.cancelled
        && current.authEpoch === authEpoch() && !actions.current.sessionBlocked;
      const update = (patch: Partial<typeof quiet>) => {
        if (live() && current) updateActivity(current, current.activity.waiting ? { ...patch,
          user: false, bot: false, generating: false, tool: false, paused: false, interrupted: false, capture: false, playing: false, blocked: false } : patch);
      };
      const tools = new Set<string>();
      const unfinished = new Set<string>();
      let spokenId: string | undefined;
      const updateTracks = () => {
        if (!live() || !current) return;
        const { localTrack, remoteTrack } = current;
        if (localTrack?.readyState === 'ended' && !current.activity.waiting && client.isMicEnabled) { microphoneLost(); return; }
        if (remoteTrack?.readyState === 'ended') update({ playing: false, blocked: false });
        update({ capture: localTrack?.readyState === 'live' && !localTrack.muted && localTrack.enabled !== false, muted: !client.isMicEnabled,
          remote: remoteTrack?.readyState === 'live' && !remoteTrack.muted && remoteTrack.enabled !== false });
      };
      const observe = (track: MediaStreamTrack) => {
        if (!current || current.observers.has(track)) return;
        current.observers.set(track, updateTracks);
        for (const event of ['mute', 'unmute', 'ended']) track.addEventListener?.(event, updateTracks);
      };
      const fail = (issue: Problem) => { if (live()) void actions.current.finish('error', issue); };
      const microphoneLost = () => fail({ id: 'voice:problem', type: 'retry', title: 'Microphone disconnected', severity: 'error', duration: null,
        message: 'Your microphone disconnected. The conversation has stopped. Reconnect your microphone, then retry.' });
      const disconnected = () => { if (live()) void actions.current.finish('disconnected', callError(new TypeError())); };
      const client = new PipecatClient({ transport, enableMic: false, enableCam: false, callbacks: {
        onConnected: () => {
          if (live() && current?.ready) clearTimeout(current.startupTimer);
          update({ connected: true, reconnecting: current?.ready ? false : current?.activity.reconnecting ?? false });
        },
        onBotReady: () => {
          if (!live() || !current || current.ready) return;
          current.stopRinging?.();
          mark('bot-ready'); clearTimeout(current.startupTimer);
          current.ready = true; setPhase('active'); update({ reconnecting: false });
          try { client.enableMic(true); updateTracks(); }
          catch { fail({ ...callError(undefined), title: 'Microphone unavailable',
            message: 'The microphone could not start. Check microphone access, then try again.' }); }
        },
        onBotConnected: (participant) => {
          if (!live() || !current || participant.local) return;
          current.botId = participant.id;
          if (current.remoteId && current.remoteId !== participant.id) {
            audio.current?.pause();
            if (audio.current) audio.current.srcObject = null;
            current.remoteTrack = undefined; current.remoteId = undefined;
            update({ remote: false, playing: false, blocked: false });
          }
        },
        onTransportStateChanged: (state) => {
          if (!live()) return;
          if (state === 'connecting' && current?.ready && !current.activity.reconnecting) {
            update({ reconnecting: true, connected: false, user: false, bot: false, interrupted: false });
            deadline();
          }
          if (state === 'ready' && current?.ready) {
            clearTimeout(current.startupTimer);
            update({ reconnecting: false });
          }
          if (state === 'error') fail(callError(new TypeError()));
          if (state === 'disconnected') disconnected();
        },
        onDisconnected: disconnected,
        onBotDisconnected: disconnected,
        onError: (message) => {
          if (!message.data || typeof message.data !== 'object' || !('fatal' in message.data) || message.data.fatal !== false)
            fail({ ...callError(undefined), title: 'Conversation stopped', message: 'The assistant could not continue. Check your connection and try again.' });
          else if (live() && current?.activity.continuing) {
            clearTimeout(current.resumeTimer);
            update({ continuing: false, resumeFailed: true });
          }
        },
        onServerMessage: (data: unknown) => {
          if (!live() || !current?.join || !data || typeof data !== 'object' || Array.isArray(data)) return;
          if (!('type' in data) || data.type !== 'conversation-state' || !('state' in data)
            || data.state !== 'waiting' && data.state !== 'active' || !('sequence' in data)
            || typeof data.sequence !== 'number' || !Number.isSafeInteger(data.sequence) || data.sequence <= current.sequence) return;
          if (data.state === 'waiting' && !current.ready) return;
          // Only this attempt's explicit Continue can authorize capture after a wait.
          if (data.state === 'active' && current.activity.waiting && current.resumeSequence !== current.sequence) return;
          const resuming = current.activity.waiting && data.state === 'active';
          current.sequence = data.sequence;
          clearTimeout(current.resumeTimer); current.resumeSequence = undefined;
          if (data.state === 'waiting') {
            updateActivity(current, { waiting: true, continuing: false, resumeFailed: false, user: false, bot: false,
              responseMissing: 'reason' in data && data.reason === 'response',
              generating: false, tool: false, paused: false, interrupted: false, capture: false, playing: false, blocked: false });
            tools.clear();
            setInterim(null); interimTime.current = null;
            setCaptions(items => items.map(item => item.pending ? { ...item, pending: false, interrupted: true } : item));
            if (audio.current) { audio.current.muted = true; audio.current.pause(); }
            current.suspendedTrack = current.localTrack;
            try { client.enableMic(false); updateTracks(); }
            catch { fail({ ...callError(undefined), title: 'Microphone unavailable', message: 'The microphone could not be paused. The conversation has stopped.' }); }
          } else if (resuming) {
            updateActivity(current, { waiting: false, continuing: false, resumeFailed: false, responseMissing: false });
            try {
              client.enableMic(true);
              if (!live()) return;
              current.localTrack = client.tracks().local.audio ?? current.localTrack;
              if (current.localTrack?.readyState === 'ended') current.localTrack = undefined;
              if (current.localTrack) { current.tracks.add(current.localTrack); observe(current.localTrack); }
              updateTracks();
              if (audio.current) audio.current.muted = false;
              void actions.current.playAudio(true);
            } catch { fail({ ...callError(undefined), title: 'Microphone unavailable', message: 'The microphone could not resume. Check microphone access, then try again.' }); }
          }
        },
        onDeviceError: (error) => fail(callError(error)),
        onLocalAudioLevel: (value) => { if (current) measure(current, 'local', value); },
        onRemoteAudioLevel: (value, participant) => {
          if (current && !participant.local && participant.id === current.remoteId) measure(current, 'remote', value);
        },
        onUserStartedSpeaking: () => {
          if (!live() || !current?.ready || current.activity.reconnecting || current.activity.waiting) return;
          update({ user: true, interrupted: current.activity.bot, generating: false });
          // SDK completions can arrive before React applies the caption update.
          const interrupted = new Set(unfinished);
          setCaptions((items) => items.some(item => item.pending || interrupted.has(item.id))
            ? items.map((item) => item.pending || interrupted.has(item.id) ? { ...item, pending: false, interrupted: true } : item) : items);
        },
        onUserStoppedSpeaking: () => update({ user: false, interrupted: false }),
        onBotStartedSpeaking: () => {
          if (current?.ready && !current.activity.reconnecting) update({ bot: true, interrupted: current.activity.user });
        },
        onBotStoppedSpeaking: () => {
          if (!live()) return;
          update({ bot: false });
          setCaptions((items) => items.map((item) => item.pending ? { ...item, pending: false } : item));
        },
        onBotLlmStarted: () => update({ generating: true }),
        onBotLlmStopped: () => update({ generating: false }),
        onLLMFunctionCallStarted: () => update({ tool: true }),
        onLLMFunctionCallInProgress: (data) => { if (live() && !current?.activity.waiting) { tools.add(data.tool_call_id); update({ tool: true }); } },
        onLLMFunctionCallStopped: (data) => { tools.delete(data.tool_call_id); update({ tool: tools.size > 0 }); },
        onUserMuteStarted: () => update({ paused: true, user: false, interrupted: false }),
        onUserMuteStopped: () => update({ paused: false }),
        onUserTranscript: (data) => {
          if (!live() || current?.activity.waiting) return;
          if (!data.final) {
            if (!data.text.trim()) return;
            interimTime.current ??= Date.now();
            setInterim({ text: data.text, time: interimTime.current });
            return;
          }
          setInterim(null); interimTime.current = null;
          if (!data.text.trim()) return;
          const id = `user-${data.user_id}-${data.timestamp}`;
          const parsed = typeof data.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.timestamp) ? Date.parse(data.timestamp) : NaN;
          const date = Number.isFinite(parsed) ? Date.parse(`${data.timestamp.slice(0, 10)}T00:00:00Z`) : NaN;
          // Opaque SDK timestamps are recorded at receipt, not interpreted as dates.
          const time = Number.isFinite(date) && new Date(date).toISOString().startsWith(data.timestamp.slice(0, 10)) ? parsed : Date.now();
          setCaptions((items) => items.some(item => item.id === id) ? items.map(item => item.id === id ? { ...item, text: data.text } : item)
            : [...items, { id, speaker: 'You', text: data.text, time }]);
        },
        onBotOutput: (data) => {
          if (!live() || current?.activity.waiting || data.will_be_spoken === false) return;
          if (data.spoken_status === 'new') { if (data.segment_id === undefined) spokenId = undefined; return; }
          if (data.spoken_status !== 'in-progress' && data.spoken_status !== 'completed') return;
          const text = data.spoken_progress?.accumulated_text ?? (data.spoken_status === 'completed' ? data.text : '');
          if (!text.trim()) return;
          const id = data.segment_id === undefined ? spokenId ??= `spoken-${++captionId.current}` : `bot-${data.segment_id}`;
          const pending = data.spoken_status !== 'completed';
          if (pending) unfinished.add(id); else unfinished.delete(id);
          const time = Date.now();
          setCaptions((items) => {
            const index = items.findIndex((item) => item.id === id);
            if (index < 0) return [...items, { id, speaker: 'Assistant', text, time, pending }];
            return items.map((item) => item.id === id && !item.interrupted ? { ...item, text, pending } : item);
          });
        },
      } });
      current = { client, cancelled: false, ready: false, activity, sequence: 0, authEpoch: authEpoch(), callId: crypto.randomUUID(), shutdownSeconds: settings.voiceShutdownSeconds, sessionId, parentSession: sessionId, tracks: new Set(), observers: new Map(), level: 0, onPageHide: () => {
        if (live()) void actions.current.finish('disconnected', callError(new TypeError()));
      } };
      attempt.current = current;
      current.stopRinging = startRingback();
      previousCall.current = null;
      const deadline = (seconds = settings.voiceStartupSeconds) => {
        if (!current) return;
        clearTimeout(current.startupTimer);
        current.startupTimer = setTimeout(() => fail({ ...callError(undefined), title: 'Connection timed out',
          message: 'The conversation took too long to connect. Check microphone access and your connection, then retry.' }), seconds * 1000);
      };
      window.addEventListener('pagehide', current.onPageHide);
      // Daily settles local audio asynchronously, even when the persistent track emits no event.
      const daily = transport.dailyCallClient;
      const onParticipantUpdated = (event: DailyEventObjectParticipant) => {
        if (event.participant.local) updateTracks();
      };
      daily.on('participant-updated', onParticipantUpdated);
      current.removeParticipantListener = () => { daily.off('participant-updated', onParticipantUpdated); };
      current.client.on(RTVIEvent.TrackStarted, (track, participant) => {
        if (!live()) { track.stop(); return; }
        if (!current) return;
        current.tracks.add(track);
        if (participant?.local) {
          if (track.kind === 'audio') {
            resetLevel(current);
            current.localTrack = track;
            observe(track); updateTracks();
          }
          return;
        }
        if (track.kind !== 'audio' || !participant || !audio.current || current.botId && participant.id !== current.botId) return;
        resetLevel(current);
        current.remoteTrack = track; current.remoteId = participant.id;
        observe(track); updateTracks();
        update({ playing: false, blocked: false });
        audio.current.srcObject = new MediaStream([track]);
        void actions.current.playAudio(true);
      });
      current.client.on(RTVIEvent.TrackStopped, (track, participant) => {
        if (!live()) return;
        if (track.readyState === 'ended') current?.tracks.delete(track);
        const suspended = current?.suspendedTrack === track;
        if (current && suspended) current.suspendedTrack = undefined;
        if (participant?.local && current?.localTrack === track) {
          if (!suspended && !current.activity.waiting && client.isMicEnabled) { microphoneLost(); return; }
          if (track.readyState === 'ended') current.localTrack = undefined;
        }
        if (current?.remoteTrack === track) { current.remoteTrack = undefined; current.remoteId = undefined; }
        updateTracks();
        const stream = audio.current?.srcObject as MediaStream | null;
        if (stream?.getTracks().includes(track) && audio.current) {
          audio.current.pause(); audio.current.srcObject = null; update({ playing: false, blocked: false });
        }
      });
      // Prepare devices without opening capture; BotReady owns the first microphone enable.
      mark('mic-request');
      current.devicesPending = true;
      try { current.devices = current.client.initDevices(); await current.devices; }
      finally { current.devicesPending = false; }
      if (!live()) return;
      mark('mic-ready');
      deadline();
      current.localTrack = current.client.tracks().local.audio ?? current.localTrack;
      if (current.localTrack) { current.tracks.add(current.localTrack); observe(current.localTrack); }
      updateTracks();
      mark('setup-request');
      let saved = await api.start();
      if (!live()) return;
      const slug = logicalChat.current.slug ?? saved.conversationSlug ?? undefined;
      if (slug && saved.conversationSlug !== slug)
        throw new ApiError(409, { code: 'conversationChanged', message: 'The selected conversation changed. Open it again from History.' });
      logicalChat.current = { sessionId: saved.sessionId, slug };
      current.sessionId = saved.sessionId;
      actions.current.onStarted(saved);
      if (actions.current.sessionId && actions.current.sessionId !== saved.sessionId || !actions.current.updatesReady)
        await new Promise<void>(resolve => { if (current) current.financialReady = resolve; });
      if (!live()) return;
      mark('setup-ready');
      deadline(settings.voiceStartupSeconds + settings.voiceShutdownSeconds);
      mark('join-request');
      current.conversationSlug = slug;
      current.join = api.startCall(current.callId, slug);
      let join: CallJoin;
      try { join = await current.join; }
      catch (error) {
        if (error instanceof ApiError && error.status < 500 && error.body.code !== 'callExpired') current.join = undefined;
        throw error;
      }
      if (!live()) return;
      if (join.callId !== current.callId) throw new Error('Call ownership could not be confirmed.');
      current.conversationSlug = join.conversationSlug;
      if (!slug) {
        saved = await api.current();
        if (!live()) return;
        if (saved.conversationSlug !== join.conversationSlug)
          throw new ApiError(409, { code: 'conversationChanged', message: 'The selected conversation changed. Open it again from History.' });
        current.sessionId = saved.sessionId;
        actions.current.onStarted(saved);
      }
      logicalChat.current = { sessionId: saved.sessionId, slug: join.conversationSlug };
      onConversationChange?.(join.conversationSlug, saved.sessionId);
      if (actions.current.sessionId && actions.current.sessionId !== saved.sessionId || !actions.current.updatesReady)
        await new Promise<void>(resolve => { if (current) current.financialReady = resolve; });
      if (!live()) return;
      const remaining = Date.parse(join.expiresAt) - Date.now();
      if (!Number.isFinite(remaining)) throw new Error('Call credentials could not be confirmed.');
      const expired = new ApiError(410, { code: 'callExpired', message: 'Call expired.' });
      if (remaining <= 0) throw expired;
      current.expiryTimer = setTimeout(() => fail(callError(expired)), remaining);
      mark('join-ready');
      deadline();
      mark('connect');
      current.connectionPending = true;
      current.connection = current.client.connect({ url: join.url, token: join.token });
      try { await current.connection; } finally { current.connectionPending = false; }
    } catch (error) {
      if (mounted.current && attempt.current === current && !current?.cancelled && !actions.current.sessionBlocked) {
        if (current) await actions.current.finish('error', callError(error));
        else {
          setPhase('error'); setProblem(callError(error));
        }
      }
    }
  }

  function toggleMic() {
    const current = attempt.current;
    if (!current || current.cancelled || phase !== 'active' || current.activity.waiting || sessionBlocked) return;
    try {
      // Daily can report mute's TrackStopped before its local-audio acknowledgement.
      if (current.client.isMicEnabled) current.suspendedTrack = current.localTrack;
      current.client.enableMic(!current.client.isMicEnabled);
      updateActivity(current, { muted: !current.client.isMicEnabled, user: false, interrupted: false });
    } catch {
      void finish('error', { ...callError(undefined), title: 'Microphone unavailable',
        message: 'The microphone could not be changed. The call has been stopped; check microphone access before trying again.' });
    }
  }

  function continueConversation() {
    const current = attempt.current;
    if (!mounted.current || !current || current.cancelled || current.authEpoch !== authEpoch() || sessionBlocked || disabled
      || phase !== 'active' || !current.activity.waiting || current.activity.continuing || current.activity.reconnecting) return;
    current.resumeSequence = current.sequence;
    updateActivity(current, { continuing: true, resumeFailed: false });
    // This deadline only offers retry; the server alone authorizes leaving waiting.
    current.resumeTimer = setTimeout(() => {
      if (!current.cancelled && current.activity.waiting) updateActivity(current, { continuing: false, resumeFailed: true });
    }, 10_000);
    void playAudio();
    try { current.client.sendClientMessage('continue-conversation', { sequence: current.sequence }); }
    catch {
      clearTimeout(current.resumeTimer);
      updateActivity(current, { continuing: false, resumeFailed: true });
    }
  }

  async function checkAvailability() {
    if (!mounted.current || disabled || sessionBlocked) return;
    if (!visible || presentation === 'landing') { onPrepare(); return; }
    if (availability.current) return;
    const controller = new AbortController();
    const version = generation.current;
    availability.current = controller;
    setCheckingAvailability(true);
    try {
      const result = await api.settings(controller.signal);
      if (!controller.signal.aborted && mounted.current && version === generation.current && sessionId === actions.current.sessionId && !actions.current.sessionBlocked) {
        actions.current.onSettings(result);
        if (result.voiceAvailable) {
          dismiss('voice:availability');
          setProblem(value => value?.id === 'voice:availability' ? null : value);
        } else setProblem(unavailable);
      }
    } catch {
      if (!controller.signal.aborted && mounted.current && version === generation.current && sessionId === actions.current.sessionId && !actions.current.sessionBlocked)
        setProblem({ id: 'voice:availability', type: 'availability', severity: 'error', duration: null,
          title: 'Could not check availability', message: 'Could not check availability. Check your connection and try again.' });
    } finally {
      if (availability.current === controller) {
        availability.current = null;
        if (mounted.current) setCheckingAvailability(false);
      }
    }
  }

  const capturing = phase === 'active' && activity.capture && !activity.muted && !activity.paused && !activity.reconnecting && !activity.waiting;
  const audible = activity.remote && activity.playing && !activity.blocked;
  const state: VoiceState = phase === 'active' ? activity.waiting ? 'paused' : activity.reconnecting ? 'reconnecting' : activity.blocked ? 'paused'
    : capturing && activity.interrupted ? 'interrupted' : activity.bot ? audible ? 'assistantSpeaking' : activity.remote ? 'paused' : 'unavailable'
    : activity.muted ? 'muted' : activity.paused ? 'paused' : !activity.capture ? 'unavailable'
    : activity.generating || activity.tool ? 'processing' : activity.user ? 'userSpeaking' : 'listening'
    : phase === 'connecting' ? activity.reconnecting ? 'reconnecting' : 'connecting'
    : phase === 'error' || sessionBlocked || settings?.voiceAvailable === false && phase === 'idle' ? 'unavailable' : phase;
  const status = { idle: checkingCall ? 'Checking for an open conversation…' : 'Ready when you are',
    connecting: activity.connected ? 'Connecting to assistant' : 'Connecting', reconnecting: 'Reconnecting',
    listening: 'Listening', userSpeaking: 'Listening to you', assistantSpeaking: 'Speaking', processing: 'Thinking', interrupted: 'Interrupted · listening',
    muted: 'Microphone muted', paused: activity.waiting ? 'Paused' : activity.blocked || activity.bot ? 'Assistant audio paused' : 'Listening paused',
    unavailable: sessionBlocked ? 'Conversation unavailable' : phase === 'error' ? 'Unable to connect' : !running ? 'Conversations unavailable'
      : activity.bot ? 'Assistant audio unavailable' : 'Microphone not connected',
    disconnected: 'Disconnected', ended: 'Conversation ended' }[state];
  const hint = phase === 'active' ? activity.waiting ? activity.resumeFailed ? 'No response yet. Try Continue again.'
    : activity.continuing ? 'Waiting for the assistant…' : activity.responseMissing ? 'The assistant did not finish a response. Continue to try again.' : 'Continue when you’re ready.' : activity.blocked || activity.reconnecting ? '' : activity.muted ? 'Unmute to speak'
    : capturing ? activity.bot && audible && !activity.interrupted ? 'Speak to interrupt' : 'Go ahead' : activity.paused ? '' : 'Reconnect your microphone'
    : phase === 'connecting' ? 'Allow microphone access if asked' : cleanupPending ? 'Your microphone is off. Confirming the call is closed.' : '';
  const orbState: VoiceOrbState = state === 'connecting' || state === 'reconnecting' ? 'connecting'
    : phase === 'active' && (activity.muted || activity.paused) || state === 'paused' || state === 'muted' ? 'muted'
      : state === 'assistantSpeaking' ? 'speaking'
        : ['listening', 'userSpeaking', 'interrupted', 'processing'].includes(state) ? 'listening' : 'idle';
  const orbVolume = orbState === 'listening' || orbState === 'speaking' ? level : 0;

  return <>
    <audio ref={audio} autoPlay muted={activity.waiting} aria-label="Assistant audio" onPause={() => {
      const current = attempt.current;
      if (current && !ending.current) updateActivity(current, { playing: false, blocked: !current.activity.waiting && current.remoteTrack?.readyState === 'live' });
    }} onPlaying={() => {
      const current = attempt.current;
      if (current?.remoteTrack && !ending.current && !current.activity.waiting && (audio.current?.srcObject as MediaStream | null)?.getTracks().includes(current.remoteTrack))
        updateActivity(current, { playing: true, blocked: false });
    }} />
    {presentation === 'landing' ? <div className="conversation-entry no-print">
      <button className="primary" disabled={disabled || !settings || sessionBlocked} onClick={onPrepare}>Start conversation</button>
    </div> : <section className="conversation card no-print" data-phase={phase} data-running={running} data-cleanup-pending={cleanupPending} aria-labelledby="conversation-heading">
      <h2 id="conversation-heading" className="sr-only">Your conversation</h2>
      <header className="call-header">
        <div className="voice-status-panel" data-capturing={capturing}>
          <div className="call-orb" role="img" aria-label={status} data-state={state} data-volume={orbVolume}>
            {visible && <VoiceOrb state={orbState} volume={orbVolume} variant="emerald" />}
          </div>
          <div className="voice-status-copy">
            <p className="voice-status" role="status">{status}</p>
            <p className="voice-status-hint" aria-live={activity.waiting ? 'polite' : 'off'}>{hint}</p>
          </div>
        </div>
        <div className="conversation-controls">
          {phase === 'active' && activity.waiting && <button type="button" className="call-control primary" disabled={disabled || activity.continuing || activity.reconnecting}
            aria-label="Continue" aria-busy={activity.continuing} title="Continue conversation" onClick={continueConversation}><CallIcon kind="play" /></button>}
          {phase === 'active' && !activity.waiting && <button type="button" className="call-control" onClick={toggleMic} aria-pressed={activity.muted}
            aria-label={activity.muted ? 'Unmute microphone' : 'Mute microphone'} title={activity.muted ? 'Unmute microphone' : 'Mute microphone'}>
            <CallIcon kind="microphone" muted={activity.muted} />
          </button>}
          {running || needsEnd ? <button type="button" className="call-control call-end danger" disabled={cleanupPending} onClick={() => void finish('ended')}
            aria-busy={cleanupPending}
            aria-label={needsEnd && !running ? 'Retry ending call' : 'End conversation'} title={needsEnd && !running ? 'Retry ending call' : 'End conversation'}>
            <CallIcon kind="end" />
          </button>
            : <button type="button" className="call-control primary" disabled={startBlocked} aria-busy={cleanupPending} onClick={() => void start()}
              aria-label={phase === 'ended' || phase === 'disconnected' || phase === 'error' ? 'Reconnect' : 'Start talking'}
              title={phase === 'ended' || phase === 'disconnected' || phase === 'error' ? 'Reconnect' : 'Start talking'}>
              <CallIcon kind={phase === 'ended' || phase === 'disconnected' || phase === 'error' ? 'retry' : 'call'} />
            </button>}
          {activity.blocked && <button type="button" className="call-control" disabled={disabled} aria-label="Resume audio" title="Resume audio" onClick={() => void playAudio()}><CallIcon kind="audio" /></button>}
          {!running && !sessionBlocked && settings?.voiceAvailable === false &&
            <button type="button" className="call-control" disabled={checkingAvailability || disabled} aria-busy={checkingAvailability} aria-label={checkingAvailability ? 'Checking availability…' : 'Check availability'} title="Check availability" onClick={() => void checkAvailability()}><CallIcon kind="retry" /></button>}
        </div>
      </header>
      <LiveCaption captions={captions} interim={interim} timezone={settings?.timezone} assistantName={settings?.assistantName} />
    </section>}
  </>;
}