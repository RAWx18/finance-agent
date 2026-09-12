// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useAuth } from './Auth';

/** Present account identity, settings, and sign-out in a keyboard-accessible menu. */
export function ProfileMenu() {
  const auth = useAuth();
  const location = useLocation();
  const user = auth.session!.user;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initial = useRef(0);
  const id = useId();

  useLayoutEffect(() => {
    if (open) menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[initial.current]?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  return <div ref={root} className="profile-menu no-print" onKeyDown={event => {
    if (!open || !['Escape', 'Tab'].includes(event.key)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }}>
    <button ref={trigger} type="button" className="profile-trigger" aria-label="Profile menu" title="Profile menu"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { initial.current = 0; setOpen(value => !value); }} onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        initial.current = event.key === 'ArrowUp' ? 1 : 0;
        setOpen(true);
      }}>
      <svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" />
      </svg>
    </button>
    {open && <div className="profile-dropdown">
      <div className="profile-identity"><strong title={user.displayName}>{user.displayName}</strong><span title={user.email}>{user.email}</span></div>
      <div ref={menu} id={id} role="menu" aria-label="Profile" onKeyDown={event => {
        if (event.key === ' ' && event.target instanceof HTMLAnchorElement) {
          event.preventDefault(); event.target.click(); return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
        <Link role="menuitem" tabIndex={-1} to="/account" aria-current={location.pathname === '/account' ? 'page' : undefined}
          onClick={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}>Settings</Link>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); void auth.logout(); }}>Sign out</button>
      </div>
    </div>}
  </div>;
}