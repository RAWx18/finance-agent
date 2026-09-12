// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { api, authEpoch } from './api';
import { notify } from './Toast';
import { MoneyIcon } from './MoneyIcon';

export function Download({ label, primary = false, compact = false }: { label: string; primary?: boolean; compact?: boolean }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  return <a className={`button${primary ? ' primary' : ''}${compact ? ' icon-button' : ''}`} href="/api/session/export" download aria-label={compact ? busy ? 'Preparing download' : label : undefined} title={compact ? label : undefined} aria-disabled={busy} onClick={async event => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const epoch = authEpoch();
    try {
      const text = await api.export();
      if (epoch !== authEpoch()) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'cashflow.txt'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      if (epoch === authEpoch()) notify({ id: 'plan:download', severity: 'error', title: 'Download unavailable', message: 'Your plan could not be downloaded. Check your connection and try again.' });
    } finally { pending.current = false; setBusy(false); }
  }}>{compact ? <MoneyIcon name="download" /> : busy ? 'Preparing download…' : label}</a>;
}