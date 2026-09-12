// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { ReactNode } from 'react';

// Pagination bounds mobile page length; desktop lists also retain their own scroll region.
export function PagedList({ children, label, className, ordered = false, printable = true, pageSize = 20 }: {
  children: ReactNode[]; label: string; className: string; ordered?: boolean;
  printable?: boolean; pageSize?: number;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(children.length / pageSize));
  const current = Math.min(page, pages - 1);
  const List = ordered ? 'ol' : 'ul';
  return <>
    <List className={`${className} scroll-region`} aria-label={label} tabIndex={children.length ? 0 : undefined}
      start={ordered ? current * pageSize + 1 : undefined}>
      {children.slice(current * pageSize, (current + 1) * pageSize)}
    </List>
    {pages > 1 && <nav className="pagination no-print" aria-label={`${label} pages`}>
      <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
      <span role="status">Page {current + 1} of {pages}</span>
      <button type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Next</button>
    </nav>}
    {pages > 1 && printable && <List className={`${className} print-only`}>{children}</List>}
  </>;
}