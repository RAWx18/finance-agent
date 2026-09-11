// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { DeviceError, PipecatClient, RTVIEvent } from '@pipecat-ai/client-js';
import { DailyTransport } from '@pipecat-ai/daily-transport';
import { api, ApiError, authEpoch } from './api';
import type { CallJoin, Settings, Snapshot } from './api';
import { Captions } from './Captions';
import type { Caption } from './Captions';
import { Details } from './Dialog';
import { dismiss, notify } from './Toast';
import type { Notice } from './Toast';
import { VoiceCircle } from './VoiceCircle';
import type { VoiceState } from './VoiceCircle';

export type VoicePhase = 'idle' | 'connecting' | 'active' | 'ending' | 'ended' | 'disconnected' | 'error';
type Release = 'ended' | 'error' | 'unconfirmed';
type Problem = Omit<Notice, 'action'> & { type: 'retry' | 'reconnect' | 'availability' | 'end' | 'session' };
const notices = ['voice:problem', 'voice:audio', 'voice:availability', 'voice:previous'];
const unavailable: Problem = { id: 'voice:availability', type: 'availability', title: 'Conversations unavailable', severity: 'error', duration: null,
  message: 'Conversations are temporarily unavailable. Try again shortly.' };
const quiet = { user: false, bot: false, generating: false, tool: false, muted: false, paused: false,
  capture: false, interrupted: false, connected: false, reconnecting: false, remote: false, playing: false, blocked: false };
type Attempt = {
  client: PipecatClient; cancelled: boolean; ready: boolean; activity: typeof quiet;
  authEpoch: number;
  sessionId?: string; parentSession?: string;
  devices?: Promise<void>; join?: Promise<CallJoin>; cleanup?: Promise<Release>;
  tracks: Set<MediaStreamTrack>;
  observers: Map<MediaStreamTrack, () => void>;
  localTrack?: MediaStreamTrack; remoteTrack?: MediaStreamTrack; remoteId?: string; botId?: string;
  level: number; levelAt?: number; meter?: ReturnType<typeof setTimeout>;
  onPageHide: () => void;
};

async function releaseCall(epoch = authEpoch()): Promise<Release> {
  if (epoch !== authEpoch()) return 'unconfirmed';
  try {
    const call = await api.endCall();
    return call.status === 'idle' || call.status === 'ended' ? 'ended' : call.status === 'error' ? 'error' : 'unconfirmed';
  } catch { return 'unconfirmed'; }
}

// Room creation can finish after cancellation; release it before allowing another start.
function dispose(attempt: Attempt): Promise<Release> {
  if (attempt.cleanup) return attempt.cleanup;
  attempt.cancelled = true;
  clearTimeout(attempt.meter);
  window.removeEventListener('pagehide', attempt.onPageHide);
  for (const [track, observer] of attempt.observers) {
    for (const event of ['mute', 'unmute', 'ended']) track.removeEventListener?.(event, observer);
  }
  const stopTracks = () => {
    try {
      for (const track of Object.values(attempt.client.tracks().local)) if (track) attempt.tracks.add(track);
    } catch { /* Failed device setup can leave SDK track access unavailable. */ }
    for (const track of attempt.tracks) track.stop();
  };
  stopTracks();
  attempt.cleanup = (async () => {
    await attempt.devices?.catch(() => undefined);
    stopTracks();
    // Pipecat owns Daily's lifecycle; leave after device setup to release late capture and observers.
    try { await attempt.client.disconnect(); } catch { /* Teardown must not mask the original failure or prevent room release. */ }
    if (!attempt.join) return 'ended';
    try { await attempt.join; }
    catch (error) { if (error instanceof ApiError && error.status < 500) return error.status === 409 ? 'unconfirmed' : 'ended'; }
    return releaseCall(attempt.authEpoch);
  })();
  return attempt.cleanup;
}

