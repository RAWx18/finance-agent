// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App, RouteError } from './App';
import './styles.css';

const router = createBrowserRouter([{ path: '*', element: <App />, errorElement: <RouteError /> }]);
createRoot(document.getElementById('root')!).render(<StrictMode><RouterProvider router={router} flushSync={callback => { flushSync(callback); }} /></StrictMode>);