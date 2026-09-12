// SPDX-FileCopyrightText: AgentbaseAI Inc.
// SPDX-License-Identifier: MIT
import type { ComponentProps } from 'react';
import { clsx } from 'clsx';

export interface DatedMessage {
  id: string;
  day: string;
  time: string;
  dateTime: string;
  role: 'user' | 'assistant';
  text: string;
  interrupted: boolean;
}

/** Render dated messages with day dividers, speaker labels and partial-caption notices. */
export function DaySeparator({ messages, assistantName, className, ...props }: Omit<ComponentProps<'div'>, 'children'> & {
  messages: readonly DatedMessage[];
  assistantName: string;
}) {
  return <div data-slot="day-separator" className={clsx('aui-dated-messages', className)} {...props}>
    {messages.map((message, index) => {
      const startsDay = message.day !== messages[index - 1]?.day;
      const speaker = message.role === 'user' ? 'You' : assistantName;
      return <div key={message.id} className="aui-dated-entry">
        {startsDay && <div className="aui-day-separator"><span /><span>{message.day}</span><span /></div>}
        <article className="aui-message-row" data-role={message.role} aria-label={`${speaker} at ${message.time}`}>
          <span className="aui-message-content">
            <span className="aui-message-speaker">{speaker}</span>
            <span className="aui-message-text">{message.text}</span>
            {message.interrupted && <span className="aui-message-partial">Partial caption</span>}
          </span>
          <time className="aui-message-time" dateTime={message.dateTime} title={`${message.day}, ${message.time}`}>{message.time}</time>
        </article>
      </div>;
    })}
  </div>;
}