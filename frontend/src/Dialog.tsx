// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { registerToastHost } from './Toast';
import { MoneyIcon } from './MoneyIcon';

/** Present a modal with keyboard focus management and in-dialog notifications. */
export function Dialog({ open, title, onClose, children, wide = false, actions }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean; actions?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    const unregister = registerToastHost(element);
    // Native bubbling includes controls portaled from outside the dialog's React tree.
    /** Keep keyboard navigation within the active dialog. */
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !(event.target instanceof HTMLElement) || event.target.closest('dialog') !== element) return;
      const controls = [...element.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
        .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0 && control.closest('dialog') === element);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? event.shiftKey ? controls.length - 1 : 0 : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      event.preventDefault();
      (controls[next] ?? heading.current)?.focus();
    };
    element.addEventListener('keydown', trapFocus);
    element.addEventListener('close', unregister);
    heading.current?.focus({ preventScroll: true });
    return () => {
      element.removeEventListener('keydown', trapFocus);
      element.removeEventListener('close', unregister);
      unregister();
      element.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  return <dialog ref={dialog} className={`dialog${wide ? ' dialog-wide' : ''}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header className="dialog-heading"><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>
      <button type="button" className="icon-button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} title="Close"><MoneyIcon name="close" /></button>
    </header>
    <div className="dialog-body" tabIndex={0}>{children}</div>
    {actions && <div className="dialog-actions">{actions}</div>}
  </dialog>;
}

/** Expose supplementary content through a labeled dialog trigger. */
export function Details({ label, title = label, children, wide = false, compact = false }: {
  label: string; title?: string; children: ReactNode; wide?: boolean; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={compact ? 'icon-button' : 'detail-button'} aria-label={compact ? label : undefined} title={compact ? label : undefined} aria-haspopup="dialog" onClick={() => setOpen(true)}>{compact ? <MoneyIcon name="expand" /> : label}</button>
    <Dialog open={open} title={title} onClose={() => setOpen(false)} wide={wide}>{children}</Dialog>
  </>;
}