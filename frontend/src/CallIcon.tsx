// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
const paths = {
  call: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2Z',
  end: 'M3 15v-4c5-4 13-4 18 0v4l-5-1v-3M8 11v3l-5 1',
  microphone: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Z M5 10v1a7 7 0 0 0 14 0v-1 M12 18v3 M9 21h6',
  retry: 'M20 7v5h-5 M20 12a8 8 0 1 0-2 5',
  play: 'm9 5 11 7-11 7V5Z',
  audio: 'M11 5 6 9H3v6h3l5 4V5Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14',
};

export function CallIcon({ kind, muted = false }: { kind: keyof typeof paths; muted?: boolean }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={paths[kind]} />{muted && <path d="m3 3 18 18" />}
  </svg>;
}