// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

export function Recovery({ title, message, children, busy = false, inline = false }: {
  title: string; message: string; children?: ReactNode; busy?: boolean; inline?: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const Heading = inline ? 'h2' : 'h1';
  useEffect(() => {
    if (!inline) heading.current?.focus({ preventScroll: true });
  }, [title, inline]);

  return <section className={`recovery${inline ? ' recovery-inline' : ''}`} aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-message`} aria-busy={busy}>
    <span className="recovery-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M7 18H6a4 4 0 0 1-.5-8 6.5 6.5 0 0 1 12.8-1A4.5 4.5 0 0 1 18 18h-1M10 15v5m4-5v5" />
    </svg></span>
    <div className="recovery-copy" role={inline ? 'status' : undefined} aria-atomic={inline || undefined}>
      <Heading id={`${id}-title`} ref={heading} tabIndex={inline ? undefined : -1}>{title}</Heading>
      <p id={`${id}-message`}>{message}</p>
    </div>
    {children && <div className="recovery-actions">{children}</div>}
  </section>;
}