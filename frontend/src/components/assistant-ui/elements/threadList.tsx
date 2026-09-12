// SPDX-FileCopyrightText: AgentbaseAI Inc.
// SPDX-License-Identifier: MIT
import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import { clsx } from 'clsx';

export interface ThreadItem {
  id: string;
  title: string;
  time: string;
  href: string;
}

export function ThreadList({ threads, activeIndex, className, ...props }: Omit<ComponentProps<'div'>, 'children'> & {
  threads: readonly ThreadItem[];
  activeIndex: number;
}) {
  return <div data-slot="thread-list" className={clsx('aui-thread-list', className)} {...props}>
    {threads.map((thread, index) => {
      const active = index === activeIndex;
      return <Link key={thread.id} to={thread.href} aria-current={active ? 'page' : undefined}
        className={clsx('aui-thread-item', active && 'aui-thread-active')} title={thread.title}>
        <span className="aui-thread-title">{thread.title}</span>
        <span className="aui-thread-time">{thread.time}</span>
      </Link>;
    })}
  </div>;
}