// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { dismissAll } from '../src/Toast';

// Scrolling geometry is verified in the browser, not jsdom.
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });

// jsdom lacks native dialog methods; modal focus and inertness require real-browser tests.
Object.defineProperties(HTMLDialogElement.prototype, {
	showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } },
	close: { configurable: true, value(this: HTMLDialogElement) {
		this.removeAttribute('open');
		this.dispatchEvent(new Event('close'));
	} },
});

// WebGL and media preferences are exercised in Chromium; jsdom has neither implementation.
beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
	vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ matches: false, media,
		addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => { cleanup(); dismissAll(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });