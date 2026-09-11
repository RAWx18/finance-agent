// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import './voiceCircle.css';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'userSpeaking' | 'assistantSpeaking'
  | 'processing' | 'interrupted' | 'reconnecting' | 'muted' | 'paused' | 'unavailable' | 'disconnected' | 'ended' | 'ending';

const appearance: Record<VoiceState, {
  radius: number;
  motion: 'none' | 'orbit' | 'breath' | 'settle' | 'unavailable' | 'disconnected';
  mark?: string;
}> = {
  idle: { radius: 34, motion: 'none' },
  connecting: { radius: 34, motion: 'orbit' },
  listening: { radius: 43, motion: 'none' },
  userSpeaking: { radius: 43, motion: 'none' },
  assistantSpeaking: { radius: 43, motion: 'none' },
  processing: { radius: 34, motion: 'breath' },
  interrupted: { radius: 41, motion: 'none' },
  reconnecting: { radius: 30, motion: 'orbit' },
  muted: { radius: 40, motion: 'none', mark: 'M 70 90 L 90 70' },
  paused: { radius: 38, motion: 'none', mark: 'M 74 73 L 74 87 M 86 73 L 86 87' },
  unavailable: { radius: 34, motion: 'unavailable', mark: 'M 75 75 L 85 85 M 85 75 L 75 85' },
  disconnected: { radius: 34, motion: 'disconnected', mark: 'M 69 80 L 75 80 M 85 80 L 91 80' },
  ended: { radius: 26, motion: 'none', mark: 'M 73 80 L 87 80' },
  ending: { radius: 30, motion: 'settle' },
};

function loop(radius: number, energy: number, assistant: boolean): string {
  const x = radius * (assistant ? 1 : .96) * (1 + energy * (assistant ? .07 : .04));
  const y = radius * (assistant ? .92 : 1) * (1 + energy * (assistant ? .04 : .07));
  const bend = radius * (assistant ? -.025 : .025) * (1 + energy);
  return `M 80 ${80 - y}
    C ${80 + x * .56 + bend} ${80 - y} ${80 + x} ${80 - y * .54} ${80 + x} 80
    C ${80 + x} ${80 + y * .56 + bend} ${80 + x * .54} ${80 + y} 80 ${80 + y}
    C ${80 - x * .56 + bend} ${80 + y} ${80 - x} ${80 + y * .54} ${80 - x} 80
    C ${80 - x} ${80 - y * .56 + bend} ${80 - x * .54} ${80 - y} 80 ${80 - y} Z`;
}

export function VoiceCircle({ state, level, label }: { state: VoiceState; level: number; label: string }) {
  const assistant = state === 'assistantSpeaking';
  const speaking = state === 'userSpeaking' || assistant || state === 'interrupted';
  const energy = speaking && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const { radius, motion, mark } = appearance[state];

  return <div className="voice-circle" data-state={state} data-energy={energy} data-motion={motion} role="img" aria-label={label}>
    <svg viewBox="0 0 160 160" width="160" height="160" aria-hidden="true" focusable="false">
      <g className="voice-circle-body">
        {/* Static geometry prevents audio levels from morphing the reduced-motion view. */}
        {['live', 'still'].map(mode => {
          const amount = mode === 'live' ? energy : 0;
          return <g key={mode} className={`voice-circle-${mode}`} transform={`rotate(${amount * (assistant ? -4 : 4)} 80 80)`}>
            <path className="voice-circle-shell" d={loop(66, amount, assistant)} pathLength="100" fill={assistant ? 'none' : 'currentColor'} />
            <path className="voice-circle-ring" d={loop(56, amount, assistant)} pathLength="100" fill="none" />
            <path className="voice-circle-core" d={loop(radius, amount, assistant)} fill="currentColor" />
          </g>;
        })}
      </g>
      <g className="voice-circle-arc"><circle cx="80" cy="80" r="73" pathLength="100" /></g>
      <path className="voice-circle-mark" d={mark ?? ''} />
    </svg>
  </div>;
}