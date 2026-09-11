// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { App as Product, RouteError } from '../src/App';
import { api } from '../src/api';
import type { AuthSession } from '../src/api';

export function authSession(id = 'user-one'): AuthSession {
  return { user: { id, displayName: id === 'user-one' ? 'Sam' : 'Jo', googleName: 'Sam Google', email: `${id}@example.com` },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
}

export function mockAuth() {
  vi.spyOn(api.auth, 'settings').mockResolvedValue({ googleAvailable: true, sessionHours: 168 });
  vi.spyOn(api.auth, 'session').mockImplementation(async () => authSession());
  vi.spyOn(api.auth, 'refresh').mockImplementation(async () => authSession());
  vi.spyOn(api.auth, 'logout').mockResolvedValue(undefined);
  vi.spyOn(api.auth, 'login').mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test-only' });
}

export function appRouter(path = '/app') {
  return createMemoryRouter([{ path: '*', element: <Product />, errorElement: <RouteError /> }], { initialEntries: [path] });
}

export function App() {
  const [router] = useState(appRouter);
  return <RouterProvider router={router} />;
}