function callError(error: unknown): Problem {
  if ((error instanceof DOMException && error.name === 'NotAllowedError') || (error instanceof DeviceError && error.type === 'permissions'))
    return { id: 'voice:problem', type: 'retry', title: 'Microphone access denied', severity: 'warning', duration: null,
      message: 'Microphone access was denied. Allow microphone access in your browser’s site settings, then try again.' };
  if ((error instanceof DOMException && error.name === 'NotFoundError') || (error instanceof DeviceError && error.type === 'not-found'))
    return { id: 'voice:problem', type: 'retry', title: 'No microphone found', severity: 'error', duration: null,
      message: 'No microphone was found. Connect a microphone, then try again.' };
  if ((error instanceof DOMException && error.name === 'NotReadableError') || (error instanceof DeviceError && error.type === 'in-use'))
    return { id: 'voice:problem', type: 'retry', title: 'Microphone in use', severity: 'error', duration: null,
      message: 'Your microphone is in use. Close other calling apps, then try again.' };
  if (error instanceof DeviceError && error.type === 'undefined-mediadevices')
    return { id: 'voice:problem', type: 'retry', title: 'Microphone unavailable', severity: 'error', duration: null,
      message: 'Microphone access is unavailable in this browser. Open this page in a current browser, then try again.' };
  if (error instanceof ApiError && (error.status === 401 || error.status === 403))
    return { id: 'voice:problem', type: 'session', title: 'Sign-in required', severity: 'error', duration: null, dismissible: false,
      message: 'Your sign-in could not be verified. Reload the page and sign in again to continue.' };
  if (error instanceof ApiError && (error.status === 404 || error.status === 410))
    return { id: 'voice:problem', type: 'session', title: error.status === 410 ? 'Conversation expired' : 'Conversation unavailable',
      severity: 'error', duration: null, dismissible: false,
      message: 'This conversation is no longer available. Reload the page to check your session before starting again.' };
  if (error instanceof ApiError && error.status === 409)
    return { id: 'voice:previous', type: 'end', title: 'A conversation is still open', severity: 'critical', duration: null,
      message: 'Another conversation is still open. End it before connecting here.' };
  if (error instanceof ApiError && error.status === 503) return unavailable;
  if (error instanceof TypeError || !navigator.onLine)
    return { id: 'voice:problem', type: 'reconnect', title: 'Connection lost', severity: 'error', duration: null,
      message: 'The audio connection closed. Check your internet connection, then reconnect.' };
  return { id: 'voice:problem', type: 'retry', title: 'Could not connect', severity: 'error', duration: null,
    message: 'The conversation could not connect. Check your connection and microphone, then try again.' };
}

function audioSource(current: Attempt): 'local' | 'remote' | undefined {
  if (!current.ready || current.cancelled || current.activity.reconnecting) return;
  const { activity, localTrack, remoteTrack } = current;
  if (activity.user && activity.capture && !activity.paused && !activity.muted && current.client.isMicEnabled
    && localTrack?.readyState === 'live' && !localTrack.muted && localTrack.enabled !== false) return 'local';
  if (activity.bot && activity.remote && activity.playing && !activity.blocked
    && remoteTrack?.readyState === 'live' && !remoteTrack.muted && remoteTrack.enabled !== false) return 'remote';
}

