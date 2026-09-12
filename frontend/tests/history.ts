// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { SavedConversation } from '../src/api';

/** Creates a saved rent-and-payday conversation fixture with four messages and relative expiry. */
export function savedConversation(slug = 'conversation-2026-09-12-101500'): SavedConversation {
  return {
    slug, title: 'Can I cover rent before payday?', startedAt: '2026-09-12T04:45:00Z', endedAt: '2026-09-12T04:47:00Z',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), messageCount: 4,
    messages: [
      { id: '1', role: 'assistant', text: 'Hi, I’m Isha. What’s on your mind?', createdAt: '2026-09-12T04:45:00Z', interrupted: false },
      { id: '2', role: 'user', text: 'Can I cover rent before payday?', createdAt: '2026-09-12T04:45:15Z', interrupted: false },
      { id: '3', role: 'assistant', text: 'Let’s check when rent is due and what you have available.', createdAt: '2026-09-12T04:45:30Z', interrupted: false },
      { id: '4', role: 'user', text: 'Rent is ₹8,000 on the 18th. My salary comes on the 20th.', createdAt: '2026-09-12T04:46:00Z', interrupted: false },
    ],
  };
}