export function Conversation({ settings, sessionId, disabled, onStarted, onBusyChange, presentation, onPrepare, onPhaseChange, onSettings, visible = true, sessionIssue, updatesLost = false }: {
  settings: Settings | null; sessionId?: string; disabled: boolean;
  onStarted: (snapshot: Snapshot) => void; onBusyChange: (busy: boolean) => void;
  presentation: 'landing' | 'ready' | 'session'; onPrepare: () => void;
  onPhaseChange: (phase: VoicePhase) => void; onSettings: (settings: Settings) => void;
  visible?: boolean; sessionIssue?: 'expired' | 'deleted' | 'unreadable' | 'unauthorized';
  updatesLost?: boolean;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [activity, setActivity] = useState(quiet);
  const [level, setLevel] = useState(0);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [interim, setInterim] = useState<{ text: string; time: number } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [endIssue, setEndIssue] = useState<'open' | 'unconfirmed' | null>(null);
  const [checkedSession, setCheckedSession] = useState<string>();
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const attempt = useRef<Attempt | null>(null);
  const mounted = useRef(false);
  const captionId = useRef(0);
  const interimTime = useRef<number | null>(null);
  const generation = useRef(0);
  const ending = useRef(false);
  const availability = useRef<AbortController | null>(null);
  const sessionBlocked = !!sessionIssue || problem?.type === 'session';
  const needsEnd = endIssue !== null && !sessionBlocked;
  const running = phase === 'connecting' || phase === 'active' || phase === 'ending';
  const checkingCall = !!sessionId && !sessionBlocked && checkedSession !== sessionId;
  const busy = running || needsEnd || checkingCall;
  const startBlocked = disabled || updatesLost || sessionBlocked || !settings?.voiceAvailable || running || needsEnd || checkingCall;
  const actions = useRef({ start, finish, playAudio, checkAvailability, onStarted, onSettings, sessionBlocked, sessionId });
  const notifyPhase = useEffectEvent(onPhaseChange);
  const notifyBusy = useEffectEvent(onBusyChange);

  useLayoutEffect(() => { actions.current = { start, finish, playAudio, checkAvailability, onStarted, onSettings, sessionBlocked, sessionId }; });
  useEffect(() => { notifyPhase(phase); }, [phase]);
  useEffect(() => { notifyBusy(busy); }, [busy]);

  useEffect(() => {
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
    setCheckingAvailability(false);
    if (sessionIssue) {
      dismiss('voice:problem'); dismiss('voice:availability'); dismiss('voice:audio');
      setProblem(null);
    } else setProblem(value => value?.type === 'session' ? null : value);
    if (current && (sessionIssue || updatesLost || sessionId !== current.parentSession && sessionId !== current.sessionId))
      void actions.current.finish('error', updatesLost && !sessionIssue ? { id: 'voice:problem', type: 'reconnect', title: 'Conversation stopped',
        severity: 'warning', duration: null, message: 'Financial updates were interrupted. Microphone and assistant audio are off. Restore updates, then reconnect.' } : undefined);
  });
  useLayoutEffect(() => { stopUnavailable(); }, [sessionIssue, sessionId, updatesLost]);

  useEffect(() => {
    if (!problem || sessionIssue) { dismiss('voice:problem'); return; }
    notify({ ...problem, action: problem.type === 'session' ? undefined : problem.type === 'availability'
      ? { label: 'Check availability', disabled: checkingAvailability || disabled, onClick: () => actions.current.checkAvailability() }
      : { label: problem.type === 'reconnect' ? 'Reconnect' : 'Retry', disabled: startBlocked, onClick: () => actions.current.start() } });
  }, [problem, sessionIssue, startBlocked, checkingAvailability, disabled]);

  useEffect(() => {
    if (!endIssue || sessionBlocked) { dismiss('voice:previous'); return; }
    notify({ id: 'voice:previous', title: endIssue === 'open' ? 'A conversation is still open' : 'Call ending not confirmed',
      message: endIssue === 'open' ? 'Another conversation is still open. End it before connecting here.'
        : 'Microphone off. We couldn’t confirm the call ended. Retry ending it before starting again.',
      severity: 'critical', duration: null, dismissible: false,
      action: { label: 'Retry ending call', disabled: phase === 'ending', onClick: () => actions.current.finish('ended') } });
  }, [endIssue, phase, sessionBlocked]);

  useEffect(() => {
    if (!activity.blocked || sessionBlocked) { dismiss('voice:audio'); return; }
    notify({ id: 'voice:audio', title: 'Assistant audio paused', severity: 'warning', duration: null,
      message: 'Your browser paused playback. Resume audio to hear the assistant.',
      action: { label: 'Resume audio', disabled, onClick: () => actions.current.playAudio() } });
  }, [activity, sessionBlocked, disabled]);

  const available = useEffectEvent(() => {
    if (settings?.voiceAvailable) {
      dismiss('voice:availability');
      setProblem(value => value?.id === 'voice:availability' ? null : value);
    }
  });
  useEffect(() => { available(); }, [settings?.voiceAvailable]);

  useEffect(() => {
    if (!sessionId || sessionIssue) return;
    if (attempt.current) { setCheckedSession(sessionId); return; }
    const controller = new AbortController();
    const version = generation.current;
    void api.call(controller.signal).then((call) => {
      if (controller.signal.aborted || attempt.current || version !== generation.current) return;
      const open = call.status === 'active' || call.status === 'connecting';
      setCheckedSession(sessionId);
      setEndIssue(open ? 'open' : null);
      if (call.status === 'error' && !actions.current.sessionBlocked) setProblem({ id: 'voice:problem', type: 'retry', severity: 'info', duration: 6000,
        title: 'Previous conversation stopped', message: 'The previous conversation stopped with an error. You can try a new conversation.' });
    }).catch((error) => {
      if (!controller.signal.aborted && !attempt.current && version === generation.current) {
        setCheckedSession(sessionId);
        const issue = callError(error);
        setEndIssue(issue.type === 'session' ? null : 'unconfirmed');
        if (issue.type === 'session') setProblem(issue);
      }
    });
    return () => controller.abort();
  }, [sessionId, sessionIssue]);

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
    generation.current += 1;
    setPhase('ending');
    setInterim(null); interimTime.current = null;
    setCaptions((items) => items.map((item) => item.pending ? { ...item, pending: false, interrupted: true } : item));
    if (current) resetLevel(current);
    setActivity(quiet);
    dismiss('voice:audio');
    audio.current?.pause();
    if (audio.current) audio.current.srcObject = null;
    const released = current ? await dispose(current) : await releaseCall();
    if (!mounted.current || attempt.current !== current) return;
    attempt.current = null;
    ending.current = false;
    setEndIssue(released === 'unconfirmed' ? issue?.type === 'end' || endIssue === 'open' ? 'open' : 'unconfirmed' : null);
    setPhase(released === 'ended' ? next : 'error');
    if (issue && issue.type !== 'end' && !actions.current.sessionBlocked) setProblem(issue);
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
    try {
      await player.play();
      if (mounted.current && attempt.current === current && !current.cancelled && player.srcObject === stream) {
        updateActivity(current, { playing: true, blocked: false }); dismiss('voice:audio');
      }
    } catch {
      if (player.srcObject === stream) updateActivity(current, { playing: false, blocked: true });
    }
  }

  async function start() {
    if (!mounted.current || disabled || sessionBlocked) return;
    if (!visible || presentation === 'landing') { onPrepare(); return; }
    if (attempt.current || ending.current || startBlocked) return;
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
      const transport = new DailyTransport({ bufferLocalAudioUntilBotReady: false, dailyConfig: { avoidEval: true } });
      const live = () => mounted.current && current !== null && attempt.current === current && !current.cancelled && !actions.current.sessionBlocked;
      const update = (patch: Partial<typeof quiet>) => { if (live() && current) updateActivity(current, patch); };
      const tools = new Set<string>();
      const unfinished = new Set<string>();
      let spokenId: string | undefined;
      const updateTracks = () => {
        if (!live() || !current) return;
        const { localTrack, remoteTrack } = current;
        if (localTrack?.readyState === 'ended') { microphoneLost(); return; }
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
      const client = new PipecatClient({ transport, enableMic: true, enableCam: false, callbacks: {
        onConnected: () => update({ connected: true, reconnecting: current?.ready ? false : current?.activity.reconnecting ?? false }),
        onBotReady: () => { if (live() && current) { current.ready = true; setPhase('active'); update({ reconnecting: false }); updateTracks(); } },
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
          if (state === 'connecting' && current?.ready) update({ reconnecting: true, connected: false, user: false, bot: false, interrupted: false });
          if (state === 'ready' && current?.ready) update({ reconnecting: false });
          if (state === 'error') fail(callError(new TypeError()));
          if (state === 'disconnected') disconnected();
        },
        onDisconnected: disconnected,
        onBotDisconnected: disconnected,
        onError: () => fail({ ...callError(undefined), title: 'Conversation stopped', message: 'The assistant could not continue. Check your connection and try again.' }),
        onDeviceError: (error) => fail(callError(error)),
        onLocalAudioLevel: (value) => { if (current) measure(current, 'local', value); },
        onRemoteAudioLevel: (value, participant) => {
          if (current && !participant.local && participant.id === current.remoteId) measure(current, 'remote', value);
        },
        onUserStartedSpeaking: () => {
          if (!live() || !current?.ready || current.activity.reconnecting) return;
          update({ user: true, interrupted: current.activity.bot, generating: false });
          // SDK completions can arrive before React applies the caption update.
          const interrupted = new Set(unfinished);
          setCaptions((items) => items.map((item) => item.pending || interrupted.has(item.id) ? { ...item, pending: false, interrupted: true } : item));
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
        onLLMFunctionCallInProgress: (data) => { tools.add(data.tool_call_id); update({ tool: true }); },
        onLLMFunctionCallStopped: (data) => { tools.delete(data.tool_call_id); update({ tool: tools.size > 0 }); },
        onUserMuteStarted: () => update({ paused: true, user: false, interrupted: false }),
        onUserMuteStopped: () => update({ paused: false }),
        onUserTranscript: (data) => {
          if (!live()) return;
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
          if (!live() || data.will_be_spoken === false) return;
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
      current = { client, cancelled: false, ready: false, activity, authEpoch: authEpoch(), sessionId, parentSession: sessionId, tracks: new Set(), observers: new Map(), level: 0, onPageHide: () => {
        if (live()) void actions.current.finish('disconnected', callError(new TypeError()));
      } };
      attempt.current = current;
      window.addEventListener('pagehide', current.onPageHide);
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
        current?.tracks.delete(track);
        if (participant?.local && current?.localTrack === track) { microphoneLost(); return; }
        if (current?.remoteTrack === track) { current.remoteTrack = undefined; current.remoteId = undefined; }
        updateTracks();
        const stream = audio.current?.srcObject as MediaStream | null;
        if (stream?.getTracks().includes(track) && audio.current) {
          audio.current.pause(); audio.current.srcObject = null; update({ playing: false, blocked: false });
        }
      });
      // Device permission starts directly in the click handler, before any room request.
      current.devices = current.client.initDevices();
      await current.devices;
      if (!live()) return;
      current.localTrack = current.client.tracks().local.audio ?? current.localTrack;
      if (current.localTrack) { current.tracks.add(current.localTrack); observe(current.localTrack); }
      updateTracks();
      const saved = await api.start();
      if (!live()) return;
      current.sessionId = saved.sessionId;
      actions.current.onStarted(saved);
      if (!live()) return;
      current.join = api.startCall();
      const join = await current.join;
      if (!live()) return;
      await current.client.connect({ url: join.url, token: join.token });
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
    if (!current || current.cancelled || phase !== 'active' || sessionBlocked) return;
    try {
      current.client.enableMic(!current.client.isMicEnabled);
      updateActivity(current, { muted: !current.client.isMicEnabled, user: false, interrupted: false });
    } catch {
      void finish('error', { ...callError(undefined), title: 'Microphone unavailable',
        message: 'The microphone could not be changed. The call has been stopped; check microphone access before trying again.' });
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

  const capturing = phase === 'active' && activity.capture && !activity.muted && !activity.paused && !activity.reconnecting;
  const audible = activity.remote && activity.playing && !activity.blocked;
  const state: VoiceState = phase === 'active' ? activity.reconnecting ? 'reconnecting' : activity.blocked ? 'paused'
    : capturing && activity.interrupted ? 'interrupted' : activity.bot ? audible ? 'assistantSpeaking' : activity.remote ? 'paused' : 'unavailable'
    : activity.muted ? 'muted' : activity.paused ? 'paused' : !activity.capture ? 'unavailable'
    : activity.generating || activity.tool ? 'processing' : activity.user ? 'userSpeaking' : 'listening'
    : phase === 'connecting' ? activity.reconnecting ? 'reconnecting' : 'connecting'
    : phase === 'error' || sessionBlocked || settings?.voiceAvailable === false && phase === 'idle' ? 'unavailable' : phase;
  const status = { idle: checkingCall ? 'Checking for an open conversation…' : 'Ready when you are',
    connecting: activity.connected ? 'Connecting to assistant' : 'Connecting', reconnecting: 'Reconnecting',
    listening: 'Listening', userSpeaking: 'Listening to you', assistantSpeaking: 'Speaking', processing: 'Thinking', interrupted: 'Interrupted · listening',
    muted: 'Microphone muted', paused: activity.blocked || activity.bot ? 'Assistant audio paused' : 'Listening paused',
    unavailable: sessionBlocked ? 'Conversation unavailable' : phase === 'error' ? 'Unable to connect' : !running ? 'Conversations unavailable'
      : activity.bot ? 'Assistant audio unavailable' : 'Microphone not connected',
    disconnected: 'Disconnected', ended: 'Conversation ended', ending: 'Ending…' }[state];
  const hint = phase === 'active' ? activity.blocked || activity.reconnecting ? '' : activity.muted ? 'Unmute to speak'
    : capturing ? activity.bot && audible && !activity.interrupted ? 'Speak to interrupt' : 'Go ahead' : activity.paused ? '' : 'Reconnect your microphone'
    : phase === 'connecting' ? 'Allow microphone access if asked' : '';

  return <>
    <audio ref={audio} autoPlay aria-label="Assistant audio" onPause={() => {
      const current = attempt.current;
      if (current && !ending.current) updateActivity(current, { playing: false, blocked: current.remoteTrack?.readyState === 'live' });
    }} onPlaying={() => {
      const current = attempt.current;
      if (current?.remoteTrack && !ending.current && (audio.current?.srcObject as MediaStream | null)?.getTracks().includes(current.remoteTrack))
        updateActivity(current, { playing: true, blocked: false });
    }} />
    {presentation === 'landing' ? <div className="conversation-entry no-print">
      <button className="primary" disabled={disabled || !settings || sessionBlocked} onClick={onPrepare}>Start conversation</button>
    </div> : <section className="conversation card no-print" data-phase={phase} data-running={running} aria-labelledby="conversation-heading">
      <div className="conversation-heading"><h2 id="conversation-heading">Your conversation</h2></div>
      <div className="conversation-circle-panel"><div className="voice-status-panel" data-capturing={capturing}>
        <VoiceCircle state={state} level={level} label={status} />
        <p className="voice-status" role="status">{status}</p>
        <p className="voice-status-hint">{hint}</p>
        {phase === 'active' && activity.connected && !activity.reconnecting && <span className="voice-connection">Connected</span>}
      </div></div>
      <div className="conversation-controls">
        {phase === 'active' && <button onClick={toggleMic} aria-pressed={activity.muted}>{activity.muted ? 'Unmute microphone' : 'Mute microphone'}</button>}
        {running || needsEnd ? <button className="danger" disabled={phase === 'ending'} onClick={() => void finish('ended')}>{needsEnd && !running ? 'Retry ending call' : 'End conversation'}</button>
          : <button className="primary" disabled={startBlocked} onClick={() => void start()}>{phase === 'ended' || phase === 'disconnected' || phase === 'error' ? 'Reconnect' : 'Start talking'}</button>}
        {activity.blocked && <button disabled={disabled} onClick={() => void playAudio()}>Resume audio</button>}
        {!running && !sessionBlocked && (settings?.voiceAvailable === false || phase === 'error') &&
          <button disabled={checkingAvailability || disabled} onClick={() => void checkAvailability()}>{checkingAvailability ? 'Checking availability…' : 'Check availability'}</button>}
      </div>
      <Captions captions={captions} interim={interim} timezone={settings?.timezone} />
      <footer className="voice-more"><Details label="Privacy">
        <p>Audio and words are processed to prepare your plan. Avoid account numbers, passwords and card details.</p>
        <p>{settings && `Figures kept ${settings.retentionHours} hours; `}captions only this visit.</p>
      </Details></footer>
    </section>}
  </>;
}